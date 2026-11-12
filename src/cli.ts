/**
 * `bountymarket` command line for BountyMarket, a task marketplace for AI agents
 * and humans (Australia, AUD, online tasks). Human-readable output by default,
 * `--json` for scripts and agents. Reads BOUNTYMARKET_API_URL and
 * BOUNTYMARKET_API_KEY; never prints the key.
 *
 * Long text never has to go through shell quoting: `tasks post` takes
 * `--brief @file` (also `--deliverable`, `--criteria`; `@-` reads stdin) or
 * `--from-json <file>`, and `deliver` / `issue` / `respond` take
 * `--summary-file` / `--text-file <path>` (`-` for stdin). `tasks post --dry-run`
 * runs every check without creating anything.
 *
 * Files (platform 2026-10-11.1): `upload <path>` sends one file over REST
 * (POST /v1/uploads; `--assignment <id>` for a delivery file, `--task <id>` for a
 * brief file of a posted task, neither for a draft brief file) and prints its id;
 * `deliver ... --attach <id>` and `tasks post ... --attach <id>` (repeatable) attach
 * it; `files get <id> --out <path>` downloads one and `files delete <id>` removes one
 * while it is still editable. Binary never travels over MCP.
 *
 * Limits (trust stage 1, platform 2026-10-19.2): `me` prints the account's tier row and slots
 * (enforced when trust.mode is enforce), `limit-request` asks the founder for a higher limit
 * (POST /v1/me/limit-requests, the MCP tool request_limit; level 1 one task, 2 an account
 * line, 3 a long-term line), `limit-requests` lists the requests and the lines in force and
 * `limit-requests withdraw <id>` takes a pending one back. `tasks post --min-hunter-tier`
 * is the Setter's own entry condition for applicants. Trust stage 2 (platform 2026-10-30.1):
 * `me` prints the account's identity line (Stripe Identity, Setters from the gate tier, started
 * on the website only), `capabilities` the identity block; a level-3 request needs the
 * application form, filed on the website (the REST / tool call answers 422 without it); the
 * hints below cover cluster_on_hold, breaker_paused and the identity codes.
 *
 * Exit codes: 0 ok, 1 the platform refused or could not be reached, 2 usage.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createActions, type Actions } from './actions.ts';
import {
  ApiClientError, TRUST_TIERS, clientFromConfig, configFromEnv, formatAud,
  type Attachment, type CreateTaskInput, type EnvConfig, type Identity, type LimitOverride, type LimitRequest, type LimitRequestSummary, type LimitValues, type ListedTask,
  type MarketplaceEvent, type Me, type Money, type TrustSetterRowTable, type TrustTier, type UploadScope,
} from './api.ts';
import {
  ASSIGNMENT_ENDING_EVENT_TYPES, CONFIRM_URL_RULE, CONTENT_DIGEST_RULE, EVENT_TYPES, ISSUE_TYPES, MAX_DELIVERY_DAYS, MAX_DELIVERY_HOURS, MAX_EVENTS_LIMIT, MAX_SEARCH_LIMIT, MCP_MAX_BATCH,
  GUIDES, GUIDE_NAMES, MCP_MAX_BODY_BYTES, PUBLIC_TASK_STATUSES, REFUSED_EXTENSIONS, REVIEW_TARGET_HOURS, TASK_CATEGORIES, TASK_CATEGORY_CODES, UPLOAD_RULES, describeGuide, isRecord,
} from './tools.ts';
import { createGuideSource } from './mcp-server.ts';
import { BRAND_NAME, CLI_BIN, DEFAULT_API_URL, ENV_API_KEY, LIVE_API_URL, MCP_BIN } from './brand.ts';
import { VERSION } from './version.ts';

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Reads a text file named by `@file`, `--from-json`, `--summary-file` or `--text-file`; defaults to the file system. */
  readFile?: (path: string) => string;
  /** Reads all of standard input (`@-`, `--summary-file -`, `--text-file -`, `--from-json -`); defaults to fd 0. */
  stdin?: () => string;
  /** Reads the bytes of the file `upload <path>` sends; defaults to the file system. */
  readBinary?: (path: string) => Uint8Array;
  /** Writes the bytes `files get <id> --out <path>` received; defaults to the file system. */
  writeBinary?: (path: string, bytes: Uint8Array) => void;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// ---------------------------------------------------------------------------
// Argument parsing (no dependencies)
// ---------------------------------------------------------------------------

export type ParsedArgs = { positional: string[]; flags: Record<string, string[] | true> };

/** Options every command understands. */
const GLOBAL_FLAGS = new Set(['json', 'help', 'version']);
/** Per-command switches (declared `boolean` in a command's flags); the parser must know they take no value. */
const SWITCH_FLAGS = new Set(['auto-accept', 'auto-accept-no-agents', 'dry-run', 'eligible', 'cooling-bypass']);
const BOOLEAN_FLAGS = new Set([...GLOBAL_FLAGS, ...SWITCH_FLAGS]);

/**
 * `--name value`, `--name=value`, repeated flags collect (`--link a --link b`),
 * `--json`/`--help`/`--version` and the per-command switches are booleans, `--`
 * ends flag parsing.
 */
export function parseArgs(argv: string[], knownValueFlags?: ReadonlySet<string>): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    // -h / -v: the short forms of --help / --version (a value such as `--message -v` was consumed above and never lands here).
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v') { flags.version = true; continue; }
    if (!arg.startsWith('--') || arg.length === 2) { positional.push(arg); continue; }
    let name = arg.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (!name) throw new UsageError(`Malformed flag "${arg}"`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      // An option no command knows is reported as unknown, not as one missing its value.
      if (knownValueFlags && !knownValueFlags.has(name)) throw new UsageError(`Unknown option --${name}`);
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      value = argv[++i]!;
    }
    const existing = flags[name];
    flags[name] = Array.isArray(existing) ? [...existing, value] : [value];
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type FlagSpec = {
  help: string;
  required?: boolean;
  repeat?: boolean;
  integer?: boolean;
  boolean?: boolean;
  oneOf?: readonly string[];
  /** The value may be `@file` (or `@-` for stdin) and is then read from there. */
  at?: boolean;
  /** The value is a path (or `-` for stdin) whose contents are the text. */
  path?: boolean;
  /** Required unless `--from-json` supplies the field (checked by the command, not the parser). */
  fromJsonOrFlag?: boolean;
};

type Flags = Record<string, string | string[] | number | boolean | undefined>;

type CommandContext = { actions: Actions; config: EnvConfig; positional: string[]; flags: Flags; io: CliIo };

type Command = {
  path: string[];
  positional: string[];
  flags: Record<string, FlagSpec>;
  summary: string;
  needsKey: boolean;
  run(ctx: CommandContext): Promise<unknown>;
  print(result: unknown, io: CliIo): void;
};

const str = (flags: Flags, name: string) => flags[name] as string | undefined;
const num = (flags: Flags, name: string) => flags[name] as number | undefined;
const list = (flags: Flags, name: string) => (flags[name] as string[] | undefined) ?? [];
const on = (flags: Flags, name: string) => flags[name] === true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a file (or stdin for "-") through the io hooks; a read failure is a usage error naming the path. */
function readText(io: CliIo, path: string): string {
  try {
    if (path === '-') return io.stdin ? io.stdin() : readFileSync(0, 'utf8');
    return io.readFile ? io.readFile(path) : readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${path === '-' ? 'stdin' : path}: ${(error as Error).message}`);
  }
}

/** `@file` / `@-` values are read from the file / stdin (trailing whitespace trimmed); anything else is the text itself. */
function expandAt(io: CliIo, value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith('@')) return value;
  return readText(io, value.slice(1) || '-').trimEnd();
}

/**
 * The text of `--<name>` or the contents of `--<name>-file <path>` (`-` = stdin); exactly one of them.
 * The file's bytes are sent as given (2026-10-15.12: no trailing-newline strip), so a digest computed
 * over the file matches content_digest, which covers the summary exactly as sent.
 */
function textOrFile(io: CliIo, flags: Flags, name: string, required = true): string | undefined {
  const inline = str(flags, name);
  const file = str(flags, `${name}-file`);
  if (inline !== undefined && file !== undefined) throw new UsageError(`give either --${name} or --${name}-file, not both`);
  if (file !== undefined) return readText(io, file);
  if (inline === undefined && required) throw new UsageError(`--${name} or --${name}-file is required`);
  return inline;
}

/** Repeated `--<name> <uuid>` values (for example `--attach`), each checked to be a UUID and at most `max` of them. */
function uuidList(flags: Flags, name: string, max: number, what: string): string[] {
  const values = list(flags, name);
  for (const value of values) {
    if (!UUID_RE.test(value)) throw new UsageError(`--${name} must be ${what} (uuid), got "${value}"`);
  }
  if (values.length > max) throw new UsageError(`--${name} may be given at most ${max} times`);
  return values;
}

// ---------------------------------------------------------------------------
// Files (2026-10-11): what the `upload` command checks before sending anything
// ---------------------------------------------------------------------------

/** Lower-cased extension without the dot, or '' when the name has none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 || dot === filename.length - 1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Content types for the common extensions; anything else is sent as application/octet-stream, which the platform accepts for every allowed extension. */
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tgz: 'application/gzip',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

/** The declared Content-Type for a filename: the known type for its extension, else the generic one. */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extensionOf(filename)] ?? 'application/octet-stream';
}

/** "4 bytes", "12.3 KB", "1.5 MB": sizes for humans. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Reads the file to upload through the io hook; a read failure is a usage error naming the path. */
function readBinary(io: CliIo, path: string): Uint8Array {
  try {
    return io.readBinary ? io.readBinary(path) : new Uint8Array(readFileSync(path));
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

/** The platform's limits, checked locally so an upload that would be refused never leaves the machine (the server checks again). */
function checkUploadLocally(filename: string, bytes: Uint8Array): void {
  const extension = extensionOf(filename);
  if (!extension) throw new UsageError(`"${filename}" has no extension; the platform needs one (for example .pdf, .png, .zip) to decide the file type (file_type_not_allowed)`);
  if ((REFUSED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new UsageError(`.${extension} files are refused: executables, installers and runnable scripts cannot be attached (file_type_not_allowed). Archive the files instead (zip, 7z, tar.gz) if they are source material.`);
  }
  if (bytes.byteLength === 0) throw new UsageError(`"${filename}" is empty; nothing to upload`);
  if (bytes.byteLength > UPLOAD_RULES.max_file_bytes) {
    throw new UsageError(`"${filename}" is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(UPLOAD_RULES.max_file_bytes)} limit per file (file_too_large)`);
  }
}

/** `--assignment <id>` (delivery file), `--task <id>` (brief file of a posted task) or neither (draft brief file); never both. */
function uploadScope(flags: Flags): UploadScope {
  const assignmentId = str(flags, 'assignment');
  const taskId = str(flags, 'task');
  if (assignmentId !== undefined && taskId !== undefined) throw new UsageError('give either --assignment or --task, not both');
  if (assignmentId !== undefined) {
    if (!UUID_RE.test(assignmentId)) throw new UsageError('--assignment must be an assignment id (uuid)');
    return { type: 'delivery', assignmentId };
  }
  if (taskId !== undefined && !UUID_RE.test(taskId)) throw new UsageError('--task must be a task id (uuid)');
  return { type: 'task', taskId: taskId ?? null };
}

function attachmentLines(attachments: unknown, indent = '    '): string[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((a: Attachment) => `${indent}${a.id}  ${a.filename} (${formatBytes(a.size)}, ${a.content_type})`);
}

// ---------------------------------------------------------------------------
// Limits (trust stage 1, platform 2026-10-19.2): how the tier rows and the limit lines print
// ---------------------------------------------------------------------------

/** The row keys of a limit request or an approved line, in plain words ("per task A$150.00, slots 4, cooling lifted"). */
function limitValuesText(values: LimitValues | null | undefined): string {
  if (!values || typeof values !== 'object') return 'nothing';
  const parts: string[] = [];
  if (typeof values.per_task_cap_minor === 'number') parts.push(`per task ${formatAud(values.per_task_cap_minor)}`);
  if (typeof values.total_cap_minor === 'number') parts.push(`in flight ${formatAud(values.total_cap_minor)}`);
  if (typeof values.daily_cap_minor === 'number') parts.push(`per 24 h ${formatAud(values.daily_cap_minor)}`);
  if (values.slots !== undefined) parts.push(`slots ${values.slots === null ? 'unlimited' : values.slots}`);
  if (values.posts_per_day !== undefined) parts.push(`listings per 24 h ${values.posts_per_day === null ? 'unlimited' : values.posts_per_day}`);
  if (values.cooling_bypass === true) parts.push('cooling lifted');
  return parts.length ? parts.join(', ') : 'nothing';
}

/** One tier's Setter row (capabilities trust.setter_rows[tier], or a row's next_row) in one phrase. */
function setterRowText(row: TrustSetterRowTable | null | undefined): string {
  if (!row || typeof row !== 'object') return 'n/a';
  const parts = [
    `${row.slots === null ? 'unlimited' : row.slots} slot${row.slots === 1 ? '' : 's'}`,
    `${formatAud(row.total_cap_minor)} in flight`,
    `${formatAud(row.per_task_cap_minor)} per task`,
    `${formatAud(row.daily_cap_minor)} per 24 h`,
  ];
  if (row.posts_per_day !== undefined) parts.push(`${row.posts_per_day === null ? 'unlimited' : row.posts_per_day} listings per 24 h`);
  if (typeof row.cooling_days === 'number' && row.cooling_days > 0) parts.push(`cooling ${row.cooling_days} d`);
  return parts.join(', ');
}

/** The account's identity block (me.identity, platform 2026-10-30.1) in one line: status, what it means for the Setter row, how to start. */
function identityLine(i: Identity): string {
  const status = i.status === 'verified' ? `verified${i.verified_at ? ` (Australian document, ${i.verified_at})` : ''}`
    : i.status === 'pending' ? 'pending (a session was started; the outcome arrives by webhook within minutes)'
      : i.status === 'failed' ? `failed (${i.failed_reason ?? 'see the website'})`
        : 'not started';
  if (!i.enabled) return `${status}; verification is off on this deployment (no limit depends on it)`;
  const gate = i.gate_applies
    ? `; your Setter tier is ${i.required_for_tier ?? '?'} or above, so the ${i.row_tier_while_unverified ?? 'lower'} row applies until verified (fee and badge unchanged)`
    : i.required_now ? `; required from the ${i.required_for_tier ?? '?'} tier` : `; required for Setters from the ${i.required_for_tier ?? '?'} tier and for a level-3 line`;
  const start = i.status === 'verified' ? '' : i.can_start_now
    ? '; the account holder starts it on the website, signed in (Account > Identity, Australian driving licence or passport; never an agent key)'
    : `; no new session now (${i.sessions_30d} of ${i.max_sessions_30d} per 30 days used${typeof i.site_sessions_30d === 'number' && typeof i.site_monthly_cap === 'number' ? `, site ${i.site_sessions_30d} of ${i.site_monthly_cap}` : ''})`;
  return `${status}${gate}${start}`;
}

/** A limit request in one line for the limit-request / limit-requests output. */
function limitRequestLine(r: LimitRequest): string {
  const filed = r.filed_by === 'ai_agent' ? 'by an agent key' : 'by the account holder';
  const task = r.task_id ? `, task ${r.task_id}` : '';
  const decided = r.decided_at ? `; decided ${r.decided_at}${r.decision_note ? ` ("${r.decision_note}")` : ''}` : '';
  const valid = r.valid_until ? `; valid until ${r.valid_until}` : '';
  const approved = r.approved_values ? `; approved: ${limitValuesText(r.approved_values)}` : '';
  return `${r.id}  level ${r.level} ${r.side}${task}  ${r.status}  asked: ${limitValuesText(r.requested)}  filed ${r.created_at} ${filed}${decided}${approved}${valid}`;
}

function overrideLine(o: LimitOverride): string {
  const scope = o.scope === 'task' ? (o.task_id ? `task ${o.task_id}` : 'task (binds to the next listing above the per-task cap)') : 'account';
  return `${o.id}  ${o.side} ${scope}: ${limitValuesText(o.values)}; until ${o.valid_until}${o.active ? '' : o.revoked_at ? ` (revoked: ${o.revoked_reason ?? 'founder'})` : ' (not active)'}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function table(rows: string[][], io: CliIo): void {
  if (rows.length === 0) return;
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  for (const row of rows) {
    io.stdout(row.map((cell, col) => (col === row.length - 1 ? cell : pad(cell, widths[col]!))).join('  ').trimEnd() + '\n');
  }
}

function taskRow(task: ListedTask): string[] {
  const mine = task.my_assignment ? `assignment ${task.my_assignment.status}` : task.my_application ? `applied (${task.my_application.status})` : '';
  return [
    task.id,
    formatAud(task.bounty_minor),
    `${task.delivery_hours}h`,
    task.category_code,
    'status' in task ? task.status : '-',
    task.setter_is_ai_agent ? 'agent' : 'human',
    task.my_application === undefined ? task.title : `${task.title}${mine ? `  [${mine}]` : ''}`,
  ];
}

function printTasks(tasks: ListedTask[], io: CliIo): void {
  if (tasks.length === 0) { io.stdout('No tasks.\n'); return; }
  table([['ID', 'BOUNTY', 'DELIVER', 'CATEGORY', 'STATUS', 'SETTER', 'TITLE'], ...tasks.map(taskRow)], io);
}

/** One category for --help and the capabilities printout: code, English and Chinese labels, the one-line description. */
function categoryLine(code: string, label?: string, labelZh?: string, description?: string): string {
  return `    ${pad(code, 22)}${label ?? ''}${labelZh ? ` (${labelZh})` : ''}${description ? `: ${description}` : ''}`.trimEnd();
}

/** The eight category codes with their labels and descriptions, one per line, for --help. */
const CATEGORY_LINES = TASK_CATEGORIES.map((c) => categoryLine(c.code, c.label, c.label_zh, c.description));
const CATEGORY_HELP = `one of ${TASK_CATEGORY_CODES.join(', ')} (labels under "Task categories" below)`;

/** The hosted documents print money in cents; humans read A$. The one payment shape: the fee and net are the Hunter's side. */
function paymentLine(p: Record<string, any>): string {
  const parts = [`status ${p.status}`];
  if (typeof p.authorised_minor === 'number') parts.push(`authorised (held) ${formatAud(p.authorised_minor)}`);
  if (typeof p.captured_minor === 'number') parts.push(`captured ${formatAud(p.captured_minor)}`);
  if (typeof p.refunded_minor === 'number' && p.refunded_minor > 0) parts.push(`refunded ${formatAud(p.refunded_minor)}`);
  if (typeof p.hunter_fee_minor === 'number' && typeof p.hunter_net_minor === 'number') {
    parts.push(`Hunter's fee ${formatAud(p.hunter_fee_minor)}, Hunter's net ${formatAud(p.hunter_net_minor)} (the Setter pays no fee; the net is before Stripe's own fee and lands in the Hunter's Stripe balance)`);
  }
  return parts.join(', ');
}

/** `approved_by` in words: who approved the completion (null while the review is not approved). */
function approvedByText(by: unknown): string | null {
  if (!isRecord(by)) return null;
  return by.kind === 'auto' ? 'the platform once the review deadline passed in silence' : by.kind === 'ai_agent' ? 'the Setter\'s agent' : 'the Setter';
}

function reviewLine(r: Record<string, any>): string {
  const who = approvedByText(r.approved_by);
  return `Review: ${r.status}${who ? ` (approved by ${who})` : ''}${r.review_deadline_at ? `, deadline ${r.review_deadline_at}` : ''}`;
}

const CONFIRM_URL_LABEL = 'confirm_url (the account holder\'s click there, signed in on the website; "Next step" says what)';

/**
 * Whether the capabilities document says the first-listing review is off: a count of exactly 0
 * (the default since platform 2026-11-10). Missing or unreadable reads as on,
 * as every older deployment had it (1 from 2026-10-08, 3 before).
 */
function firstListingReviewOff(count: unknown): boolean {
  return count !== undefined && count !== null && Number(count) === 0;
}

/** "first listing is" / "first N listings are": how many of a new Setter's listings the founder reviews while the review is on (0 at launch: off). */
function listingsPhrase(count: unknown): string {
  const n = typeof count === 'number' ? count : Number(count);
  if (!Number.isFinite(n)) return 'first listings are';
  return n === 1 ? 'first listing is' : `first ${n} listings are`;
}

/** The screening hold (2026-10-08) in one line: the listing waits for a founder check because its wording suggests in-person work. */
function reviewReasonsLine(task: Record<string, any>): string | null {
  if (!Array.isArray(task.review_reasons) || task.review_reasons.length === 0) return null;
  return `Held for a founder check (${BRAND_NAME} is online-only at launch; review_reasons: ${task.review_reasons.join(', ')}). `
    + 'If the work is online, no action is needed; the founder will release it.';
}

/** `tasks post` input from --from-json (API field names) overlaid by the flags; every field checked here, before any request. */
function postInput(io: CliIo, flags: Flags): CreateTaskInput {
  const fromJson = str(flags, 'from-json');
  let base: Record<string, unknown> = {};
  if (fromJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readText(io, fromJson));
    } catch (error) {
      throw new UsageError(`--from-json: ${fromJson === '-' ? 'stdin' : fromJson} is not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(parsed)) throw new UsageError('--from-json: the file must hold one JSON object with the task fields (title, brief, deliverable, acceptance_criteria, category_code, bounty_minor, delivery_hours, auto_accept?, min_hunter_tier?, attachment_ids?)');
    base = parsed;
  }
  const text = (flag: string, field: string, at: boolean) => {
    const given = at ? expandAt(io, str(flags, flag)) : str(flags, flag);
    const value = given ?? base[field];
    if (value === undefined) throw new UsageError(`--${flag} is required (or "${field}" in --from-json)`);
    if (typeof value !== 'string') throw new UsageError(`"${field}" in --from-json must be a string`);
    return value;
  };
  const integer = (flag: string, field: string) => {
    const value = num(flags, flag) ?? base[field];
    if (value === undefined) throw new UsageError(`--${flag} is required (or "${field}" in --from-json)`);
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new UsageError(`"${field}" in --from-json must be an integer`);
    return value;
  };
  const category = () => {
    const value = str(flags, 'category') ?? base.category_code;
    if (value === undefined) throw new UsageError('--category is required (or "category_code" in --from-json)');
    if (typeof value !== 'string' || !(TASK_CATEGORY_CODES as readonly string[]).includes(value)) {
      throw new UsageError(`"category_code" must be one of ${TASK_CATEGORY_CODES.join(', ')}`);
    }
    return value;
  };

  // In flag order, so the first missing field is the one named.
  const input: CreateTaskInput = {
    title: text('title', 'title', false),
    brief: text('brief', 'brief', true),
    deliverable: text('deliverable', 'deliverable', true),
    acceptance_criteria: text('criteria', 'acceptance_criteria', true),
    category_code: category(),
    bounty_minor: integer('bounty', 'bounty_minor'),
    delivery_hours: integer('hours', 'delivery_hours'),
  };

  const autoAcceptFlag = on(flags, 'auto-accept');
  const minSettled = num(flags, 'auto-accept-min-settled');
  const noAgents = on(flags, 'auto-accept-no-agents');
  if (!autoAcceptFlag && (minSettled !== undefined || noAgents)) {
    throw new UsageError('--auto-accept-min-settled and --auto-accept-no-agents need --auto-accept');
  }
  let autoAccept: CreateTaskInput['auto_accept'];
  if (autoAcceptFlag) {
    autoAccept = { enabled: true, ...(noAgents ? { allow_agents: false } : {}), ...(minSettled === undefined ? {} : { min_settled: minSettled }) };
  } else if (base.auto_accept !== undefined) {
    if (!isRecord(base.auto_accept) || typeof base.auto_accept.enabled !== 'boolean') {
      throw new UsageError('"auto_accept" in --from-json must be { enabled: boolean, allow_agents?: boolean, min_settled?: integer }');
    }
    autoAccept = base.auto_accept as CreateTaskInput['auto_accept'];
  }

  // min_hunter_tier (platform 2026-10-19.2): the Setter's own entry tier for applicants; --min-hunter-tier or "min_hunter_tier" in --from-json (null = anyone).
  const minTierGiven = str(flags, 'min-hunter-tier') ?? base.min_hunter_tier;
  let minHunterTier: TrustTier | undefined;
  if (minTierGiven !== undefined && minTierGiven !== null) {
    if (typeof minTierGiven !== 'string' || !(TRUST_TIERS as readonly string[]).includes(minTierGiven)) {
      throw new UsageError(`"min_hunter_tier" must be one of ${TRUST_TIERS.join(', ')} (or left out: anyone may apply)`);
    }
    minHunterTier = minTierGiven as TrustTier;
  }

  // Brief files (2026-10-11): --attach <file id> (repeatable) or "attachment_ids" in --from-json; ids from `bountymarket upload <path>` (no scope).
  let attachmentIds = uuidList(flags, 'attach', UPLOAD_RULES.max_files_per_task, `a file id from "${CLI_BIN} upload <path>"`);
  if (attachmentIds.length === 0 && base.attachment_ids !== undefined) {
    const given = base.attachment_ids;
    if (!Array.isArray(given) || !given.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
      throw new UsageError(`"attachment_ids" in --from-json must be an array of file ids (uuid) from "${CLI_BIN} upload <path>"`);
    }
    if (given.length > UPLOAD_RULES.max_files_per_task) throw new UsageError(`"attachment_ids" in --from-json may hold at most ${UPLOAD_RULES.max_files_per_task} ids`);
    attachmentIds = given as string[];
  }

  return {
    ...input,
    ...(autoAccept ? { auto_accept: autoAccept } : {}),
    ...(minHunterTier ? { min_hunter_tier: minHunterTier } : {}),
    ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
  };
}

const COMMANDS: Command[] = [
  {
    path: ['capabilities'], positional: [], flags: {}, needsKey: false,
    summary: 'Describe the marketplace: money rules, the limits (static caps, or the Setter tier rows and Hunter slots once the trust ladder is enforced), fee tiers and any fee holiday, the limit-request system, categories, current activity, whether live charges are on, the review target and recent median, links.',
    run: ({ actions }) => actions.capabilities(),
    print(result, io) {
      const c = result as Record<string, any>;
      io.stdout(`${c.name ?? '${BRAND_NAME}'} ${c.version ?? ''} (${c.status ?? 'unknown'}) — ${c.description ?? ''}\n`);
      if (c.mode !== undefined || c.live_charges !== undefined) {
        io.stdout(`Mode: ${c.mode ?? 'unknown'}; live charges ${c.live_charges ? 'on' : 'off'}\n`);
      }
      if (c.timezone || c.server_time) {
        io.stdout(`Time: ${c.server_time ?? 'n/a'}${c.timezone ? ` (every timestamp is ${c.timezone}, ISO-8601 with Z)` : ''}\n`);
      }
      if (c.eligibility?.setters || c.eligibility?.hunters) {
        // Since platform 2026-11-12.2 the Setter sentence names the Setters itself ("Setters may be anywhere in the world except ..."),
        // so it is printed without a second "Setters:" label; an older deployment's sentence ("Anyone, any country, ...") keeps the label.
        const setters = String(c.eligibility.setters ?? '?');
        io.stdout(`Who can use it: ${/^Setters\b/u.test(setters) ? setters : `Setters: ${setters}`} Hunters: ${c.eligibility.hunters ?? '?'}\n`);
      }
      // Platform 2026-11-12.2: the card issuing countries a Setter cannot pay from for now (the 27 EU member states and GB; VN too since
      // platform 2026-11-12.3). An older deployment omits the list, and then no line is printed.
      const refusedCardCountries: string[] = Array.isArray(c.eligibility?.setter_card_countries_refused)
        ? c.eligibility.setter_card_countries_refused.filter((code: unknown): code is string => typeof code === 'string') : [];
      if (refusedCardCountries.length) {
        io.stdout(`Setter cards issued in these countries are refused for now: ${refusedCardCountries.join(', ')}\n`);
      }
      const money = c.money ?? {};
      // Trust stage 1 (platform 2026-10-19.2): in enforce mode the static caps are retired and the Setter's tier row is the limit.
      const trust = isRecord(c.trust) ? c.trust : {};
      const tierRows = money.limits_enforced_by === 'tier_rows' && isRecord(trust.setter_rows) ? trust.setter_rows as Record<string, TrustSetterRowTable> : null;
      if (tierRows) {
        io.stdout(`Bounty: at least ${formatAud(money.minimum_bounty_minor ?? 1000)} per task`
          + (money.new_setter_task_cap_minor !== undefined && money.new_setter_review_count !== undefined
            ? (firstListingReviewOff(money.new_setter_review_count)
              ? '; no first-listing review (a new Setter\'s first listing opens at once)'
              : `; a new Setter's ${listingsPhrase(money.new_setter_review_count)} reviewed first`)
            : '')
          + '; the other limits are the Setter\'s tier row (trust.setter_rows), enforced:\n');
        for (const [tier, row] of ladderOrder(tierRows, trust.tiers)) io.stdout(`    ${pad(tier, 9)} ${setterRowText(row)}\n`);
        if (isRecord(trust.hunter_slots)) {
          io.stdout(`Hunter slots (concurrent assignments by tier; a delivered one stops counting ${trust.delivered_grace_hours ?? 12} h after delivery): `
            + `${ladderOrder(trust.hunter_slots, trust.tiers).map(([tier, slots]) => `${tier} ${slots}`).join(', ')}\n`);
        }
      } else if (money.minimum_bounty_minor !== undefined) {
        io.stdout(`Bounty: ${formatAud(money.minimum_bounty_minor)} to ${formatAud(money.max_task_bounty_minor)} per task`
          // The new-Setter cap shares the review switch: at new_setter_review_count 0 nobody is new and it does not apply (2026-11-10).
          + (money.new_setter_task_cap_minor !== undefined && !firstListingReviewOff(money.new_setter_review_count)
            ? ` (new Setters: ${formatAud(money.new_setter_task_cap_minor)}`
              + (money.new_setter_review_count !== undefined ? ` until their ${listingsPhrase(money.new_setter_review_count)} approved` : '') + ')'
            : '')
          + (money.setter_daily_cap_minor !== undefined ? `; ${formatAud(money.setter_daily_cap_minor)} per Setter per day` : '') + '\n');
      }
      if (Array.isArray(money.fee_tiers)) {
        // Six tiers by lifetime seasoned net earnings (platform 2026-10-19.2) print the threshold; the legacy count ladder prints the percentages only.
        const byMoney = money.fee_tiers.some((t: any) => typeof t.minimum_earned_minor === 'number');
        io.stdout(`Fee (paid by the Hunter at settlement${byMoney ? ', by lifetime seasoned net earnings' : ''}): `
          + money.fee_tiers.map((t: any) => `${t.code} ${t.fee_percent}%${typeof t.minimum_earned_minor === 'number' && t.minimum_earned_minor > 0 ? ` from ${formatAud(t.minimum_earned_minor)}` : ''}`).join(', ')
          + (money.fee_schedule === 'legacy_fee_tiers' && Array.isArray(money.legacy_fee_tiers)
            ? `. Charged while trust.mode is shadow: the legacy count tiers ${money.legacy_fee_tiers.map((t: any) => `${t.code} ${t.fee_percent}%`).join(', ')}`
            : '') + '\n');
      }
      if (typeof money.fee_holiday_until === 'string') {
        io.stdout(`Fee holiday: 0% platform fee for every Hunter, human or AI agent alike, on tasks accepted before ${money.fee_holiday_until}; `
          + 'after that the tiers apply (money.fee_holiday_until)\n');
      }
      if (tierRows) {
        io.stdout('Auto-accept: a task of at most the Setter\'s per-task cap (their tier row; a task raised by an approved limit request up to the raised cap) '
          + 'may accept the first qualifying applicant automatically; the account holder confirms the opt-in on the website\n');
      } else if (money.auto_accept_max_bounty_minor !== undefined) {
        io.stdout(`Auto-accept: a task of at most ${formatAud(money.auto_accept_max_bounty_minor)} may accept the first qualifying applicant automatically; `
          + 'the account holder confirms the opt-in on the website\n');
      }
      const lr = isRecord(c.limit_requests) ? c.limit_requests : null;
      if (lr && isRecord(lr.pacing)) {
        const ceilings = isRecord(lr.ceilings) ? lr.ceilings : {};
        io.stdout(`Limit requests: anyone may ask the founder for a higher limit (a human session or the account's agent key; "${CLI_BIN} limit-request"): `
          + 'level 1 one task, 2 an account line (24 hours by default), 3 a long-term line; '
          + `one open request at a time, ${lr.pacing.max_per_30d ?? 3} per 30 days, ${lr.pacing.declines_for_cooldown ?? 2} declines in a row → a ${lr.pacing.decline_cooldown_days ?? 30}-day wait, `
          + `unanswered for ${lr.pacing.pending_expiry_days ?? 7} days → expired`
          + (typeof ceilings.in_flight_minor === 'number' && typeof ceilings.daily_minor === 'number'
            ? `; ceilings ${formatAud(ceilings.in_flight_minor)} in flight, ${formatAud(ceilings.daily_minor)} per day` : '') + '\n');
      }
      // Identity (platform 2026-10-30.1, trust stage 2): Stripe Identity for Setters from the gate tier; off when required_from_tier is null.
      const identity = isRecord(c.identity) ? c.identity : null;
      if (identity && typeof identity.enabled === 'boolean') {
        const pacing = isRecord(identity.pacing) ? identity.pacing : {};
        io.stdout(identity.enabled
          ? `Identity verification: on for Setters from the ${String(identity.required_from_tier)} tier (Stripe Identity, Australian driving licence or passport; until verified such a Setter reads the row of the tier below; `
            + 'a level-3 line needs it); the account holder starts it on the website, signed in (Account > Identity; never an agent key); '
            + `${pacing.per_account_30d ?? 2} sessions per account and ${pacing.site_30d ?? '?'} site-wide per 30 days; the platform stores the outcome only\n`
          : 'Identity verification: off on this deployment (no limit depends on it; capabilities.identity.required_from_tier is null)\n');
      }
      if (money.live_charges_paused) io.stdout('Live charges are currently paused.\n');
      if (c.agent_actions && typeof c.agent_actions === 'object') {
        io.stdout(`Agent actions (sandbox and live alike): ${Object.entries(c.agent_actions).map(([action, rule]) => `${action} ${rule}`).join('; ')}\n`);
      }
      const tasks = c.tasks ?? {};
      if (Array.isArray(tasks.categories)) {
        io.stdout('Categories:\n');
        for (const x of tasks.categories) {
          // The platform serves { code, label, label_zh, description }; an older build served codes only (labels from the local table then).
          const code: string = typeof x === 'string' ? x : x.code;
          const known = TASK_CATEGORIES.find((k) => k.code === code);
          const field = (name: 'label' | 'label_zh' | 'description'): string | undefined =>
            (typeof x !== 'string' && typeof x[name] === 'string' ? x[name] : known?.[name]);
          io.stdout(categoryLine(code, field('label'), field('label_zh'), field('description')) + '\n');
        }
      }
      if (tasks.delivery_hours) {
        const max = Number(tasks.delivery_hours.max);
        const days = Number.isFinite(max) && max >= 48 && max % 24 === 0 ? ` (at most ${max / 24} days)` : '';
        // The Setter review window is the operator's live setting since platform 2026-11-12.1 (24 hours by default); a delivery
        // keeps the deadline it got at submission, so its review.review_deadline_at is the authority.
        const review = typeof tasks.review_window_hours === 'number'
          ? `; review window ${tasks.review_window_hours} hours (set by the operator; each delivery's review.review_deadline_at is authoritative)` : '';
        io.stdout(`Delivery: ${tasks.delivery_hours.min}-${tasks.delivery_hours.max} hours${days}; the clock starts at acceptance, not at posting`
          + `${review}\n`);
      }
      // A median is null below the platform's sample floor: 3 for first applications and listing approvals, 5 for acceptances.
      const samples = isRecord(c.activity?.median_samples_last_30_days) ? c.activity.median_samples_last_30_days as Record<string, unknown> : {};
      const hours = (median: unknown, key: 'first_application' | 'acceptance' | 'listing_approval') => {
        if (median !== null && median !== undefined) return `${median} h`;
        const floor = key === 'acceptance' ? ACCEPTANCE_MEDIAN_MIN_SAMPLES : ACTIVITY_MEDIAN_MIN_SAMPLES;
        return `n/a (fewer than ${floor} samples${typeof samples[key] === 'number' ? `; ${samples[key]} so far` : ''})`;
      };
      const review = c.review ?? {};
      if (review.target_hours !== undefined) {
        const median = 'median_hours_to_approval_last_30_days' in review ? `; recent median ${hours(review.median_hours_to_approval_last_30_days, 'listing_approval')} from posting to approval` : '';
        const reviewCount = review.new_setter_first_listings ?? money.new_setter_review_count;
        if (firstListingReviewOff(reviewCount)) {
          io.stdout('Review: no first-listing review (new_setter_first_listings 0): a new Setter\'s first listing opens at once; '
            + `a listing whose wording suggests in-person work is held for an online-only check (review_reasons), target ${review.target_hours} hours `
            + `(a target, not a guarantee)${median}\n`);
        } else {
          io.stdout(`Review: a new Setter's ${listingsPhrase(reviewCount)} reviewed by the founder, `
            + `target ${review.target_hours} hours (a target, not a guarantee)${median}`
            + '; a listing whose wording suggests in-person work is held the same way for an online-only check (review_reasons)\n');
        }
      }
      const scale = c.caps_autoscale;
      // In enforce mode the static caps, their ceilings and their auto-scale are retired (money.retired_now): one line, no ceilings.
      const capsRetired = money.retired_now === true || trust.enforced === true || money.limits_enforced_by === 'tier_rows';
      if (isRecord(scale) && scale.target !== undefined && capsRetired) {
        io.stdout('Caps auto-scale: retired while trust.mode is enforce (the Setter tier rows apply, trust.setter_rows).\n');
      } else if (isRecord(scale) && scale.target !== undefined) {
        const ceilings = isRecord(scale.ceilings) ? scale.ceilings as Record<string, number> : {};
        const ceilingText = [
          ['max_task_bounty_minor', 'per task'], ['new_setter_task_cap_minor', 'new Setter per task'],
          ['setter_daily_cap_minor', 'per Setter per day'], ['site_daily_cap_minor', 'site per day'],
        ].filter(([key]) => typeof ceilings[key!] === 'number').map(([key, label]) => `${label} ${formatAud(ceilings[key!]!)}`).join(', ');
        io.stdout(`Caps auto-scale: ${scale.enabled === false ? 'off' : 'on'}; ${scale.streak ?? 0} of ${scale.target} consecutive dispute-free settlements `
          + `towards the next doubling (level ${scale.level ?? 0}${scale.last_changed_at ? `, last changed ${scale.last_changed_at}` : ', never changed yet'})`
          + (ceilingText ? `; ceilings: ${ceilingText}` : '')
          + '. Any raised issue resets the streak; caps never decrease automatically; the auto-accept cap never scales.\n');
      }
      const activity = c.activity ?? {};
      if (activity.open_tasks !== undefined) {
        io.stdout(`Activity: ${activity.open_tasks} open tasks; last 30 days: ${activity.settled_last_30_days} settled, `
          + `${activity.active_hunters_last_30_days} active Hunters, median `
          + `${hours(activity.median_hours_to_first_application_last_30_days, 'first_application')} to first application, `
          + `median ${hours(activity.median_hours_to_acceptance_last_30_days, 'acceptance')} from application to acceptance`
          + (activity.as_of ? ` (as of ${activity.as_of})` : '') + '\n');
      }
      if (Array.isArray(c.events?.types) && c.events.types.length) {
        io.stdout(`Event types: ${c.events.types.map((x: any) => (typeof x === 'string' ? x : x.type)).join(', ')}\n`);
      }
      if (Array.isArray(c.prohibited_task_categories) && c.prohibited_task_categories.length) {
        io.stdout(`Prohibited: ${c.prohibited_task_categories.map((x: any) => (typeof x === 'string' ? x : x.code)).join(', ')}\n`);
      }
      if (typeof c.confirm_url === 'string') io.stdout(`confirm_url rule: ${c.confirm_url}\n`);
      const links = c.links ?? {};
      if (links.website) io.stdout(`Website: ${links.website} (task pages are ${links.website}/task/<task_id>)\n`);
      if (links.api || links.mcp) io.stdout(`API: ${links.api ?? 'n/a'}; MCP: ${links.mcp ?? 'n/a'}\n`);
      if (typeof c.links_note === 'string') io.stdout(`Links note: ${c.links_note}\n`);
    },
  },
  {
    path: ['rules'], positional: [], needsKey: false,
    flags: {
      guide: {
        help: `print one guide's text instead (${GUIDE_NAMES.join(', ')}), as get_rules { guide } returns it over MCP; the money guide follows this deployment's fee schedule`,
        oneOf: GUIDE_NAMES,
      },
    },
    summary: 'The marketplace policy document (plain-language summary, numeric facts, digest) and the guide index; --guide <name> prints one guide.',
    // The same documents as the get_rules tool: { guide } for one guide, else the policy document with agent_guides.
    run: async ({ actions, flags }) => {
      const name = str(flags, 'guide');
      if (name !== undefined) return { guide: (await createGuideSource(() => actions.capabilities())(name))! };
      return { ...(await actions.rules()), agent_guides: GUIDES.map(describeGuide) };
    },
    print(result, io) {
      const r = result as Record<string, any>;
      if (isRecord(r.guide)) {
        io.stdout(String(r.guide.text ?? ''));
        return;
      }
      io.stdout(`${r.policy_id ?? 'policy'} ${r.policy_version ?? ''} (${r.status ?? ''}) digest ${r.digest ?? 'n/a'}\n`);
      for (const line of r.plain_language_summary ?? []) io.stdout(`- ${line}\n`);
      if (r.public_url) io.stdout(`Full text: ${r.public_url}\n`);
      if (Array.isArray(r.agent_guides) && r.agent_guides.length) {
        io.stdout(`Guides (${CLI_BIN} rules --guide <name>): ${r.agent_guides.map((g: any) => g.name).join(', ')}\n`);
      }
    },
  },
  {
    path: ['tasks', 'list'], positional: [], needsKey: false,
    flags: {
      status: { help: `one of ${PUBLIC_TASK_STATUSES.join(', ')} (default open)`, oneOf: PUBLIC_TASK_STATUSES },
      category: { help: CATEGORY_HELP, oneOf: TASK_CATEGORY_CODES },
      limit: { help: `1-${MAX_SEARCH_LIMIT} (default and maximum ${MAX_SEARCH_LIMIT}; the API caps it)`, integer: true },
      fields: { help: 'full (default) or summary: summary rows carry id, title, bounty, delivery_hours, category, auto_accept, published_at, website_url and setter_is_ai_agent only, a fraction of the bytes; "tasks get" for the ones you open', oneOf: ['full', 'summary'] },
      'allow-agents': { help: 'true: only tasks whose auto-accept admits AI agents; false: only those that do not', oneOf: ['true', 'false'] },
      'auto-accept-status': { help: 'active: the first qualifying applicant is accepted at once; requested: opted in, awaiting the account holder\'s click; off: manual accept ("--auto-accept" alone is the "tasks post" switch)', oneOf: ['active', 'requested', 'off'] },
      'min-bounty': { help: 'lowest bounty in cents to include (inclusive)', integer: true },
      'max-bounty': { help: 'highest bounty in cents to include (inclusive)', integer: true },
      sort: { help: 'newest (default), bounty_desc or deadline_soonest (shortest delivery_hours first)', oneOf: ['newest', 'bounty_desc', 'deadline_soonest'] },
      eligible: { help: 'shortcut for --allow-agents true --auto-accept-status active --fields summary: the tasks an agent can be accepted on at once', boolean: true },
    },
    summary: 'List public tasks, newest first (each with website_url, the task page). With a key every row says my_application / my_assignment ({ id, status } or null).',
    run: ({ actions, flags }) => {
      const eligible = on(flags, 'eligible');
      const min = num(flags, 'min-bounty');
      const max = num(flags, 'max-bounty');
      if (min !== undefined && max !== undefined && min > max) throw new UsageError('--max-bounty must be at least --min-bounty');
      const allowAgents = str(flags, 'allow-agents');
      return actions.searchTasks({
        status: str(flags, 'status'), category: str(flags, 'category'), limit: num(flags, 'limit'),
        fields: eligible ? 'summary' : str(flags, 'fields') as 'full' | 'summary' | undefined,
        allow_agents: eligible ? true : allowAgents === undefined ? undefined : allowAgents === 'true',
        auto_accept: eligible ? 'active' : str(flags, 'auto-accept-status') as 'active' | 'requested' | 'off' | undefined,
        min_bounty: min, max_bounty: max,
        sort: str(flags, 'sort') as 'newest' | 'bounty_desc' | 'deadline_soonest' | undefined,
      });
    },
    print(result, io) { printTasks((result as { tasks: ListedTask[] }).tasks, io); },
  },
  {
    path: ['tasks', 'get'], positional: ['task_id'], flags: {}, needsKey: false,
    summary: 'Show one task with its website_url; with a key, your participant view (applications or your application, assignment, deliveries, review, payment, next step) and confirm_url only when the account holder has a click to make there.',
    run: ({ actions, positional }) => actions.getTask(positional[0]!),
    print(result, io) {
      const r = result as Record<string, any>;
      const t = r.task;
      io.stdout(`${t.title}\n`);
      io.stdout(`id ${t.id}  status ${t.status}  bounty ${formatAud(t.bounty_minor)}  deliver within ${t.delivery_hours}h  category ${t.category_code}\n`);
      io.stdout(`setter ${t.setter_display_name}${t.setter_is_ai_agent ? ` (agent${t.setter_agent_display_name ? `: ${t.setter_agent_display_name}` : ''})` : ''}\n`);
      if (t.auto_accept?.enabled) {
        io.stdout(`auto-accept ${t.auto_accept.active ? 'active' : 'requested, awaiting the account holder\'s confirmation'}`
          + ` (agents ${t.auto_accept.allow_agents === false ? 'not allowed' : 'allowed'}, min settled tasks ${t.auto_accept.min_settled ?? 0})\n`);
      }
      if (typeof t.min_hunter_tier === 'string') io.stdout(`Hunters of tier ${t.min_hunter_tier} or above only (the Setter's own condition, min_hunter_tier; others are refused with 422 min_tier_not_met)\n`);
      if (t.website_url) io.stdout(`website_url (the task page, for linking): ${t.website_url}\n`);
      const held = reviewReasonsLine(t);
      if (held) io.stdout(`${held}\n`);
      io.stdout(`\nBrief: ${t.brief}\n\nDeliverable: ${t.deliverable}\n\nAcceptance criteria: ${t.acceptance_criteria}\n`);
      const briefFiles = attachmentLines(t.attachments);
      if (briefFiles.length) {
        io.stdout(`\nBrief files (${briefFiles.length}; participants download with "${CLI_BIN} files get <file_id> --out <path>"):\n${briefFiles.join('\n')}\n`);
      }
      const p = r.participant;
      if (p === null) {
        io.stdout('\nYour key takes no part in this task (not its Setter, an applicant or its Hunter): the public listing only.\n');
        return;
      }
      if (p) {
        io.stdout(`\nYour role: ${p.role}\n`);
        if (Array.isArray(p.applications)) {
          io.stdout(`Applications: ${p.applications.length}\n`);
          for (const a of p.applications) {
            io.stdout(`    ${a.id}  ${a.status}  ${a.hunter_is_ai_agent ? 'agent' : 'human'}`
              + (a.auto_accept_skipped_reason ? `  not auto-accepted: ${a.auto_accept_skipped_reason}` : '') + '\n');
          }
        }
        if (p.my_application) {
          io.stdout(`Your application: ${p.my_application.id} (${p.my_application.status}`
            + (p.my_application.auto_accept_skipped_reason ? `; not auto-accepted: ${p.my_application.auto_accept_skipped_reason}` : '') + ')\n');
        }
        io.stdout(p.assignment
          ? `Assignment: ${p.assignment.id} (${p.assignment.status}), deadline ${p.assignment.deadline_at}, net ${formatAud(p.assignment.net_minor)}\n`
          : 'Assignment: none yet\n');
        io.stdout(`Deliveries: ${Array.isArray(p.deliveries) ? p.deliveries.length : 0}\n`);
        for (const d of Array.isArray(p.deliveries) ? p.deliveries : []) {
          const files = attachmentLines(d.attachments, '        ');
          if (files.length) io.stdout(`    delivery ${d.id} (attempt ${d.attempt}) files (${files.length}; "${CLI_BIN} files get <file_id> --out <path>"):\n${files.join('\n')}\n`);
        }
        io.stdout(p.review ? `${reviewLine(p.review)}\n` : 'Review: none\n');
        if (p.payment) io.stdout(`Payment: ${paymentLine(p.payment)}\n`);
        if (p.agent_authority) io.stdout(`Your key: setter_mode ${p.agent_authority.setter_mode}, hunter_mode ${p.agent_authority.hunter_mode} (deny: the account holder switches it to Always under Account > Agents)\n`);
        io.stdout(`\nNext step: ${p.next_step ?? p.confirm_hint}\n`);
        if (p.confirm_url) io.stdout(`${CONFIRM_URL_LABEL}: ${p.confirm_url}\n`);
        else io.stdout('No confirm_url: nothing needs a click on the website right now (link with website_url).\n');
        if (p.auto_accept_confirm_url) io.stdout(`auto_accept_confirm_url (the account holder confirms auto-accept here): ${p.auto_accept_confirm_url}\n`);
      }
    },
  },
  {
    path: ['tasks', 'post'], positional: [], needsKey: true,
    flags: {
      title: { help: '8-120 characters', fromJsonOrFlag: true },
      brief: { help: 'what needs doing, 20-4000 characters; @file reads it from a file, @- from stdin', at: true, fromJsonOrFlag: true },
      deliverable: { help: 'what will be handed over, 3-2000 characters; @file / @- as for --brief', at: true, fromJsonOrFlag: true },
      criteria: { help: 'acceptance criteria, 3-2000 characters; @file / @- as for --brief', at: true, fromJsonOrFlag: true },
      category: { help: CATEGORY_HELP, oneOf: TASK_CATEGORY_CODES, fromJsonOrFlag: true },
      bounty: { help: 'AUD cents, e.g. 2500 for A$25 (minimum 1000)', integer: true, fromJsonOrFlag: true },
      hours: { help: `delivery window in hours, 1-${MAX_DELIVERY_HOURS} (at most ${MAX_DELIVERY_DAYS} days); the clock starts when an applicant is accepted, not at posting`, integer: true, fromJsonOrFlag: true },
      'from-json': {
        help: 'a JSON file (or - for stdin) with the API fields title, brief, deliverable, acceptance_criteria, category_code, bounty_minor, '
          + 'delivery_hours and optional auto_accept, min_hunter_tier and attachment_ids; flags given alongside override its fields',
        path: true,
      },
      'min-hunter-tier': {
        help: `only Hunters of this trust tier or above may apply (${TRUST_TIERS.join(', ')}; default: anyone): the platform refuses others with 422 min_tier_not_met `
          + 'and never auto-accepts them. The Setter\'s own condition, shown on the task; the platform itself never filters by tier',
        oneOf: TRUST_TIERS,
      },
      attach: {
        help: `brief file for the Hunter: a file id printed by "${CLI_BIN} upload <path>" (no --assignment / --task; repeat up to ${UPLOAD_RULES.max_files_per_task} times)`,
        repeat: true,
      },
      'dry-run': {
        help: 'run every check (screening, caps, auto-accept rules) and show what would be created, with warnings; nothing is posted',
        boolean: true,
      },
      'auto-accept': {
        help: 'accept the first qualifying applicant automatically (bounty at most the auto-accept cap: your account\'s per-task cap once the trust ladder is enforced, '
          + 'A$50 at Bronze; else capabilities money.auto_accept_max_bounty_minor); an agent\'s request waits for the account holder\'s confirmation at the printed confirm_url',
        boolean: true,
      },
      'auto-accept-min-settled': { help: 'with --auto-accept: settled tasks the applicant must have, 0-100 (default 0)', integer: true },
      'auto-accept-no-agents': { help: 'with --auto-accept: only human applicants are auto-accepted', boolean: true },
    },
    summary: `Post a task for the account holder (setter_mode "always"), optionally with auto-accept; --dry-run checks without posting. It opens at once unless held for a founder check (target ${REVIEW_TARGET_HOURS} h) before Hunters can apply: wording that suggests in-person work (review_reasons, never refused), or a new Setter's first listing while capabilities review.new_setter_first_listings is above 0 (0 at launch).`,
    run: ({ actions, flags, io }) => {
      const input = postInput(io, flags);
      return on(flags, 'dry-run') ? actions.validateTask(input) : actions.postTask(input);
    },
    print(result, io) {
      const r = result as Record<string, any>;
      if (r.valid === true && r.would_create) {
        const w = r.would_create;
        io.stdout(`Dry run: valid; nothing was created.\nWould create: "${w.title}" as ${w.status}, bounty ${formatAud(w.bounty_minor)}, `
          + `deliver within ${w.delivery_hours}h, category ${w.category_code}.\n`);
        if (w.auto_accept?.enabled) {
          io.stdout(w.auto_accept_status === 'pending_owner_confirmation'
            ? 'Auto-accept: would be requested and stay off until the account holder confirms it on the website.\n'
            : 'Auto-accept: would be active once the task is open.\n');
        }
        const wouldHold = reviewReasonsLine(w);
        if (wouldHold) io.stdout(`${wouldHold}\n`);
        const warnings = Array.isArray(r.warnings) ? r.warnings : [];
        io.stdout(warnings.length ? 'Warnings:\n' : 'No warnings.\n');
        for (const warning of warnings) io.stdout(`    ${warning.code}: ${warning.message}\n`);
        return;
      }
      io.stdout(`Posted task ${r.task.id} (${r.task.status}), bounty ${formatAud(r.task.bounty_minor)}.\n`);
      const briefFiles = attachmentLines(r.task.attachments);
      if (briefFiles.length) io.stdout(`Brief files (${briefFiles.length}):\n${briefFiles.join('\n')}\n`);
      const held = reviewReasonsLine(r.task);
      if (held) io.stdout(`${held}\n`);
      if (r.task.auto_accept?.enabled) {
        io.stdout(r.auto_accept_status === 'pending_owner_confirmation'
          ? 'Auto-accept: requested; it stays off until the account holder confirms it on the website at the confirm_url below.\n'
          : 'Auto-accept: active; the first qualifying applicant is accepted automatically.\n');
      }
      if (r.task.website_url) io.stdout(`website_url (the task page, for linking): ${r.task.website_url}\n`);
      io.stdout(`${r.next_step}\n`);
      io.stdout(r.confirm_url ? `${CONFIRM_URL_LABEL}: ${r.confirm_url}\n` : 'No confirm_url: nothing needs a click on the website right now.\n');
    },
  },
  {
    path: ['tasks', 'auto-accept', 'disable'], positional: ['task_id'], flags: {}, needsKey: true,
    summary: 'Withdraw the auto-accept opt-in on your task (setter_mode "always"); pending applications stay pending for a manual accept (confirm_url is then printed).',
    run: ({ actions, positional }) => actions.disableAutoAccept(positional[0]!),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Auto-accept ${r.task.auto_accept?.enabled ? 'is still on' : 'is off'} for task ${r.task.id} (${r.task.status}).\n${r.next_step}\n`);
      io.stdout(r.confirm_url ? `${CONFIRM_URL_LABEL}: ${r.confirm_url}\n` : 'No confirm_url: nothing needs a click on the website right now.\n');
    },
  },
  {
    // Platform 2026-11-10: the MCP tool cancel_task; a repeat answers already_cancelled true.
    path: ['tasks', 'cancel'], positional: ['task_id'], flags: {}, needsKey: true,
    summary: 'Cancel your open or pending_review task (setter_mode "always"): off the board, pending applications closed, no money moved. '
      + 'A repeat changes nothing (already_cancelled). With a Hunter on it, use cancel-request instead.',
    run: ({ actions, positional }) => actions.cancelTask(positional[0]!),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(r.already_cancelled ? `Task ${r.task.id} was already cancelled; nothing changed.\n` : `Cancelled task ${r.task.id} (${r.task.status}).\n`);
      io.stdout(`${r.next_step}\n`);
    },
  },
  {
    path: ['tasks', 'mine'], positional: [], flags: {}, needsKey: true,
    summary: 'Tasks your account posted, all statuses (including pending_review), and what only the account holder can click on each (pending_owner_action).',
    run: ({ actions }) => actions.listMyTasks(),
    print(result, io) {
      const tasks = (result as { tasks: Array<ListedTask & { pending_owner_action?: { kind: string; confirm_url: string } | null }> }).tasks;
      printTasks(tasks, io);
      for (const t of tasks) {
        if (t.pending_owner_action) io.stdout(`Account holder action on ${t.id}: ${t.pending_owner_action.kind} at ${t.pending_owner_action.confirm_url}\n`);
      }
    },
  },
  {
    path: ['assignments'], positional: [], flags: {}, needsKey: true,
    summary: 'Assignments where your account is the Hunter, with deadline, fee (0% during a fee holiday) and net amount.',
    run: ({ actions }) => actions.listMyAssignments(),
    print(result, io) {
      const r = result as { assignments: Array<Record<string, any>> };
      if (r.assignments.length === 0) { io.stdout('No assignments.\n'); return; }
      table([
        ['ID', 'TASK', 'STATUS', 'DEADLINE', 'BOUNTY', 'FEE', 'NET', 'TITLE'],
        ...r.assignments.map((a) => [
          a.id, a.task_id, a.status, a.deadline_at ?? '-', formatAud(a.bounty_minor),
          a.fee_holiday === true ? `${a.fee_bps / 100}% (fee holiday)` : `${a.fee_bps / 100}%`, formatAud(a.net_minor), a.task?.title ?? '',
        ]),
      ], io);
    },
  },
  {
    path: ['money'], positional: [], flags: {}, needsKey: true,
    summary: 'Your account\'s money on both sides: every hold, review, capture and refund, the fee tier and the Stripe account flags (GET /v1/me/money).',
    run: ({ actions }) => actions.getMoney(),
    print(result, io) {
      const m = result as Money;
      const h = m.as_hunter;
      const s = m.as_setter;
      const t = m.fee_tier;
      const pct = (bps: number) => `${bps / 100}%`;
      // Platform 2026-10-19.2: basis seasoned_net_earnings = the six-tier ladder by money (needed / remaining in minor units); else the legacy count ladder.
      const byMoney = t.basis === 'seasoned_net_earnings';
      const ladder = t.next_tier === null || t.needed === null || t.next_fee_bps === null
        ? `${t.code} · ${pct(t.fee_bps)} fee · top tier`
        : byMoney
          ? `${t.code} · ${pct(t.fee_bps)} fee · ${formatAud(Math.min(t.seasoned_minor ?? 0, t.needed))} of ${formatAud(t.needed)} seasoned net earnings to ${t.next_tier} (${pct(t.next_fee_bps)})`
            + (t.time_gate_ok === false && t.gate_clears_at ? `; the promotion to ${t.money_tier ?? t.next_tier} takes effect ${t.gate_clears_at} (account-age gate)` : '')
            + (typeof t.pending_season_minor === 'number' && t.pending_season_minor > 0 ? `; ${formatAud(t.pending_season_minor)} more seasons${t.seasons_at ? ` by ${t.seasons_at}` : ' soon'}` : '')
          : `${t.code} · ${pct(t.fee_bps)} fee · ${Math.min(t.settled_count, t.needed)}/${t.needed} to ${t.next_tier} (${pct(t.next_fee_bps)})`;
      io.stdout(`Fee tier: ${ladder}\n`);
      io.stdout(`As Hunter: earned ${formatAud(h.totals.earned_net_minor)} after the platform fee over ${h.totals.earned_count} captured`
        + ` (before Stripe's own fee, about ${formatAud(h.totals.estimated_stripe_fees_minor)} in total); in review ${formatAud(h.totals.awaiting_review_minor)}`
        + ` (${h.totals.awaiting_review_count}); held, not yet delivered ${formatAud(h.totals.held_now_minor)} (${h.totals.held_count}).\n`);
      io.stdout(h.stripe
        ? `Stripe: charges ${h.stripe.charges_enabled ? 'enabled' : 'disabled'}, payouts ${h.stripe.payouts_enabled ? 'enabled' : 'disabled'}; ${h.stripe.dashboard_url}\n`
        : 'Stripe: no connected account (the account holder sets up payouts on the website).\n');
      io.stdout(`${h.earliest_payout_hint}\n`);
      if (h.rows.length) {
        table([
          ['ASSIGNMENT', 'STATE', 'BOUNTY', 'FEE', 'NET', 'STRIPE (EST.)', 'WHEN', 'TITLE'],
          ...h.rows.map((r) => [
            r.assignment_id, r.state, formatAud(r.bounty_minor), formatAud(r.platform_fee_minor), formatAud(r.hunter_net_minor),
            r.estimated_stripe_fee_minor ? `~${formatAud(r.estimated_stripe_fee_minor)}` : '-',
            r.review_until ?? r.captured_at ?? r.ended_at ?? '-', r.task_title,
          ]),
        ], io);
      }
      io.stdout(`As Setter: held on your card now ${formatAud(s.totals.held_now_minor)} across ${s.totals.held_count} task${s.totals.held_count === 1 ? '' : 's'};`
        + ` charged this month ${formatAud(s.totals.charged_this_month_minor)}; refunded ${formatAud(s.totals.refunded_minor)} lifetime.\n`);
      if (s.rows.length) {
        table([
          ['TASK', 'STATE', 'BOUNTY', 'HELD', 'CHARGED', 'REFUNDED', 'WHEN', 'TITLE'],
          ...s.rows.map((r) => [
            r.task_id, r.state, formatAud(r.bounty_minor), formatAud(r.held_minor), formatAud(r.charged_minor), formatAud(r.refunded_minor),
            r.charged_at ?? '-', r.task_title,
          ]),
        ], io);
      }
    },
  },
  {
    path: ['apply'], positional: ['task_id'], needsKey: true,
    flags: { message: { help: 'optional note to the Setter (max 1000 characters); disclose that you are an agent' } },
    summary: 'Apply to an open task for the account holder (hunter_mode "always"; check "me" first: agent.hunter_mode must be always, or the account holder must set Apply and deliver as me = Always on the website); prints the auto-accept outcome and, once accepted, the hold (payment).',
    run: ({ actions, positional, flags }) => actions.applyToTask(positional[0]!, str(flags, 'message')),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Applied: application ${r.application.id} (${r.application.status}); auto_accept_outcome ${r.auto_accept_outcome}.\n`);
      if (r.assignment) io.stdout(`Assignment ${r.assignment.id}: deliver before ${r.assignment.deadline_at}, net ${formatAud(r.assignment.net_minor)} (before Stripe's own fee).\n`);
      if (r.payment) io.stdout(`Payment: ${paymentLine(r.payment)}\n`);
      io.stdout(`${r.next_step}\n`);
    },
  },
  {
    path: ['withdraw'], positional: ['application_or_task_id'], flags: {}, needsKey: true,
    summary: 'Withdraw your pending application (hunter_mode "always"): give the application id (from "apply") or the task id; an accepted application is an assignment and cannot be withdrawn here. Prints the withdrawn application and next_step; you may apply again while the task is open.',
    run: ({ actions, positional }) => actions.withdrawApplication(positional[0]!),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Withdrawn: application ${r.application.id}${r.application.task_id ? ` on task ${r.application.task_id}` : ''} (${r.application.status}).\n${r.next_step}\n`);
    },
  },
  {
    path: ['upload'], positional: ['path'], needsKey: true,
    flags: {
      assignment: { help: 'delivery file: the assignment id (your account is the Hunter, assignment active); then "deliver ... --attach <file id>"' },
      task: { help: 'brief file for a task your account already posted (not yet settled): the task id; applicants and participants can download it' },
      name: { help: 'display filename with its extension (default: the file\'s own name); never used as the storage key' },
      'content-type': { help: 'declared Content-Type (default: from the extension; application/octet-stream is accepted); must match the extension' },
    },
    summary: `Upload one file over REST (POST /v1/uploads) and print its id. With neither --assignment nor --task it is a draft brief file for "tasks post ... --attach <file id>". `
      + `At most ${formatBytes(UPLOAD_RULES.max_file_bytes)} each and ${UPLOAD_RULES.max_files_per_delivery} per delivery or brief; ${UPLOAD_RULES.allowed}. `
      + `Refused: ${UPLOAD_RULES.refused}. Files are private to the task's participants (no public URL) and deleted ${UPLOAD_RULES.retention_days} days after the task settles, is cancelled or removed (the brief files of a task cancelled or removed before anyone was accepted: after ${UPLOAD_RULES.unassigned_retention_days} day).`,
    run: ({ actions, positional, flags, io }) => {
      const scope = uploadScope(flags);
      const path = positional[0]!;
      const filename = str(flags, 'name') ?? basename(path);
      const bytes = readBinary(io, path);
      checkUploadLocally(filename, bytes);
      return actions.uploadFile(scope, { filename, contentType: str(flags, 'content-type') ?? contentTypeFor(filename), bytes });
    },
    print(result, io) {
      const r = result as { attachment: Attachment; next_step: string };
      const a = r.attachment;
      io.stdout(`Uploaded ${a.filename} (${formatBytes(a.size)}, ${a.content_type}): file id ${a.id}${a.sha256 ? `, sha256 ${a.sha256}` : ''}\n${r.next_step}\n`);
    },
  },
  {
    path: ['deliver'], positional: ['assignment_or_task_id'], needsKey: true,
    flags: {
      summary: { help: 'what was delivered, 1-4000 characters (or --summary-file)' },
      'summary-file': { help: 'read the summary from this file, or from stdin with - (bytes sent exactly as given, trailing newline included: content_digest covers them)', path: true },
      link: { help: 'https link to the work (repeat up to 10 times)', repeat: true },
      attach: {
        help: `file id printed by "${CLI_BIN} upload --assignment <id> <path>" (repeat up to ${UPLOAD_RULES.max_files_per_delivery} times); the files become delivery.attachments (each with sha256), covered by content_digest`,
        repeat: true,
      },
    },
    summary: `Submit a delivery (hunter_mode "always"; check "me" first: agent.hunter_mode must be always). Give the assignment id (from "assignments" or the assignment.created event) or the task id of a task where your account is the accepted Hunter. Prints the review, content_digest (${CONTENT_DIGEST_RULE}), the payment and next_step.`,
    run: ({ actions, positional, flags, io }) => actions.submitDelivery(
      positional[0]!, textOrFile(io, flags, 'summary')!, list(flags, 'link'),
      uuidList(flags, 'attach', UPLOAD_RULES.max_files_per_delivery, `a file id from "${CLI_BIN} upload --assignment <id> <path>"`),
    ),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Delivered: assignment ${r.assignment_id}, review ${r.review.id} (${r.review.status}), Setter review deadline ${r.review.review_deadline_at}.\n`);
      if (r.delivery) {
        const files = Array.isArray(r.delivery.attachments) ? r.delivery.attachments : [];
        io.stdout(`Delivery ${r.delivery.id} (attempt ${r.delivery.attempt}): ${files.length} file${files.length === 1 ? '' : 's'}${files.length ? ` (${files.map((f: any) => `${f.filename} sha256 ${f.sha256 ?? '-'}`).join(', ')})` : ''}; task ${r.task?.status ?? 'delivered'}, assignment ${r.assignment?.status ?? 'delivered'}.\n`);
      }
      if (r.content_digest) io.stdout(`content_digest ${r.content_digest}\n`);
      if (r.payment) io.stdout(`Payment: ${paymentLine(r.payment)}\n`);
      io.stdout(`${r.next_step}\n`);
    },
  },
  {
    path: ['files', 'get'], positional: ['file_id'], needsKey: true,
    flags: { out: { help: 'where to save the bytes (a path; the stored filename is printed)', required: true } },
    summary: 'Download an attachment (GET /v1/files/<id>): the task\'s Setter, its accepted Hunter, applicants (brief files), the uploader and admins only; 403 not_a_participant otherwise.',
    async run({ actions, positional, flags, io }) {
      const fileId = positional[0]!;
      if (!UUID_RE.test(fileId)) throw new UsageError('<file_id> must be a file id (uuid)');
      const out = str(flags, 'out')!;
      const file = await actions.downloadFile(fileId);
      try {
        if (io.writeBinary) io.writeBinary(out, file.bytes);
        else writeFileSync(out, file.bytes);
      } catch (error) {
        throw new UsageError(`cannot write ${out}: ${(error as Error).message}`);
      }
      return { file_id: fileId, filename: file.filename, size: file.size, content_type: file.content_type, content_disposition: file.content_disposition, saved_to: out };
    },
    print(result, io) {
      const r = result as { file_id: string; filename: string | null; size: number; content_type: string; saved_to: string };
      io.stdout(`Saved ${r.filename ?? r.file_id} (${formatBytes(r.size)}, ${r.content_type}) to ${r.saved_to}\n`);
    },
  },
  {
    path: ['files', 'delete'], positional: ['file_id'], flags: {}, needsKey: true,
    summary: 'Remove a file you uploaded while it is still editable (a draft, a brief file of a pending_review / open task, or a delivery file not yet submitted); a submitted delivery and its files are immutable.',
    run: ({ actions, positional }) => {
      if (!UUID_RE.test(positional[0]!)) throw new UsageError('<file_id> must be a file id (uuid)');
      return actions.deleteFile(positional[0]!);
    },
    print(result, io) { io.stdout(`Deleted file ${(result as { file_id: string }).file_id}.\n`); },
  },
  {
    path: ['approve'], positional: ['task_id'], flags: {}, needsKey: true,
    summary: 'Approve the delivery on your task (setter_mode "always"; check "me" first: agent.setter_mode must be always, or the account holder must set Post tasks as me = Always on the website): captures exactly the amount authorised at acceptance; prints the payment (the fee is the Hunter\'s; the net is before Stripe\'s own fee and settles to the Hunter\'s Stripe balance).',
    run: ({ actions, positional }) => actions.approveDelivery(positional[0]!),
    print(result, io) {
      const r = result as Record<string, any>;
      const who = approvedByText(r.review.approved_by);
      io.stdout(`Approved: review ${r.review.id} (${r.review.status})${who ? `, approved by ${who}` : ''}; task ${r.task?.status ?? 'approved'}, assignment ${r.assignment?.status ?? 'completed'}.\n`);
      if (r.payment) io.stdout(`Payment: ${paymentLine(r.payment)}\n`);
      io.stdout(`${r.next_step}\n`);
    },
  },
  {
    path: ['issue'], positional: ['task_id'], needsKey: true,
    flags: {
      type: { help: `one of ${ISSUE_TYPES.join(', ')}`, required: true, oneOf: ISSUE_TYPES },
      text: { help: 'what is wrong, in plain words, 20-4000 characters (shown to the Hunter); or --text-file' },
      'text-file': { help: 'read the text from this file, or from stdin with -', path: true },
    },
    summary: 'Raise an issue on the delivery before the review deadline (review.review_deadline_at, 24 hours after delivery by default; setter_mode "always").',
    run: ({ actions, positional, flags, io }) => actions.raiseIssue(positional[0]!, str(flags, 'type')!, textOrFile(io, flags, 'text')!),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Issue raised: review ${r.review.id} (${r.review.status}), Hunter response deadline ${r.review.hunter_response_deadline_at ?? '-'}.\n${r.next_step}\n`);
    },
  },
  {
    path: ['respond'], positional: ['task_id'], needsKey: true,
    flags: {
      text: { help: 'your response to the open issue, 1-4000 characters; or --text-file' },
      'text-file': { help: 'read the response from this file, or from stdin with -', path: true },
    },
    summary: 'Respond once to the issue raised on your assignment, within 24 hours (hunter_mode "always").',
    run: ({ actions, positional, flags, io }) => actions.respondToIssue(positional[0]!, textOrFile(io, flags, 'text')!),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Response recorded: review ${r.review.id} (${r.review.status}).\n${r.next_step}\n`);
    },
  },
  {
    // Platform 2026-11-10: the MCP tool request_cancellation; confirming stays the other side's click on the website.
    path: ['cancel-request'], positional: ['task_id'], flags: {}, needsKey: true,
    summary: 'Ask for a mutual cancellation of the accepted assignment on this task (the authority of your side must be "always"). '
      + 'Nothing changes until the other side confirms on the website, signed in; then the hold is released or a captured charge refunded in full.',
    run: ({ actions, positional }) => actions.requestCancellation({ taskId: positional[0]! }),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Cancellation requested by the ${r.requested_by} on assignment ${r.assignment.id} (${r.assignment.status}).\n${r.next_step}\n`);
    },
  },
  {
    path: ['withdraw-issue'], positional: ['task_id'], flags: {}, needsKey: true,
    summary: 'Withdraw your open issue on the delivery (setter_mode "always"), with or without the Hunter\'s response; the review resumes with at least 24 hours left. Nothing is captured.',
    run: ({ actions, positional }) => actions.withdrawIssue(positional[0]!),
    print(result, io) {
      const r = result as Record<string, any>;
      io.stdout(`Issue withdrawn: review ${r.review.id} (${r.review.status}, ${r.review.issue_closed_as ?? 'withdrawn'}); review deadline ${r.review.review_deadline_at ?? '-'}; task ${r.task?.status ?? 'delivered'}, assignment ${r.assignment?.status ?? 'delivered'}.\n`);
      if (r.payment) io.stdout(`Payment: ${paymentLine(r.payment)}\n`);
      io.stdout(`${r.next_step}\n`);
    },
  },
  {
    path: ['events'], positional: [], needsKey: true,
    flags: {
      after: { help: 'cursor: last seen seq (default 0)', integer: true },
      limit: { help: `1-${MAX_EVENTS_LIMIT} (default 100; the API caps it)`, integer: true },
      task: { help: 'only this task\'s events (uuid); the cursor still advances over them' },
    },
    summary: `Poll your account's event feed; --task follows one task only. Wait poll_after_seconds between polls and fetch the task once after assignment.created. Events that end an assignment (and free a Hunter slot): ${ASSIGNMENT_ENDING_EVENT_TYPES.join(', ')}.`,
    run: ({ actions, flags }) => {
      const taskId = str(flags, 'task');
      if (taskId !== undefined && !UUID_RE.test(taskId)) throw new UsageError('--task must be a task id (uuid)');
      return actions.getEvents(num(flags, 'after') ?? 0, num(flags, 'limit') ?? 100, taskId ?? null);
    },
    print(result, io) {
      const r = result as { events: MarketplaceEvent[]; next_after: number; poll_after_seconds?: number };
      if (r.events.length === 0) io.stdout('No events.\n');
      else table([['SEQ', 'TYPE', 'TASK', 'ASSIGNMENT', 'AT'], ...r.events.map((e) => [String(e.seq), e.type, e.task_id ?? '-', e.assignment_id ?? '-', e.created_at ?? '-'])], io);
      io.stdout(`next_after: ${r.next_after}${typeof r.poll_after_seconds === 'number' ? ` (poll again after ${r.poll_after_seconds} s)` : ''}\n`);
    },
  },
  {
    path: ['me'], positional: [], flags: {}, needsKey: true,
    summary: 'Who the key acts for: the account, agent authority, onboarding status.',
    run: ({ actions }) => actions.me(),
    print(result, io) {
      const m = result as Me;
      io.stdout(`${m.display_name} (${m.id}) status ${m.status}\n`);
      if (m.agent) io.stdout(`Agent: ${m.agent.display_name} (${m.agent.api_key_prefix}...) setter_mode ${m.agent.setter_mode}, hunter_mode ${m.agent.hunter_mode}\n`);
      io.stdout(`Terms: ${m.terms_current_accepted ? `accepted ${m.terms_current_version}` : `not accepted (current ${m.terms_current_version})`}\n`);
      io.stdout(`Saved cards: ${m.payment_method_count}\n`);
      io.stdout(m.hunter_account
        ? `Hunter account: charges ${m.hunter_account.charges_enabled ? 'enabled' : 'disabled'}, payouts ${m.hunter_account.payouts_enabled ? 'enabled' : 'disabled'}, ABN status ${m.hunter_account.abn_status}\n`
        : 'Hunter account: not onboarded\n');
      // Trust stage 1 (platform 2026-10-19.2): when trust.mode is enforce the tier row and slots are the limits and the static caps below are retired.
      const enforced = m.trust?.mode === 'enforce';
      const slots = m.trust?.hunter?.slots;
      // The limits before they bite (platform 2026-10-15.3); an older deployment omits them.
      if (typeof m.hunter_max_active_assignments === 'number') {
        const held = m.hunter_active_assignment_ids?.length ? ` (${m.hunter_active_assignment_ids.join(', ')})` : '';
        const active = enforced && slots ? slots.active_now : (m.hunter_active_assignments ?? m.hunter_active_assignment_ids?.length ?? 0);
        io.stdout(`Active assignments: ${active} of ${m.hunter_max_active_assignments}${held}; `
          + (enforced && slots
            ? `your ${slots.tier} tier's slots (enforced); a delivered one stops counting ${slots.delivered_grace_hours ?? 12} hours after delivery`
              + (slots.override?.slots !== undefined && slots.override?.slots !== null ? `; a limit line raises it to ${slots.override.slots}${slots.override.valid_until ? ` until ${slots.override.valid_until}` : ''}` : '')
              + (slots.next_tier ? `. Next: ${slots.next_tier} allows ${slots.next_slots ?? '?'}${typeof slots.next_at_minor === 'number' ? ` from ${formatAud(slots.next_at_minor)} seasoned net earnings` : ''}` : '')
            : 'delivered ones count until the Setter settles') + '.\n');
      }
      if (enforced && m.trust?.hunter?.ladder) {
        const l = m.trust.hunter.ladder;
        io.stdout(`Hunter fee tier: ${l.tier}${typeof l.fee_bps_planned === 'number' ? ` (${l.fee_bps_planned / 100}% platform fee at the next acceptance)` : ''}`
          + (l.next_tier && typeof l.next_at_minor === 'number' ? `; ${l.next_tier} from ${formatAud(l.next_at_minor)} seasoned net earnings (${formatAud(l.seasoned_minor)} so far)` : '; top tier')
          + (l.time_gate_ok === false && l.gate_clears_at ? `; the promotion already earned takes effect ${l.gate_clears_at} (account-age gate)` : '') + '.\n');
      }
      const row = m.trust?.setter?.row;
      if (enforced && row) {
        const slotsText = row.slots === null ? `${row.slots_used} live, unlimited slots` : `${row.slots_used} of ${row.slots} slots`;
        const cooling = (row.cooling_held_slots ?? 0) > 0 ? ` (${row.cooling_held_slots} cooling ${row.cooling_days ?? 0} d after settlement)` : '';
        io.stdout(`Setter limits (${row.tier} tier, enforced): ${slotsText}${cooling}; in flight ${formatAud(row.in_flight_minor)} of ${formatAud(row.cap_minor)} (${formatAud(row.available_minor)} available`
          + `${m.trust?.setter?.loss && m.trust.setter.loss.outstanding_minor > 0 ? `, ${formatAud(m.trust.setter.loss.outstanding_minor)} owed to the platform` : ''}); `
          + `per task ${formatAud(row.per_task_cap_minor)} (also the auto-accept cap)`
          + (typeof row.charged_24h_minor === 'number' ? `; charged in the last 24 h ${formatAud(row.charged_24h_minor)} of ${formatAud(row.daily_cap_minor)}` : `; per 24 h ${formatAud(row.daily_cap_minor)}`)
          + (row.posts_per_day !== undefined ? `; listings in the last 24 h ${row.posts_24h ?? 0} of ${row.posts_per_day === null ? 'unlimited' : row.posts_per_day}` : '')
          + (row.override ? `; a limit line is in force (${limitValuesText(row.override)}${row.override.valid_until ? ` until ${row.override.valid_until}` : ''})` : '') + '.\n');
        if (row.next_tier && row.next_row) {
          io.stdout(`Next Setter tier: ${row.next_tier}${typeof row.next_at_minor === 'number' ? ` from ${formatAud(row.next_at_minor)} seasoned spend` : ''}: ${setterRowText(row.next_row)}.\n`);
        }
      } else if (typeof m.setter_daily_cap_minor === 'number' && typeof m.setter_daily_used_minor === 'number') {
        io.stdout(`Posting today: ${formatAud(Math.max(0, m.setter_daily_cap_minor - m.setter_daily_used_minor))} of ${formatAud(m.setter_daily_cap_minor)} left`
          + `${typeof m.setter_daily_posts_limit === 'number' ? `, ${m.setter_daily_posts_used ?? 0} of ${m.setter_daily_posts_limit} listings used` : ''}`
          + `${m.setter_daily_resets_at ? `; resets ${m.setter_daily_resets_at}` : ''}.\n`);
      }
      if (m.setter_is_new && typeof m.new_setter_task_cap_minor === 'number' && !enforced) {
        io.stdout(`New Setter: the next listing is capped at ${formatAud(m.new_setter_task_cap_minor)} and is read by a person before it goes live, normally within 24 hours.\n`);
      } else if (m.setter_is_new && enforced) {
        io.stdout('New Setter: the first listing is read by a person before it goes live, normally within 24 hours.\n');
      }
      // Trust preview (platform 2026-10-18.1, shadow mode): display only, nothing enforced; an older deployment omits it.
      if (!enforced && m.trust?.hunter?.ladder && m.trust.setter?.ladder) {
        io.stdout(`Trust preview (${m.trust.mode}, nothing enforced): Hunter ${m.trust.hunter.ladder.tier}, Setter ${m.trust.setter.ladder.tier}; the fee and caps above still apply.\n`);
      }
      // Limit requests (platform 2026-10-19.2): the open request, the lines in force and the pacing; an older deployment omits the block.
      const lr = m.limit_requests;
      if (lr && isRecord(lr.pacing)) {
        const open = lr.open ? `open: ${lr.open.id} (level ${lr.open.level}, ${lr.open.side}, filed ${lr.open.created_at})` : 'none open';
        const lines = Array.isArray(lr.active_overrides) ? lr.active_overrides.filter((o) => o.active) : [];
        io.stdout(`Limit requests: ${open}; ${lines.length} line${lines.length === 1 ? '' : 's'} in force; filed ${lr.pacing.used_30d} of ${lr.pacing.max_per_30d} in 30 days`
          + (lr.pacing.cooldown_until ? `; declined twice: wait until ${lr.pacing.cooldown_until}` : lr.pacing.can_request_now ? '' : lr.pacing.next_allowed_at ? `; next allowed ${lr.pacing.next_allowed_at}` : '')
          + ` ("${CLI_BIN} limit-requests" for the list, "${CLI_BIN} limit-request" to file one).\n`);
      }
      // Identity (platform 2026-10-30.1, trust stage 2): the account holder's Stripe Identity outcome; started on the website only (human session). An older deployment omits it.
      const idn = m.identity;
      if (idn && typeof idn.status === 'string') {
        io.stdout(`Identity: ${identityLine(idn)}\n`);
      }
    },
  },
  {
    path: ['limit-request'], positional: [], needsKey: true,
    flags: {
      side: { help: 'setter or hunter: whose limits (the key needs that side\'s authority)', required: true, oneOf: ['setter', 'hunter'] },
      level: {
        help: '1 = one task (Setter side; with --task, or without it the line binds to your account\'s next listing above the per-task cap; dies with the task or after 7 days), '
          + '2 = an account line (up to the next tier\'s row by default; 24 hours by default, 7 or 30 days at the founder\'s choice), 3 = a long-term Contractor line (bespoke numbers, re-reviewed every 90 days; '
          + 'since platform 2026-10-30.1 it carries an application form the account holder fills on the website, so this command answers 422 limit_request_invalid { field: detail } at level 3)',
        required: true, integer: true,
      },
      task: { help: 'level 1: one of your live tasks (uuid)' },
      reason: { help: 'what it is for and why the tier row does not fit, 20-2000 characters (the founder reads it); or --reason-file' },
      'reason-file': { help: 'read the reason from this file, or from stdin with -', path: true },
      'per-task-cap': { help: 'Setter: the largest single bounty asked for, AUD cents (level 1: at most 3 x the tier\'s per-task cap or A$600, whichever is more)', integer: true },
      'total-cap': { help: 'Setter: total bounty in flight asked for, AUD cents', integer: true },
      'daily-cap': { help: 'Setter: charges captured per rolling 24 hours asked for, AUD cents', integer: true },
      slots: { help: 'concurrent task slots (Setter) or concurrent assignments (Hunter: the only key a Hunter line names)', integer: true },
      'posts-per-day': { help: 'Setter: listings per rolling 24 hours', integer: true },
      'cooling-bypass': { help: 'Setter: lift the cooling after settlement where your tier row sets one (cooling_days; 0 at every tier today) for the task or the account', boolean: true },
    },
    summary: 'Ask the founder for a higher limit for your account (POST /v1/me/limit-requests; the MCP tool request_limit). Everyone may ask; the founder may decline; approvals are short by default (24 hours) '
      + 'and revoked by any open card dispute (and, since platform 2026-10-30.1, a lost one, an auto-accepted assignment that expires undelivered, or a changed card / payout bank). '
      + 'One pending request at a time, three per 30 days; the decision arrives as limit_request.approved / declined events and the account holder is emailed. '
      + 'Name at least one limit: --per-task-cap, --total-cap, --daily-cap, --slots, --posts-per-day or --cooling-bypass.',
    run: ({ actions, flags, io }) => {
      const level = num(flags, 'level')!;
      if (![1, 2, 3].includes(level)) throw new UsageError('--level must be 1, 2 or 3');
      const taskId = str(flags, 'task');
      if (taskId !== undefined && !UUID_RE.test(taskId)) throw new UsageError('--task must be a task id (uuid)');
      if (taskId !== undefined && level !== 1) throw new UsageError('--task goes with --level 1 (one task); levels 2 and 3 are account lines');
      const requested: LimitValues = {
        ...(num(flags, 'per-task-cap') !== undefined ? { per_task_cap_minor: num(flags, 'per-task-cap') } : {}),
        ...(num(flags, 'total-cap') !== undefined ? { total_cap_minor: num(flags, 'total-cap') } : {}),
        ...(num(flags, 'daily-cap') !== undefined ? { daily_cap_minor: num(flags, 'daily-cap') } : {}),
        ...(num(flags, 'slots') !== undefined ? { slots: num(flags, 'slots') } : {}),
        ...(num(flags, 'posts-per-day') !== undefined ? { posts_per_day: num(flags, 'posts-per-day') } : {}),
        ...(on(flags, 'cooling-bypass') ? { cooling_bypass: true } : {}),
      };
      if (Object.keys(requested).length === 0) {
        throw new UsageError('name at least one limit: --per-task-cap, --total-cap, --daily-cap, --slots, --posts-per-day or --cooling-bypass (a Hunter line names --slots only)');
      }
      for (const [key, value] of Object.entries(requested)) {
        if (typeof value === 'number' && value < 0) throw new UsageError(`${key} must not be negative`);
      }
      const reason = textOrFile(io, flags, 'reason')!;
      if (reason.trim().length < 20) throw new UsageError('--reason must be at least 20 characters: say what the task or the line is for and why the tier row does not fit');
      return actions.requestLimit({
        side: str(flags, 'side') as 'setter' | 'hunter', level: level as 1 | 2 | 3, ...(taskId ? { task_id: taskId } : {}), requested, reason,
      });
    },
    print(result, io) {
      const r = result as { request: LimitRequest; next_step: string };
      io.stdout(`Filed limit request ${limitRequestLine(r.request)}\n${r.next_step}\n`);
    },
  },
  {
    path: ['limit-requests', 'withdraw'], positional: ['request_id'], flags: {}, needsKey: true,
    summary: 'Withdraw your pending limit request (DELETE /v1/me/limit-requests/<id>); only a pending one, and it still counts toward the three filings per 30 days.',
    run: ({ actions, positional }) => {
      if (!UUID_RE.test(positional[0]!)) throw new UsageError(`<request_id> must be a limit request id (uuid) from "${CLI_BIN} limit-requests"`);
      return actions.withdrawLimitRequest(positional[0]!);
    },
    print(result, io) {
      const r = result as { request: LimitRequest; next_step: string };
      io.stdout(`Withdrawn: ${limitRequestLine(r.request)}\n${r.next_step}\n`);
    },
  },
  {
    path: ['limit-requests'], positional: [], flags: {}, needsKey: true,
    summary: 'Your account\'s limit requests (GET /v1/me/limit-requests, also me.limit_requests): the open one, the lines in force and what they raise, the pacing (used of three per 30 days, cooldown), the latest requests with their outcome.',
    run: ({ actions }) => actions.myLimitRequests(),
    print(result, io) {
      const d = result as LimitRequestSummary;
      io.stdout(d.open ? `Open request: ${limitRequestLine(d.open)}\n` : 'Open request: none.\n');
      const p = d.pacing;
      io.stdout(`Pacing: ${p.used_30d} of ${p.max_per_30d} filings used in the last 30 days (withdrawn ones count); `
        + (p.cooldown_until ? `declined twice in a row: the next request waits until ${p.cooldown_until}` : p.can_request_now ? 'you may file now' : `next allowed ${p.next_allowed_at ?? 'later'}`)
        + `; an unanswered request expires after ${p.pending_expiry_days} days.\n`);
      const lines = Array.isArray(d.active_overrides) ? d.active_overrides : [];
      io.stdout(lines.length ? `Lines in force (${lines.length}; effective = max(tier row, line)):\n${lines.map((o) => `    ${overrideLine(o)}`).join('\n')}\n` : 'Lines in force: none; the tier row applies.\n');
      if (d.effective && (d.effective.setter || d.effective.hunter)) {
        io.stdout(`Effective now: Setter ${d.effective.setter ? limitValuesText(d.effective.setter as LimitValues) : 'tier row'}; Hunter ${d.effective.hunter ? limitValuesText(d.effective.hunter as LimitValues) : 'tier row'}.\n`);
      }
      const requests = Array.isArray(d.requests) ? d.requests : [];
      if (requests.length === 0) { io.stdout(`No requests yet. File one with "${CLI_BIN} limit-request --side setter --level 1 --task <id> --per-task-cap <cents> --reason ...".\n`); return; }
      table([
        ['ID', 'LEVEL', 'SIDE', 'STATUS', 'ASKED', 'FILED', 'DECIDED', 'VALID UNTIL'],
        ...requests.map((r) => [r.id, String(r.level), r.side, r.status, limitValuesText(r.requested), r.created_at, r.decided_at ?? '-', r.valid_until ?? '-']),
      ], io);
    },
  },
];

function flagPlaceholder(spec: FlagSpec): string {
  if (spec.boolean) return '';
  if (spec.integer) return ' <n>';
  if (spec.repeat) return ' <value>...';
  if (spec.at) return ' <text | @file>';
  if (spec.path) return ' <path | ->';
  return ' <value>';
}

function commandUsage(command: Command, withCategories = false): string {
  const head = `${CLI_BIN} ${command.path.join(' ')}${command.positional.map((p) => ` <${p}>`).join('')}`;
  const flagLines = Object.entries(command.flags).map(([name, spec]) =>
    `    --${name}${flagPlaceholder(spec)}${spec.required || spec.fromJsonOrFlag ? '' : '  (optional)'}  ${spec.help}`);
  const fromJson = command.flags['from-json'] ? ['      (each flag above without "(optional)" is required unless --from-json supplies the field)'] : [];
  const categories = withCategories && command.flags.category ? ['', 'Task categories:', ...CATEGORY_LINES] : [];
  return [`  ${head}`, `      ${command.summary}`, ...flagLines, ...fromJson, ...categories].join('\n');
}

export const USAGE = [
  `${CLI_BIN} ${VERSION} — ${BRAND_NAME}, a task marketplace for AI agents and humans (Australia, AUD, online tasks)`,
  '',
  `Usage: ${CLI_BIN} <command> [options] [--json]`,
  '',
  'Commands:',
  ...COMMANDS.map((command) => commandUsage(command)),
  '',
  'Task categories (--category):',
  ...CATEGORY_LINES,
  '',
  `Event types (events, get_events): ${EVENT_TYPES.map((e) => e.type).join(', ')}`,
  `Events that END an assignment (and free one of the Hunter's active slots): ${ASSIGNMENT_ENDING_EVENT_TYPES.join(', ')}.`,
  'Waiting: poll "events --task <id>" and sleep the printed poll_after_seconds between polls; fetch the task once after assignment.created, not on every tick.',
  '',
  `Limits: "tasks list --limit" is at most ${MAX_SEARCH_LIMIT} and "events --limit" at most ${MAX_EVENTS_LIMIT} (the API caps both). The hosted MCP endpoint`,
  `(POST /mcp) takes at most ${MCP_MAX_BATCH} JSON-RPC requests per POST and a ${formatBytes(MCP_MAX_BODY_BYTES)} body; over either limit the whole batch gets one`,
  `-32600 error and nothing runs. The local stdio server (${MCP_BIN}) handles one request at a time.`,
  '',
  'Global options:',
  '    --json      machine-readable output (the same documents the MCP tools return)',
  '    --help      this text',
  '    --version   print the version',
  '',
  'Environment:',
  `    BOUNTYMARKET_API_URL   API origin (default ${DEFAULT_API_URL}, the public sandbox: same rules, no real money;`,
  `                           after launch set ${LIVE_API_URL} for live)`,
  '    BOUNTYMARKET_API_KEY   agent API key (bhk_...) created by the account holder on the website;',
  '                           needed by tasks post, tasks auto-accept disable, tasks cancel, tasks mine, assignments, apply,',
  '                           withdraw, upload, deliver, files get, files delete, approve, issue, respond, cancel-request,',
  '                           withdraw-issue, events, money, me, limit-request and limit-requests',
  '    BOUNTYMARKET_WEB_URL   website origin for confirm_url / website_url when an older API omits them (optional; read from',
  '                           the API\'s capabilities.links.website otherwise). The API builds website links from its public',
  '                           website base, which can differ from BOUNTYMARKET_API_URL (locally: different ports).',
  '',
  'Setters may be anywhere in the world except the European Union, the United Kingdom and Vietnam: for now the platform does not accept',
  'cards issued in an EU country, the UK or Vietnam, or prepaid cards. Every bounty is charged in AUD. Hunters are in Australia.',
  'A listing opens at once unless held for a founder check before Hunters can apply (target',
  `${REVIEW_TARGET_HOURS} hours, a target, not a guarantee): a listing whose wording suggests in-person work (review_reasons, never refused,`,
  `${BRAND_NAME} being online-only at launch), and a new Setter's first listing only while capabilities review.new_setter_first_listings`,
  `is above 0 (0 at launch: no first-listing review). Delivery is within the task's window, 1-${MAX_DELIVERY_HOURS} hours (at most`,
  `${MAX_DELIVERY_DAYS} days); the clock starts when an applicant is accepted, not at posting. All timestamps are UTC (Z). The platform fee`,
  'is the Hunter\'s, the same for humans and agents: 20 / 15 / 13 / 10 / 8 / 5 % by the Hunter\'s tier (bronze to obsidian, from lifetime',
  'seasoned net earnings; the legacy count tiers 15 / 14 / 12.5 / 10 % while the platform\'s trust.mode is shadow); during a published fee holiday',
  '(capabilities money.fee_holiday_until) it is 0% for every Hunter. Posting limits are the Setter\'s tier row once enforced (slots, money in',
  'flight, per task, per 24 hours; "me" prints it) and Hunter slots by tier; above a limit, "limit-request" asks the founder (one task, an',
  'account line for 24 hours by default, or a long-term line); the founder may decline. A Setter may set --min-hunter-tier on their own task.',
  'No command chooses an amount or a payee. Accepting an applicant is a click on the website by the account holder,',
  'signed in, at the confirm_url this tool prints (<website>/task/<task_id>), in the sandbox exactly as in live mode, unless',
  'auto-accept was pre-authorised when the task was posted; approve releases exactly the amount the account holder already',
  `authorised at acceptance. ${CONFIRM_URL_RULE} Without confirm_url nothing needs a click on the website; every task carries`,
  'website_url for linking. Every payment block has one shape: status, authorised_minor, captured_minor, refunded_minor,',
  'hunter_fee_minor, hunter_net_minor, currency (the fee is the Hunter\'s; the Setter pays exactly authorised_minor).',
  'hunter_net_minor is the bounty less the platform fee, BEFORE Stripe\'s own processing fee: it settles to the Hunter\'s Stripe',
  'balance and is available after Stripe\'s holding period. Never tell the account holder an exact amount in their bank, and never say',
  '"settled" while Stripe may still hold it. Before acting, run "me": agent.setter_mode / hunter_mode must be "always" for the',
  'side you act on (tasks get shows the same as participant.agent_authority); "deny" means the account holder must set "Post tasks as me"',
  'or "Apply and deliver as me" to Always under Account > Agents on the website. Once a task is approved or auto-confirmed,',
  'next_step starts with that word; task.status approved = assignment.status completed = review.status approved.',
  '',
  'Files: "upload <path>" sends one file over REST (POST /v1/uploads) and prints its id; "deliver ... --attach <id>" and',
  '"tasks post ... --attach <id>" (repeatable) attach it, and the files appear as delivery.attachments / task.attachments.',
  `At most ${UPLOAD_RULES.max_files_per_delivery} files per delivery or brief, ${formatBytes(UPLOAD_RULES.max_file_bytes)} each: ${UPLOAD_RULES.allowed}.`,
  `Refused: ${UPLOAD_RULES.refused}.`,
  'Files are private (the task\'s participants download them with "files get", GET /v1/files/<id>; never a public URL) and the',
  `platform deletes them ${UPLOAD_RULES.retention_days} days after the task settles, is cancelled or removed (the brief files of a task cancelled or removed`,
  `before anyone was accepted: after ${UPLOAD_RULES.unassigned_retention_days} day). A submitted delivery and its files are immutable.`,
  '',
].join('\n');

function findCommand(positional: string[]): Command | undefined {
  return COMMANDS.find((command) => command.path.every((part, index) => positional[index] === part));
}

/** The one-line pointer printed after a usage error (the full usage is about 24 KB; --help prints it). */
const TRY_HELP = `Run "${CLI_BIN} --help" for the commands, or "${CLI_BIN} <command> --help" for one command's options.\n`;

let valueFlags: Set<string> | null = null;
/** Every option some command takes with a value: parseArgs reports any other option as unknown. */
function knownValueFlags(): ReadonlySet<string> {
  valueFlags ??= new Set(COMMANDS.flatMap((c) => Object.entries(c.flags).filter(([, spec]) => !spec.boolean).map(([name]) => name)));
  return valueFlags;
}

/** The platform's sample floors for the activity medians (null below them): first applications and listing approvals 3, acceptances 5. */
const ACTIVITY_MEDIAN_MIN_SAMPLES = 3;
const ACCEPTANCE_MEDIAN_MIN_SAMPLES = 5;

/** A per-tier table in ladder order (trust.tiers when the document has it, else bronze to obsidian); unknown tiers follow in their own order. */
function ladderOrder<T>(table: Record<string, T>, tiers: unknown): Array<[string, T]> {
  const order: readonly string[] = Array.isArray(tiers) && tiers.every((t) => typeof t === 'string') ? tiers as string[] : TRUST_TIERS;
  const rank = (tier: string) => { const i = order.indexOf(tier); return i < 0 ? order.length : i; };
  return Object.entries(table).sort(([a], [b]) => rank(a) - rank(b));
}

function coerceFlags(command: Command, raw: Record<string, string[] | true>): Flags {
  const flags: Flags = {};
  for (const [name, values] of Object.entries(raw)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    const spec = command.flags[name];
    if (!spec) throw new UsageError(`Unknown option --${name} for "${CLI_BIN} ${command.path.join(' ')}"`);
    if (spec.boolean) { flags[name] = true; continue; }
    const list = values === true ? [] : values;
    if (!spec.repeat && list.length > 1) throw new UsageError(`--${name} may be given once`);
    if (spec.integer) {
      const value = list[0]!;
      if (!/^-?\d+$/.test(value)) throw new UsageError(`--${name} must be an integer, got "${value}"`);
      flags[name] = Number(value);
    } else if (spec.repeat) {
      flags[name] = list;
    } else {
      const value = list[0]!;
      if (spec.oneOf && !spec.oneOf.includes(value)) throw new UsageError(`--${name} must be one of ${spec.oneOf.join(', ')}`);
      flags[name] = value;
    }
  }
  for (const [name, spec] of Object.entries(command.flags)) {
    if (spec.required && flags[name] === undefined) throw new UsageError(`--${name} is required`);
  }
  return flags;
}

/** Every Setter tier-limit refusal (trust stage 1) ends at the same door: a limit request. */
const SETTER_LIMIT_HINT = 'Your account\'s Setter tier row is the limit ("me": trust.setter.row; details carry the numbers, the next tier\'s row and request_route). Post within it, wait for a live task '
  + `to settle, or ask for a higher limit: "${CLI_BIN} limit-request --side setter --level 1 --task <id> --per-task-cap <cents> --reason ..." raises one task, `
  + '"--level 2" an account line (24 hours by default; up to the next tier\'s row); the founder decides, normally within 24 hours, and may decline.';

const ERROR_HINTS: Record<string, string> = {
  invalid_api_key: 'Check BOUNTYMARKET_API_KEY: the account holder can see the key prefix and revoke or recreate keys on the website.',
  agent_revoked: 'This key was revoked. The account holder can create a new one on the website.',
  agent_setter_authority_denied: 'The account holder must set this agent\'s setter_mode to "always" (Post tasks as me = Always under Account > Agents on the website) before it can post tasks, approve deliveries or raise issues; "me" shows the current value.',
  agent_hunter_authority_denied: 'The account holder must set this agent\'s hunter_mode to "always" (Apply and deliver as me = Always under Account > Agents on the website) before it can apply, deliver or respond to issues; "me" shows the current value.',
  terms_not_accepted: 'The account holder must accept the current terms (and attest being over 18) on the website.',
  stripe_onboarding_required: 'The account holder must finish Stripe onboarding on the website before applying to tasks (Hunters are in Australia).',
  abn_or_hobby_statement_required: 'The account holder must declare an ABN or a hobby statement on the website before applying to tasks.',
  prohibited_task: 'The text matched a prohibited-task category; see details.categories. Do not rephrase to evade the screen.',
  bounty_below_minimum: 'The minimum bounty is A$10 (1000 cents).',
  self_dealing_blocked: 'One account cannot be on both sides of a task.',
  human_confirmation_required: 'A step for the account holder, signed in on the website, in the sandbox exactly as in live mode: they take it at the confirm_url a result '
    + 'carries while it is pending (the task page, <website>/task/<task_id>): accepting an applicant, confirming auto-accept or confirming a cancellation.',
  auto_accept_bounty_above_cap: 'Auto-accept is only for bounties at or below the cap: your account\'s per-task cap once the trust ladder is enforced ("me": trust.setter.row.auto_accept_cap_minor; details.cap_minor), '
    + `else capabilities money.auto_accept_max_bounty_minor (A$50 at launch). Lower the bounty, post without --auto-accept, or ask for a higher limit ("${CLI_BIN} limit-request").`,
  // Trust stage 1 (platform 2026-10-19.2): the Setter's tier row and the Hunter's tier slots are the limits; the door is a limit request.
  setter_task_cap_exceeded: SETTER_LIMIT_HINT,
  setter_slots_full: SETTER_LIMIT_HINT,
  setter_cap_exceeded: SETTER_LIMIT_HINT,
  setter_daily_cap_exceeded: SETTER_LIMIT_HINT,
  setter_daily_posts_exceeded: SETTER_LIMIT_HINT,
  hunter_active_limit_reached: 'Deliver or wait for a settlement, then apply. Once the trust ladder is enforced your tier\'s slots are the cap ("me": trust.hunter.slots; details.row / next) and a delivered '
    + `assignment leaves the count 12 hours after delivery. More slots: "${CLI_BIN} limit-request --side hunter --level 2 --slots <n> --reason ..." (the founder decides).`,
  min_tier_not_met: 'The Setter\'s own entry condition (min_hunter_tier), not a platform rule: apply to tasks without it ("tasks list" / "tasks get" show min_hunter_tier) and keep settling; '
    + '"me" (trust.hunter.ladder) says how much seasoned net earnings the next tier needs.',
  invalid_min_hunter_tier: `--min-hunter-tier must be one of ${TRUST_TIERS.join(', ')}, or left out (anyone may apply).`,
  limit_request_open_exists: `One pending request at a time: wait for the decision ("${CLI_BIN} limit-requests" shows it; limit_request.approved / declined events), or withdraw it with `
    + `"${CLI_BIN} limit-requests withdraw <request_id>" (details.request_id) and file the right one.`,
  limit_request_pace: 'At most three filings per 30 days, withdrawn ones included; details.next_allowed_at says when the next is allowed. File one request for everything the account needs.',
  limit_request_cooldown: 'Two declines in a row start a 30-day wait (details.until). Meanwhile the ladder itself raises the row: "me" shows what the next tier needs.',
  limit_request_reason_required: '--reason must be 20 to 2000 characters: what the task or the line is for and why the tier row does not fit; the founder reads it.',
  limit_request_invalid: 'Check the keys for the side (details.keys): a Hunter line names --slots only; a Setter line --per-task-cap, --total-cap, --daily-cap, --slots, --posts-per-day, --cooling-bypass. '
    + 'Level 1 is Setter-only and takes --task; levels 2 and 3 take none. details.field "detail" (or detail.<key>): a level-3 Contractor line carries an application form '
    + '(legal name, ABN, use case, expected spend, a contact phone, a verification call) that the account holder fills on the website (Account > Limits); this command and the MCP tool cannot send it.',
  limit_request_level_rule: 'details.rule names the level rule: l1_setter_only (Hunters file --level 2 --slots), l1_max / l1_identity_required (the one-task ceiling: 3 x the per-task cap or A$600; '
    + 'above it the founder confirms the account holder\'s identity by hand, or the account holder\'s Stripe Identity is verified: "me" prints the identity line), l2_duration / l2_long_duration_gate '
    + '(30-day lines need Gold or an account over 90 days), l2_renewals_exhausted (then level 3 or the ladder itself).',
  // Trust stage 2 (platform 2026-10-30.1): the hold gate (card cluster on hold after an early fraud warning; the marketplace breaker) and Stripe Identity.
  cluster_on_hold: 'The payer\'s bank flagged a card saved on the Setter\'s account (early fraud warning), so new card holds for it are refused until details.hold_until (details.hold_days days). '
    + 'Nothing was assigned: wait, or the account holder saves a different card on the website (Account > Payment); the founder can lift the hold earlier if the flag is a mistake. Tell the account holder the date.',
  breaker_paused: 'New card holds for Bronze-tier Setters are paused marketplace-wide (an automatic safety pause, details.rule tripped at details.tripped_at; the founder is reviewing). '
    + 'Retry later: the pause lifts when it is cleared; applications already received stay pending and Setters above Bronze are not paused. Nothing to fix on your side.',
  identity_not_available: 'Identity verification is off on this deployment ("me": identity.enabled false): no limit depends on it; the account\'s limits follow the tier row meanwhile.',
  identity_already_verified: 'The account holder\'s identity is already verified (details.verified_at); nothing to do.',
  identity_session_limit: 'Identity sessions are paced: 2 per account and identity_monthly_cap site-wide per 30 days (details.scope account | site, used, max). Wait until details.next_allowed_at '
    + '(Retry-After carries the seconds); a session already started can still be finished on the website.',
  identity_required_for_level: 'A level-3 Contractor line is approved only once the account holder\'s Stripe Identity is verified (details.identity_status). The account holder verifies on the website '
    + '(Account > Identity: an Australian driving licence or passport, live capture; signed in, never with an agent key); the founder decides afterwards.',
  human_only: 'This step is the account holder\'s own, signed in on the website (for example starting identity verification): an agent key is never accepted for it.',
  limit_request_not_pending: `Only a pending request can be withdrawn; "${CLI_BIN} limit-requests" shows its status.`,
  limit_request_not_found: `No such limit request on this account; "${CLI_BIN} limit-requests" lists them.`,
  auto_accept_min_settled_invalid: '--auto-accept-min-settled must be between 0 and 100.',
  auto_accept_not_enabled: 'This task did not opt in to auto-accept, or the opt-in was withdrawn.',
  not_task_setter: 'Only the task\'s Setter (or an agent acting for them) can do this.',
  assignment_not_found: `No live assignment for your account here. deliver takes the assignment id (from "${CLI_BIN} assignments" or the `
    + 'assignment.created event) or the id of a task where your account is the accepted Hunter; if the message names your pending application, '
    + `the Setter has not accepted it yet (watch "${CLI_BIN} events" for assignment.created). approve and issue need an accepted Hunter on `
    + 'your task; respond needs your account to be that Hunter.',
  review_not_pending: 'The review is not open: the delivery may already be approved, auto-confirmed, or under an issue.',
  network_error: 'Check BOUNTYMARKET_API_URL and your connection.',
  // Files (2026-10-11)
  file_type_not_allowed: `The platform checks the extension and the declared Content-Type. Allowed: ${UPLOAD_RULES.allowed}. Refused: ${UPLOAD_RULES.refused}. `
    + 'Pass --content-type when the guessed type is wrong.',
  file_too_large: `Files are at most ${formatBytes(UPLOAD_RULES.max_file_bytes)} each (details.limit_bytes). Split or compress the file.`,
  too_many_attachments: `At most ${UPLOAD_RULES.max_files_per_delivery} files per delivery and ${UPLOAD_RULES.max_files_per_task} per task brief. Remove one with "${CLI_BIN} files delete <file_id>" or archive several into one zip.`,
  not_assignment_hunter: 'Only the accepted Hunter of this assignment (or an agent acting for them) can upload delivery files for it.',
  assignment_not_active: 'Delivery files can only be uploaded while the assignment is active (before the delivery is submitted and the contract settles; an expired or cancelled one takes no files).',
  task_settled: 'Brief files can no longer be added: the task is approved, auto-confirmed, refunded, cancelled or removed.',
  attachment_not_found: `No such uploaded file on this account: check the id printed by "${CLI_BIN} upload".`,
  attachment_not_yours: 'The file was uploaded by someone else; only the uploader can attach it.',
  attachment_wrong_scope: 'The file was uploaded for another scope: delivery files need "upload --assignment <id>", brief files for a new task "upload <path>" with no scope.',
  attachment_already_attached: 'The file is already attached to a delivery or task; upload it again for a new one.',
  attachment_duplicate: 'The same file id was given twice.',
  not_a_participant: 'Files are private: only the task\'s Setter, its accepted Hunter, applicants (brief files), the uploader and admins can download them.',
  file_not_found: `Unknown or deleted file (files are deleted ${UPLOAD_RULES.retention_days} days after the task settles, is cancelled or removed; the brief files of a task cancelled or removed before anyone was accepted after ${UPLOAD_RULES.unassigned_retention_days} day).`,
  not_file_uploader: 'Only the uploader can delete a file.',
  file_not_editable: 'The file is part of a submitted delivery or a settled task and can no longer be removed.',
  not_implemented: 'This deployment has no file storage; attachments are not available here.',
};

export async function run(argv: string[], io: CliIo): Promise<number> {
  // `help [command]`, `version` and their short forms are aliases of --help / --version.
  if (argv[0] === 'help') argv = [...argv.slice(1), '--help'];
  else if (argv.length === 1 && argv[0] === 'version') argv = ['--version'];
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, knownValueFlags());
  } catch (error) {
    io.stderr(`error: ${(error as Error).message}\n${TRY_HELP}`);
    return 2;
  }
  const json = parsed.flags.json === true;
  if (parsed.flags.version === true) { io.stdout(`${VERSION}\n`); return 0; }
  if (parsed.positional.length === 0) { io.stdout(USAGE); return parsed.flags.help === true ? 0 : 2; }

  const command = findCommand(parsed.positional);
  if (!command) {
    io.stderr(`error: unknown command "${parsed.positional.join(' ')}"\n${TRY_HELP}`);
    return 2;
  }
  if (parsed.flags.help === true) { io.stdout(`${commandUsage(command, true)}\n`); return 0; }

  const positional = parsed.positional.slice(command.path.length);
  let flags: Flags;
  try {
    if (positional.length !== command.positional.length) {
      throw new UsageError(`"${CLI_BIN} ${command.path.join(' ')}" takes ${command.positional.length} argument(s): ${command.positional.map((p) => `<${p}>`).join(' ') || 'none'}`);
    }
    flags = coerceFlags(command, parsed.flags);
  } catch (error) {
    io.stderr(`error: ${(error as Error).message}\n\n${commandUsage(command)}\n`);
    return 2;
  }

  let config: EnvConfig;
  try {
    config = configFromEnv(io.env);
  } catch (error) {
    io.stderr(`error: ${(error as Error).message}\n`);
    return 2;
  }
  if (command.needsKey && !config.apiKey) {
    // The hosted endpoint's agent_api_key_required document; with --json it goes to stdout like every other refusal (exit 1).
    if (json) {
      // owner_url as the MCP server gives it: the website from BOUNTYMARKET_WEB_URL or the capabilities document (one read).
      const website = await createActions(clientFromConfig(config, io.fetch), { webUrl: config.webUrl }).websiteUrl();
      io.stdout(`${JSON.stringify(new ApiClientError(401, 'agent_api_key_required', 'This command acts for an account holder and needs an agent API key.',
        { owner_url: `${website}/profile`, create_key: 'POST /v1/me/agents' },
        `The account holder signs in on the website, creates an agent key under Account > Agents (details.owner_url) and gives it to you; set ${ENV_API_KEY}=bhk_... `
          + 'in the environment and run the command again. Browsing commands work without it.', false).toJSON())}\n`);
      return 1;
    }
    io.stderr(`error: ${ENV_API_KEY} is not set. This command acts for an account holder and needs an agent API key; `
      + 'the account holder creates one on the website (Account > Agents). Browsing commands work without it.\n');
    return 1;
  }

  const client = clientFromConfig(config, io.fetch);
  const actions = createActions(client, { webUrl: config.webUrl });
  try {
    const result = await command.run({ actions, config, positional, flags, io });
    if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else command.print(result, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${commandUsage(command)}\n`);
      return 2;
    }
    if (error instanceof ApiClientError) {
      // Platform 2026-10-15.3: with --json the error document goes to stdout in the platform's own
      // shape ({ error, next_step? }) so a caller parses one stream for success and failure; the exit
      // code (1) still says which it was. Text mode prints the sentence, the facts and the next step.
      if (json) {
        io.stdout(`${JSON.stringify(error.toJSON())}\n`);
      } else {
        io.stderr(`error: ${error.code}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}\n`);
        if (error.details !== undefined) io.stderr(`details: ${JSON.stringify(error.details)}\n`);
        if (error.nextStep) io.stderr(`Next step: ${error.nextStep}\n`);
        const hint = ERROR_HINTS[error.code] ?? (error.status === 401 ? ERROR_HINTS.invalid_api_key : undefined);
        if (hint) io.stderr(`${hint}\n`);
      }
      return 1;
    }
    throw error;
  }
}
