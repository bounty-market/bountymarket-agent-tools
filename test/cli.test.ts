import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { USAGE, UsageError, parseArgs, run, type CliIo } from '../src/cli.ts';
import { GUIDES, guidesForCapabilities } from '../src/tools.ts';
import { VERSION } from '../src/version.ts';
import {
  STEP, UUID_A, UUID_B, UUID_C, UUID_D, UUID_FILE, UUID_FILE_2, WEBSITE_URL_A, approvedReview, capturedPayment, emptyParticipant, fakeFetch, heldOwnerTask,
  heldPayment, holidayAssignment, routes, sampleApplication, sampleAssignment, sampleAttachment, sampleBriefFile, sampleDelivery, sampleOwnerTask, sampleReview,
  sampleTask, withoutWebsiteUrl, type FakeHandler,
  sampleMoney,
  LIMIT_REQUEST_STEP, UUID_LINE, UUID_REQ, ladderFeeTiers, legacyFeeTiers, sampleLimitOverride, sampleLimitRequest, sampleLimitSummary, setterRows,
} from './fake-fetch.ts';

type IoExtras = {
  readFile?: (path: string) => string;
  stdin?: () => string;
  readBinary?: (path: string) => Uint8Array;
  writeBinary?: (path: string, bytes: Uint8Array) => void;
};

function io(env: Record<string, string | undefined>, handler: FakeHandler = () => ({ status: 500, json: {} }), extras: IoExtras = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fake = fakeFetch(handler);
  const cli: CliIo = { stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); }, env, fetch: fake.fetch, ...extras };
  return { cli, out: () => out.join(''), err: () => err.join(''), calls: fake.calls };
}

const ENV = { BOUNTYMARKET_API_URL: 'https://api.test', BOUNTYMARKET_WEB_URL: 'https://web.test' };
const ENV_KEY = { ...ENV, BOUNTYMARKET_API_KEY: 'bhk_test_key' };

const POST_ARGV = ['tasks', 'post', '--title', sampleTask.title, '--brief', sampleTask.brief, '--deliverable', sampleTask.deliverable,
  '--criteria', sampleTask.acceptance_criteria, '--category', 'data_research', '--bounty', '2500', '--hours', '24'];
const POST_BODY = {
  title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable,
  acceptance_criteria: sampleTask.acceptance_criteria, category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24,
};

const CONFIRM_LABEL = 'confirm_url (the account holder\'s click there, signed in on the website; "Next step" says what)';

describe('cli: argument parsing', () => {
  it('separates positionals, --flag value, --flag=value, repeated flags and booleans', () => {
    const parsed = parseArgs(['deliver', UUID_B, '--summary', 'Done', '--link=https://a.test', '--link', 'https://b.test', '--json']);
    assert.deepEqual(parsed.positional, ['deliver', UUID_B]);
    assert.deepEqual(parsed.flags, { summary: ['Done'], link: ['https://a.test', 'https://b.test'], json: true });
  });

  it('treats everything after -- as positional and accepts values that start with dashes', () => {
    const parsed = parseArgs(['apply', UUID_A, '--message', '--not-a-flag', '--', '--literal']);
    assert.deepEqual(parsed.positional, ['apply', UUID_A, '--literal']);
    assert.deepEqual(parsed.flags, { message: ['--not-a-flag'] });
  });

  it('rejects a trailing flag without a value and a boolean with a value', () => {
    assert.throws(() => parseArgs(['tasks', 'list', '--status']), UsageError);
    assert.throws(() => parseArgs(['tasks', 'list', '--json=yes']), UsageError);
  });

  it('treats the auto-accept switches and --dry-run as booleans that take no value', () => {
    const parsed = parseArgs(['tasks', 'post', '--auto-accept', '--bounty', '1300', '--auto-accept-no-agents', '--auto-accept-min-settled', '2', '--dry-run']);
    assert.deepEqual(parsed.flags, { 'auto-accept': true, bounty: ['1300'], 'auto-accept-no-agents': true, 'auto-accept-min-settled': ['2'], 'dry-run': true });
    assert.throws(() => parseArgs(['tasks', 'post', '--auto-accept=yes']), UsageError);
    assert.throws(() => parseArgs(['tasks', 'post', '--dry-run=yes']), UsageError);
  });
});

describe('cli: commands', () => {
  it('prints usage and exits 2 without a command, 0 with --help, and prints the version', async () => {
    const none = io(ENV);
    assert.equal(await run([], none.cli), 2);
    assert.ok(none.out().startsWith(USAGE.slice(0, 40)));
    const help = io(ENV);
    assert.equal(await run(['--help'], help.cli), 0);
    const version = io(ENV);
    assert.equal(await run(['--version'], version.cli), 0);
    assert.equal(version.out(), `${VERSION}\n`);
  });

  it('--help prints the category labels, event types, the review hold, the confirm_url rule, the payment shape and the file / dry-run options', async () => {
    const help = io(ENV);
    assert.equal(await run(['--help'], help.cli), 0);
    // The eight categories (2026-10-11): code, English label, Chinese label, one-line description, in the platform's order.
    assert.match(help.out(), /Task categories \(--category\):\n\s+testing_qa\s+Testing and QA \(测试与 QA\): Try a product, flow, app or API and report what you find: bugs, confusing steps, device checks, usability notes\.\n\s+writing_editing\s+Writing and editing \(写作与校对\): Write, rewrite, proofread or edit text: copy, documentation, emails, product descriptions, summaries\.\n\s+data_research\s+Data and research \(数据与调研\): Collect, check, label, clean or look up information: spreadsheets, scraped data, fact-checking, desk research, human-in-the-loop verification\.\n\s+design_media\s+Design and media \(设计与媒体\): Visual and audio work: logos, graphics, slides, illustration, photo or video edits, voice or audio recordings\.\n\s+code_automation\s+Code and automation \(代码与自动化\): Small software jobs: scripts, fixes, integrations, spreadsheet formulas, prompts, bots, website tweaks\.\n\s+translation_language\s+Translation and language \(翻译与语言\): Translate or localise text, check a translation, transcribe speech, or review wording in a given language\.\n\s+feedback_advice\s+Feedback and advice \(反馈与辅导\): A written opinion from someone with relevant experience: review a pitch deck, plan, CV, design or draft; explain or coach in writing\.\n\s+other\s+Other \(其他\): Any other online task with a clear deliverable that fits none of the seven categories above; say what it is in the brief\./);
    assert.doesNotMatch(help.out(), /digital_online|creative_arts|learning_guidance/, 'the launch codes were re-tagged on the platform');
    assert.match(help.out(), /Event types \(events, get_events\): task\.pending_review, task\.published, .*assignment\.expired/);
    assert.match(help.out(), /Limits: "tasks list --limit" is at most 50 and "events --limit" at most 200 \(the API caps both\)\. The hosted MCP endpoint\n\(POST \/mcp\) takes at most 20 JSON-RPC requests per POST and a 1\.0 MB body; over either limit the whole batch gets one\n-32600 error and nothing runs\. The local stdio server \(bountymarket-mcp\) handles one request at a time\./);
    assert.match(help.out(), /Delivery is within the task's window, 1-96 hours \(at most\n4 days\); the clock starts when an applicant is accepted, not at posting\. All timestamps are UTC \(Z\)\./);
    assert.match(help.out(), /bountymarket tasks auto-accept disable <task_id>/);
    assert.match(help.out(), /bountymarket deliver <assignment_or_task_id>/);
    assert.match(help.out(), /--summary-file <path \| ->  \(optional\)  read the summary from this file, or from stdin with -/);
    assert.match(help.out(), /bountymarket upload <path>\n\s+Upload one file over REST \(POST \/v1\/uploads\) and print its id\. With neither --assignment nor --task it is a draft brief file for "tasks post \.\.\. --attach <file id>"\. At most 25\.0 MB each and 10 per delivery or brief; documents \(pdf, doc\/docx, xls\/xlsx, ppt\/pptx, odt, txt, md, csv, json\), images \(png, jpg, gif, webp, svg\), archives \(zip, 7z, tar\.gz\), code and text files, audio \(mp3, wav, m4a\), video \(mp4, mov, webm\)\. Refused: executables, installers and runnable scripts \(exe, dll, msi, dmg, pkg, app, bat, cmd, sh, ps1, jar, apk and the like\); both the extension and the declared Content-Type are checked\. Files are private to the task's participants \(no public URL\) and deleted 20 days after the task settles, is cancelled or removed \(the brief files of a task cancelled or removed before anyone was accepted: after 1 day\)\./);
    assert.match(help.out(), /--assignment <value>  \(optional\)  delivery file: the assignment id/);
    assert.match(help.out(), /--task <value>  \(optional\)  brief file for a task your account already posted/);
    assert.match(help.out(), /--attach <value>\.\.\.  \(optional\)  file id printed by "bountymarket upload --assignment <id> <path>" \(repeat up to 10 times\); the files become delivery\.attachments \(each with sha256\), covered by content_digest/);
    assert.match(help.out(), /--attach <value>\.\.\.  \(optional\)  brief file for the Hunter: a file id printed by "bountymarket upload <path>"/);
    assert.match(help.out(), /bountymarket files get <file_id>\n\s+Download an attachment \(GET \/v1\/files\/<id>\): the task's Setter, its accepted Hunter, applicants \(brief files\), the uploader and admins only; 403 not_a_participant otherwise\.\n\s+--out <value>  where to save the bytes/);
    assert.match(help.out(), /bountymarket files delete <file_id>\n\s+Remove a file you uploaded while it is still editable/);
    assert.match(help.out(), /Files: "upload <path>" sends one file over REST \(POST \/v1\/uploads\) and prints its id; "deliver \.\.\. --attach <id>" and\n"tasks post \.\.\. --attach <id>" \(repeatable\) attach it, and the files appear as delivery\.attachments \/ task\.attachments\.\nAt most 10 files per delivery or brief, 25\.0 MB each: documents/);
    assert.match(help.out(), /Files are private \(the task's participants download them with "files get", GET \/v1\/files\/<id>; never a public URL\) and the\nplatform deletes them 20 days after the task settles, is cancelled or removed \(the brief files of a task cancelled or removed\nbefore anyone was accepted: after 1 day\)\. A submitted delivery and its files are immutable\./);
    assert.match(help.out(), /needed by tasks post, tasks auto-accept disable, tasks cancel, tasks mine, assignments, apply,\n\s+withdraw, upload, deliver, files get, files delete, approve, issue, respond, cancel-request,\n\s+withdraw-issue, events, money, me, limit-request and limit-requests/);
    // 2026-10-15.12: the help names the five events that end an assignment and how to wait.
    assert.match(help.out(), /Events that END an assignment \(and free one of the Hunter's active slots\): completion\.approved, completion\.auto_confirmed, completion\.decided, assignment\.cancelled, assignment\.expired\./);
    assert.match(help.out(), /Waiting: poll "events --task <id>" and sleep the printed poll_after_seconds between polls; fetch the task once after assignment\.created, not on every tick\./);
    assert.match(help.out(), /bountymarket withdraw <application_or_task_id>/);
    assert.match(help.out(), /--eligible  \(optional\)  shortcut for --allow-agents true --auto-accept-status active --fields summary/);
    assert.match(help.out(), /--text-file <path \| ->  \(optional\)/);
    assert.match(help.out(), /--task <value>  \(optional\)  only this task's events \(uuid\)/);
    // 2026-11-10: no first-listing review by default; the text is true at 0 and above 0.
    assert.match(help.out(), /A listing opens at once unless held for a founder check before Hunters can apply \(target\n24 hours, a target, not a guarantee\)/);
    assert.match(help.out(), /a listing whose wording suggests in-person work \(review_reasons, never refused,\nBountyMarket being online-only at launch\), and a new Setter's first listing only while capabilities review\.new_setter_first_listings\nis above 0 \(0 at launch: no first-listing review\)/);
    assert.doesNotMatch(help.out(), /first listing waits for founder review/);
    assert.match(help.out(), /It opens at once unless held for a founder check \(target 24 h\) before Hunters can apply: wording that suggests in-person work \(review_reasons, never refused\), or a new Setter's first listing while capabilities review\.new_setter_first_listings is above 0 \(0 at launch\)\./);
    // Trust stage 1 (platform 2026-10-19.2): six fee tiers by money earned, the Setter tier row as the posting limit, the limit-request door.
    assert.match(help.out(), /20 \/ 15 \/ 13 \/ 10 \/ 8 \/ 5 % by the Hunter's tier \(bronze to obsidian, from lifetime\nseasoned net earnings; the legacy count tiers 15 \/ 14 \/ 12\.5 \/ 10 % while the platform's trust\.mode is shadow\); during a published fee holiday\n\(capabilities money\.fee_holiday_until\) it is 0% for every Hunter\. Posting limits are the Setter's tier row once enforced/);
    assert.match(help.out(), /above a limit, "limit-request" asks the founder \(one task, an\naccount line for 24 hours by default, or a long-term line\); the founder may decline\. A Setter may set --min-hunter-tier on their own task\./);
    assert.match(help.out(), /bountymarket limit-request\n\s+Ask the founder for a higher limit for your account \(POST \/v1\/me\/limit-requests; the MCP tool request_limit\)/);
    assert.match(help.out(), /--side <value>  setter or hunter/);
    assert.match(help.out(), /--level <n>  1 = one task \(Setter side/);
    assert.match(help.out(), /--cooling-bypass  \(optional\)  Setter: lift the cooling after settlement where your tier row sets one/);
    assert.match(help.out(), /bountymarket limit-requests withdraw <request_id>/);
    assert.match(help.out(), /bountymarket limit-requests\n\s+Your account's limit requests \(GET \/v1\/me\/limit-requests, also me\.limit_requests\)/);
    assert.match(help.out(), /--min-hunter-tier <value>  \(optional\)  only Hunters of this trust tier or above may apply \(bronze, silver, gold, platinum, diamond, obsidian; default: anyone\)/);
    assert.doesNotMatch(help.out(), /first listings/);
    assert.match(help.out(), /\(<website>\/task\/<task_id>\), in the sandbox exactly as in live mode/);
    assert.match(help.out(), /If a result contains confirm_url, the account holder has one click to make there on the website, signed in, that an agent key cannot; next_step says what\. Without confirm_url nothing needs a click on the website; every task carries\nwebsite_url for linking\./);
    // Platform 2026-11-12.1 (founder 2026-11-11): an agent acts through an account; the help never names an owner (machine names such as pending_owner_action stay).
    assert.match(help.out(), /No command chooses an amount or a payee\. Accepting an applicant is a click on the website by the account holder,\nsigned in, at the confirm_url this tool prints/);
    assert.match(help.out(), /BOUNTYMARKET_API_KEY   agent API key \(bhk_\.\.\.\) created by the account holder on the website;/);
    assert.doesNotMatch(help.out(), /\bowner\b|human owner/i);
    assert.match(help.out(), /status, authorised_minor, captured_minor, refunded_minor,\nhunter_fee_minor, hunter_net_minor, currency \(the fee is the Hunter's; the Setter pays exactly authorised_minor\)/);
    assert.match(help.out(), /BOUNTYMARKET_WEB_URL\s+website origin for confirm_url \/ website_url when an older API omits them/);
    assert.match(help.out(), /can differ from BOUNTYMARKET_API_URL \(locally: different ports\)/);
    assert.doesNotMatch(help.out(), /\/tasks\//);
    const post = io(ENV);
    assert.equal(await run(['tasks', 'post', '--help'], post.cli), 0);
    assert.match(post.out(), /--category <value>  one of testing_qa, writing_editing, data_research, design_media, code_automation, translation_language, feedback_advice, other \(labels under "Task categories" below\)/);
    assert.match(post.out(), /--brief <text \| @file>  what needs doing, 20-4000 characters; @file reads it from a file, @- from stdin/);
    assert.match(post.out(), /--from-json <path \| ->  \(optional\)  a JSON file \(or - for stdin\) with the API fields title, brief, deliverable, acceptance_criteria, category_code, bounty_minor, delivery_hours and optional auto_accept, min_hunter_tier and attachment_ids; flags given alongside override its fields/);
    assert.match(post.out(), /--dry-run  \(optional\)  run every check \(screening, caps, auto-accept rules\) and show what would be created, with warnings; nothing is posted/);
    assert.match(post.out(), /required unless --from-json supplies the field/);
    assert.match(post.out(), /Task categories:\n\s+testing_qa\s+Testing and QA \(测试与 QA\): Try a product/);
    assert.match(post.out(), /--hours <n>  delivery window in hours, 1-96 \(at most 4 days\); the clock starts when an applicant is accepted, not at posting/);
    // The limits the platform caps server-side (2026-10-11): search 50, events 200.
    const list = io(ENV);
    assert.equal(await run(['tasks', 'list', '--help'], list.cli), 0);
    assert.match(list.out(), /--limit <n>  \(optional\)  1-50 \(default and maximum 50; the API caps it\)/);
    const events = io(ENV);
    assert.equal(await run(['events', '--help'], events.cli), 0);
    assert.match(events.out(), /--limit <n>  \(optional\)  1-200 \(default 100; the API caps it\)/);
  });

  it('rejects unknown commands and unknown options with exit 2', async () => {
    const unknown = io(ENV);
    assert.equal(await run(['frobnicate'], unknown.cli), 2);
    assert.match(unknown.err(), /unknown command "frobnicate"/);
    const option = io(ENV);
    assert.equal(await run(['tasks', 'list', '--colour', 'red'], option.cli), 2);
    assert.match(option.err(), /Unknown option --colour/);
    assert.equal(option.calls.length, 0);
  });

  it('tasks list passes status, category and limit through and prints JSON with --json', async () => {
    const t = io(ENV, routes({ 'GET /v1/tasks': { json: { tasks: [sampleTask], next_before: null } } }));
    assert.equal(await run(['tasks', 'list', '--status', 'assigned', '--category', 'other', '--limit', '7', '--json'], t.cli), 0);
    assert.equal(t.calls[0]!.url.href, 'https://api.test/v1/tasks?status=assigned&category=other&limit=7');
    assert.deepEqual(JSON.parse(t.out()), { tasks: [sampleTask], count: 1 });
    assert.equal(JSON.parse(t.out()).tasks[0].website_url, WEBSITE_URL_A, 'every task carries website_url');
  });

  it('tasks list defaults to open tasks and prints a table for humans', async () => {
    const t = io(ENV, routes({ 'GET /v1/tasks': { json: { tasks: [sampleTask], next_before: null } } }));
    assert.equal(await run(['tasks', 'list'], t.cli), 0);
    assert.equal(t.calls[0]!.url.search, '?status=open');
    assert.match(t.out(), /A\$25\.00/);
    assert.match(t.out(), /Summarise three research papers/);
  });

  it('tasks list --fields summary / --eligible / filters / --sort map to the 2026-10-15.12 query; keyed rows print my part', async () => {
    const summaryRow = { id: UUID_A, title: sampleTask.title, bounty_minor: 2500, delivery_hours: 24, category_code: 'data_research', auto_accept: sampleTask.auto_accept, published_at: sampleTask.published_at, website_url: WEBSITE_URL_A, setter_is_ai_agent: true };
    const t = io(ENV, routes({ 'GET /v1/tasks': { json: { tasks: [summaryRow], next_before: null } } }));
    assert.equal(await run(['tasks', 'list', '--fields', 'summary', '--allow-agents', 'true', '--auto-accept-status', 'active', '--min-bounty', '1000', '--max-bounty', '5000', '--sort', 'bounty_desc', '--json'], t.cli), 0);
    assert.equal(t.calls[0]!.url.search, '?status=open&fields=summary&allow_agents=true&auto_accept=active&min_bounty=1000&max_bounty=5000&sort=bounty_desc');
    assert.deepEqual(JSON.parse(t.out()), { tasks: [summaryRow], count: 1 });

    const eligible = io(ENV_KEY, routes({ 'GET /v1/tasks': { json: { tasks: [{ ...summaryRow, my_application: { id: UUID_C, status: 'pending' }, my_assignment: null }], next_before: null } } }));
    assert.equal(await run(['tasks', 'list', '--eligible'], eligible.cli), 0);
    assert.equal(eligible.calls[0]!.url.search, '?status=open&fields=summary&allow_agents=true&auto_accept=active');
    assert.match(eligible.out(), /Summarise three research papers  \[applied \(pending\)\]/, 'a keyed row says the owner already applied');
    assert.match(eligible.out(), /A\$25\.00 +24h +data_research +- +agent/, 'summary rows have no status column');

    const bad = io(ENV);
    assert.equal(await run(['tasks', 'list', '--min-bounty', '5000', '--max-bounty', '100'], bad.cli), 2);
    assert.match(bad.err(), /--max-bounty must be at least --min-bounty/);
    const sort = io(ENV);
    assert.equal(await run(['tasks', 'list', '--sort', 'oldest'], sort.cli), 2);
    assert.match(sort.err(), /--sort must be one of newest, bounty_desc, deadline_soonest/);
    assert.equal(bad.calls.length + sort.calls.length, 0);
  });

  it('withdraw takes the application id, or a task id (resolved through the task\'s participant view), and prints the echo', async () => {
    const echo = { ok: true, application: { id: UUID_C, task_id: UUID_A, status: 'withdrawn' }, next_step: 'Withdrawn: the Setter no longer sees this application and it no longer counts as your live application on task ' + UUID_A + '. You may apply to the task again while it is open (apply_to_task / POST /v1/tasks/{id}/applications); nothing was charged or held.' };
    const byId = io(ENV_KEY, routes({ [`POST /v1/applications/${UUID_C}/withdraw`]: { json: echo } }));
    assert.equal(await run(['withdraw', UUID_C], byId.cli), 0);
    assert.equal(byId.calls.length, 1);
    assert.match(byId.out(), new RegExp(`^Withdrawn: application ${UUID_C} on task ${UUID_A} \\(withdrawn\\)\\.\nWithdrawn: the Setter no longer sees`));

    const byTask = io(ENV_KEY, routes({
      [`POST /v1/applications/${UUID_A}/withdraw`]: { status: 409, json: { error: { code: 'application_not_pending', message: 'Not pending.', status: 409 } } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: { role: 'applicant', my_application: { id: UUID_C, status: 'pending', task_id: UUID_A }, assignment: null, deliveries: [], review: null, payment: heldPayment, next_step: 'wait', confirm_hint: null, agent_authority: null } } },
      [`POST /v1/applications/${UUID_C}/withdraw`]: { json: { ok: true } },
    }));
    assert.equal(await run(['withdraw', UUID_A, '--json'], byTask.cli), 0);
    assert.deepEqual(byTask.calls.map((c) => `${c.method} ${c.url.pathname}`), [`POST /v1/applications/${UUID_A}/withdraw`, `GET /v1/tasks/${UUID_A}`, `POST /v1/applications/${UUID_C}/withdraw`]);
    const result = JSON.parse(byTask.out());
    assert.deepEqual(result.application, { id: UUID_C, task_id: UUID_A, status: 'withdrawn' }, 'an older deployment answering { ok } gets the echo filled in');
    assert.match(result.next_step, /^Withdrawn: .* apply to the task again while it is open/);

    const none = io(ENV_KEY, routes({
      [`POST /v1/applications/${UUID_B}/withdraw`]: { status: 409, json: { error: { code: 'application_not_pending', message: 'Not pending.', status: 409 } } },
      [`GET /v1/tasks/${UUID_B}`]: { status: 404, json: { error: { code: 'task_not_found', message: 'No task.', status: 404 } } },
    }));
    assert.equal(await run(['withdraw', UUID_B, '--json'], none.cli), 1);
    assert.equal(JSON.parse(none.out()).error.code, 'application_not_found');
    const noKey = io(ENV);
    assert.equal(await run(['withdraw', UUID_C], noKey.cli), 1);
    assert.match(noKey.err(), /BOUNTYMARKET_API_KEY is not set/);
  });

  it('events prints poll_after_seconds next to the cursor when the platform sends it', async () => {
    const t = io(ENV_KEY, routes({ 'GET /v1/events': { json: { events: [], next_after: 12, poll_after_seconds: 45 } } }));
    assert.equal(await run(['events', '--after', '12'], t.cli), 0);
    assert.match(t.out(), /No events\.\nnext_after: 12 \(poll again after 45 s\)/);
    const json = io(ENV_KEY, routes({ 'GET /v1/events': { json: { events: [], next_after: 12 } } }));
    assert.equal(await run(['events', '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), { events: [], next_after: 12, poll_after_seconds: 30 }, 'an older deployment gets the default interval');
  });

  it('tasks list validates --status and --limit before any request', async () => {
    const bad = io(ENV);
    assert.equal(await run(['tasks', 'list', '--status', 'weird'], bad.cli), 2);
    assert.match(bad.err(), /--status must be one of/);
    const limit = io(ENV);
    assert.equal(await run(['tasks', 'list', '--limit', 'ten'], limit.cli), 2);
    assert.match(limit.err(), /--limit must be an integer/);
    assert.equal(bad.calls.length + limit.calls.length, 0);
  });

  it('tasks get works without a key and shows the public task with its website_url', async () => {
    const t = io(ENV, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }));
    assert.equal(await run(['tasks', 'get', UUID_A], t.cli), 0);
    assert.equal(t.calls[0]!.headers.authorization, undefined);
    assert.match(t.out(), /bounty A\$25\.00/);
    assert.ok(t.out().includes(`website_url (the task page, for linking): ${WEBSITE_URL_A}`));
    assert.doesNotMatch(t.out(), /Your role/);
    assert.doesNotMatch(t.out(), /takes no part/);
    const json = io(ENV, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }));
    assert.equal(await run(['tasks', 'get', UUID_A, '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), { task: sampleTask }, 'anonymous: no participant key at all');
  });

  it('tasks get with a key that takes no part in the task says so: participant is present and null', async () => {
    const t = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: null } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], t.cli), 0);
    assert.match(t.out(), /Your key takes no part in this task \(not its Setter, an applicant or its Hunter\): the public listing only\./);
    const json = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: null } } }));
    assert.equal(await run(['tasks', 'get', UUID_A, '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), { task: sampleTask, participant: null });
    // An older deployment that leaves the key out entirely: with credentials the answer is still participant: null.
    const old = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }));
    assert.equal(await run(['tasks', 'get', UUID_A, '--json'], old.cli), 0);
    assert.deepEqual(JSON.parse(old.out()), { task: sampleTask, participant: null });
  });

  it('tasks post requires every field and names the missing one (flag or --from-json field)', async () => {
    const t = io(ENV_KEY);
    const code = await run(['tasks', 'post', '--title', 'Summarise three papers', '--brief', 'x'.repeat(30), '--deliverable', 'doc',
      '--criteria', 'cited', '--category', 'data_research', '--hours', '24'], t.cli);
    assert.equal(code, 2);
    assert.match(t.err(), /--bounty is required \(or "bounty_minor" in --from-json\)/);
    assert.equal(t.calls.length, 0);
  });

  it('tasks post sends the task and prints the platform\'s next_step (review hold) and website_url; no confirm_url when nothing needs a human', async () => {
    const posted = { ...sampleOwnerTask, status: 'pending_review', published_at: null };
    const t = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...posted, next_step: STEP.postedPendingReview } } }));
    assert.equal(await run([...POST_ARGV, '--json'], t.cli), 0);
    assert.equal(t.calls[0]!.headers.authorization, 'Bearer bhk_test_key');
    assert.deepEqual(t.calls[0]!.body, POST_BODY);
    const result = JSON.parse(t.out());
    assert.deepEqual(result, { task: posted, next_step: STEP.postedPendingReview });
    assert.match(result.next_step, /awaits founder review: .*target 24 hours/);
    assert.match(result.next_step, /24-hour delivery clock starts at acceptance, not at posting/);
    assert.match(result.next_step, /follow it at website_url\.$/);

    const human = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...posted, next_step: STEP.postedPendingReview } } }));
    assert.equal(await run(POST_ARGV, human.cli), 0);
    assert.match(human.out(), /Posted task .* \(pending_review\), bounty A\$25\.00\./);
    assert.ok(human.out().includes(`website_url (the task page, for linking): ${WEBSITE_URL_A}`));
    assert.match(human.out(), /awaits founder review/);
    assert.match(human.out(), /No confirm_url: nothing needs a click on the website right now\./);
    assert.doesNotMatch(human.out(), /confirm_url \(one thing/);

    // An older deployment without website_url / next_step: the same rules fill them (website from BOUNTYMARKET_WEB_URL), still no confirm_url.
    const old = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: withoutWebsiteUrl(posted) } }));
    assert.equal(await run([...POST_ARGV, '--json'], old.cli), 0);
    const filled = JSON.parse(old.out());
    assert.equal(filled.task.website_url, WEBSITE_URL_A);
    assert.equal(filled.next_step, STEP.postedPendingReview);
    assert.equal('confirm_url' in filled, false);
    assert.equal('auto_accept_status' in filled, false);
  });

  it('tasks post reads --brief / --deliverable / --criteria from @file and @- (stdin), trimming trailing whitespace', async () => {
    const files: Record<string, string> = { '/tmp/brief.txt': `${sampleTask.brief}\n`, '/tmp/deliverable.txt': `${sampleTask.deliverable}\n\n` };
    const t = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...sampleOwnerTask, next_step: STEP.setterOpen } } }), {
      readFile: (path) => { if (path in files) return files[path]!; throw new Error('ENOENT'); },
      stdin: () => `${sampleTask.acceptance_criteria}\n`,
    });
    const argv = ['tasks', 'post', '--title', sampleTask.title, '--brief', '@/tmp/brief.txt', '--deliverable', '@/tmp/deliverable.txt',
      '--criteria', '@-', '--category', 'data_research', '--bounty', '2500', '--hours', '24', '--json'];
    assert.equal(await run(argv, t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, POST_BODY);

    const missing = io(ENV_KEY, undefined, { readFile: () => { throw new Error('ENOENT: no such file'); } });
    assert.equal(await run([...argv.slice(0, 5), '@/tmp/nope.txt', ...argv.slice(6)], missing.cli), 2);
    assert.match(missing.err(), /cannot read \/tmp\/nope\.txt: ENOENT/);
    assert.equal(missing.calls.length, 0);
  });

  it('tasks post --from-json takes the API fields from a file (or stdin); flags override; bad JSON and missing fields are usage errors', async () => {
    const taskJson = JSON.stringify({ ...POST_BODY, bounty_minor: 1300, delivery_hours: 12, auto_accept: { enabled: true, allow_agents: false } });
    const t = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...sampleOwnerTask, next_step: STEP.setterOpen } } }), {
      readFile: (path) => { if (path === '/tmp/task.json') return taskJson; throw new Error('ENOENT'); },
    });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json', '--bounty', '2500', '--json'], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { ...POST_BODY, bounty_minor: 2500, delivery_hours: 12, auto_accept: { enabled: true, allow_agents: false } });

    const viaStdin = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...sampleOwnerTask, next_step: STEP.setterOpen } } }), { stdin: () => taskJson });
    assert.equal(await run(['tasks', 'post', '--from-json', '-', '--json'], viaStdin.cli), 0);
    assert.equal((viaStdin.calls[0]!.body as Record<string, unknown>).bounty_minor, 1300);

    const bad = io(ENV_KEY, undefined, { readFile: () => '{ not json' });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json'], bad.cli), 2);
    assert.match(bad.err(), /--from-json: \/tmp\/task\.json is not valid JSON/);

    const incomplete = io(ENV_KEY, undefined, { readFile: () => JSON.stringify({ title: sampleTask.title }) });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json'], incomplete.cli), 2);
    assert.match(incomplete.err(), /--brief is required \(or "brief" in --from-json\)/);

    const wrongType = io(ENV_KEY, undefined, { readFile: () => JSON.stringify({ ...POST_BODY, bounty_minor: '2500' }) });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json'], wrongType.cli), 2);
    assert.match(wrongType.err(), /"bounty_minor" in --from-json must be an integer/);
    assert.equal(bad.calls.length + incomplete.calls.length + wrongType.calls.length, 0);
  });

  it('tasks post --dry-run sends validate_only and prints what would be created with the warnings; nothing is posted', async () => {
    const dry = {
      valid: true,
      would_create: {
        ...sampleOwnerTask, id: null, website_url: null, published_at: null, created_at: null, status: 'pending_review',
        auto_accept: { enabled: true, allow_agents: true, min_settled: 0, active: false, confirmed_at: null }, auto_accept_status: 'pending_owner_confirmation',
      },
      warnings: [
        { code: 'listing_will_be_reviewed', message: 'A new Setter\'s first listing is reviewed by the founder before becoming visible: this task would be created as pending_review (target 24 hours, a target, not a guarantee; see capabilities.review).' },
        { code: 'auto_accept_needs_owner_confirmation', message: 'auto_accept was requested by an agent key: it would stay pending_owner_confirmation (nothing automatic) until the account holder confirms with one click at confirm_url.' },
        { code: 'no_saved_card', message: 'The account has no saved card. Posting works, but no application can be accepted (412 payment_method_required).' },
      ],
    };
    const handler = routes({ 'POST /v1/tasks': (call) => ((call.body as Record<string, unknown>).validate_only === true ? { status: 200, json: dry } : { status: 500, json: {} }) });
    const t = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV, '--auto-accept', '--dry-run'], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { ...POST_BODY, auto_accept: { enabled: true }, validate_only: true });
    assert.match(t.out(), /^Dry run: valid; nothing was created\.\n/);
    assert.match(t.out(), /Would create: "Summarise three research papers" as pending_review, bounty A\$25\.00, deliver within 24h, category data_research\./);
    assert.match(t.out(), /Auto-accept: would be requested and stay off until the account holder confirms it on the website\./);
    assert.match(t.out(), /Warnings:\n    listing_will_be_reviewed: A new Setter's first listing is reviewed/);
    assert.match(t.out(), /    no_saved_card: The account has no saved card/);
    assert.doesNotMatch(t.out(), /Posted task/);
    assert.doesNotMatch(t.out(), /Held for a founder check/, 'review_reasons null: no hold line');

    // A dry run of a listing the screen would hold: would_create carries review_reasons and the warning says why.
    const heldDry = {
      valid: true,
      would_create: { ...heldOwnerTask, id: null, website_url: null, created_at: null },
      warnings: [{ code: 'listing_held_for_online_check', message: 'Your listing is held for a founder check because it looks like it may need in-person work (BountyMarket is online-only at launch). If it is online, no action is needed; the founder will release it. The task would be created as pending_review with review_reasons ["offline_task"]; if the work is online, rewording it (for example removing in-person or delivery wording) avoids the hold.' }],
    };
    const held = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 200, json: heldDry } }));
    assert.equal(await run([...POST_ARGV, '--dry-run'], held.cli), 0);
    assert.match(held.out(), /Would create: "Deliver to my office and scan the signed forms" as pending_review/);
    assert.match(held.out(), /Held for a founder check \(BountyMarket is online-only at launch; review_reasons: offline_task\)\. If the work is online, no action is needed; the founder will release it\./);
    assert.match(held.out(), /Warnings:\n    listing_held_for_online_check: Your listing is held for a founder check/);

    const json = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV, '--auto-accept', '--dry-run', '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), dry);

    const refused = io(ENV_KEY, routes({
      'POST /v1/tasks': { status: 422, json: { error: { code: 'bounty_above_new_setter_cap', message: 'New Setters may offer at most A$50.', status: 422 } } },
    }));
    assert.equal(await run([...POST_ARGV.slice(0, -4), '--bounty', '6000', '--hours', '24', '--dry-run'], refused.cli), 1);
    assert.match(refused.err(), /bounty_above_new_setter_cap \(HTTP 422\)/);
  });

  it('tasks auto-accept disable withdraws the opt-in and prints the state-aware next step; confirm_url only when an applicant now waits for the owner', async () => {
    const off = { ...sampleOwnerTask, auto_accept: { enabled: false, allow_agents: true, min_settled: 0, active: false, confirmed_at: null } };
    const quiet = { ...off, participant: { role: 'setter', applications: [], ...emptyParticipant, next_step: STEP.setterOpen, confirm_hint: STEP.setterOpen } };
    const t = io(ENV_KEY, routes({ [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: off }, [`GET /v1/tasks/${UUID_A}`]: { json: quiet } }));
    assert.equal(await run(['tasks', 'auto-accept', 'disable', UUID_A], t.cli), 0);
    assert.equal(t.calls[0]!.method, 'POST');
    assert.equal(t.calls[0]!.url.pathname, `/v1/tasks/${UUID_A}/auto-accept/disable`);
    assert.equal(t.calls[0]!.headers.authorization, 'Bearer bhk_test_key');
    assert.match(t.out(), new RegExp(`Auto-accept is off for task ${UUID_A} \\(open\\)\\.`));
    assert.match(t.out(), /Auto-accept is off\. Open and waiting for applications \(application\.created events\)\. When one arrives the account holder accepts it on the website \(confirm_url is returned then\)/);
    assert.match(t.out(), /No confirm_url: nothing needs a click on the website right now\./);
    const json = io(ENV_KEY, routes({ [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: off }, [`GET /v1/tasks/${UUID_A}`]: { json: quiet } }));
    assert.equal(await run(['tasks', 'auto-accept', 'disable', UUID_A, '--json'], json.cli), 0);
    assert.deepEqual(Object.keys(JSON.parse(json.out())), ['task', 'next_step']);

    const waiting = { ...off, participant: { role: 'setter', applications: [sampleApplication], ...emptyParticipant, next_step: STEP.setterPending, confirm_hint: STEP.setterPending, confirm_url: WEBSITE_URL_A }, confirm_url: WEBSITE_URL_A };
    const pending = io(ENV_KEY, routes({ [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: off }, [`GET /v1/tasks/${UUID_A}`]: { json: waiting } }));
    assert.equal(await run(['tasks', 'auto-accept', 'disable', UUID_A, '--json'], pending.cli), 0);
    const doc = JSON.parse(pending.out());
    assert.deepEqual(Object.keys(doc), ['task', 'confirm_url', 'next_step']);
    assert.equal(doc.confirm_url, WEBSITE_URL_A);
    assert.equal(doc.next_step, `Auto-accept is off. ${STEP.setterPending}`);

    // The view cannot be read back (older deployment): the generic next step, no confirm_url.
    const old = io(ENV_KEY, routes({ [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: withoutWebsiteUrl(off) } }));
    assert.equal(await run(['tasks', 'auto-accept', 'disable', UUID_A, '--json'], old.cli), 0);
    const legacy = JSON.parse(old.out());
    assert.equal(legacy.task.website_url, WEBSITE_URL_A);
    assert.match(legacy.next_step, /^Auto-accept is off\. Pending applications stay pending; the account holder accepts one by hand on the website \(confirm_url is returned while there is one to accept/);
    assert.equal('confirm_url' in legacy, false);

    const noId = io(ENV_KEY);
    assert.equal(await run(['tasks', 'auto-accept', 'disable'], noId.cli), 2);
    assert.match(noId.err(), /takes 1 argument\(s\): <task_id>/);
  });

  it('tasks post --auto-accept sends the opt-in; an agent\'s request prints pending_owner_confirmation and the platform\'s confirm_url', async () => {
    const confirmUrl = `${WEBSITE_URL_A}?confirm=auto_accept`;
    const t = io(ENV_KEY, routes({
      'POST /v1/tasks': {
        status: 201,
        json: {
          ...sampleOwnerTask, bounty_minor: 1300,
          auto_accept: { enabled: true, allow_agents: false, min_settled: 2, active: false, confirmed_at: null },
          auto_accept_status: 'pending_owner_confirmation', confirm_url: confirmUrl, next_step: STEP.setterOpenAwaiting,
        },
      },
    }));
    const argv = ['tasks', 'post', '--title', sampleTask.title, '--brief', sampleTask.brief, '--deliverable', sampleTask.deliverable,
      '--criteria', sampleTask.acceptance_criteria, '--category', 'data_research', '--bounty', '1300', '--hours', '12',
      '--auto-accept', '--auto-accept-min-settled', '2', '--auto-accept-no-agents'];
    assert.equal(await run(argv, t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, {
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable,
      acceptance_criteria: sampleTask.acceptance_criteria, category_code: 'data_research', bounty_minor: 1300, delivery_hours: 12,
      auto_accept: { enabled: true, allow_agents: false, min_settled: 2 },
    });
    assert.match(t.out(), /Auto-accept: requested; it stays off until the account holder confirms it on the website/);
    assert.match(t.out(), /Confirm auto-accept at confirm_url \(one click; auto_accept_status is pending_owner_confirmation/);
    assert.ok(t.out().includes(`${CONFIRM_LABEL}: ${confirmUrl}`), 'prints the confirmation URL with the rule');

    const withoutAutoAccept = argv.slice(0, -4);
    const plain = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...sampleOwnerTask, next_step: STEP.setterOpen } } }));
    assert.equal(await run([...withoutAutoAccept, '--json'], plain.cli), 0);
    assert.equal('auto_accept' in (plain.calls[0]!.body as Record<string, unknown>), false, 'no opt-in without --auto-accept');

    const bare = io(ENV_KEY);
    assert.equal(await run([...withoutAutoAccept, '--auto-accept-min-settled', '2'], bare.cli), 2);
    assert.match(bare.err(), /need --auto-accept/);
    assert.equal(bare.calls.length, 0);
  });

  it('approve, issue and respond act on the task\'s live assignment; approve prints who approved and the one payment shape', async () => {
    const setterTask = { ...sampleOwnerTask, status: 'delivered', participant: { role: 'setter', applications: [], assignment: sampleAssignment } };
    const a = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: setterTask },
      [`POST /v1/assignments/${UUID_B}/approve`]: { json: { ...approvedReview, payment: capturedPayment, next_step: STEP.approved } },
    }));
    assert.equal(await run(['approve', UUID_A], a.cli), 0);
    assert.equal(a.calls.length, 2, 'the platform answers with the payment: no assignment round trip');
    assert.equal(a.calls[1]!.method, 'POST');
    assert.equal(a.calls[1]!.url.pathname, `/v1/assignments/${UUID_B}/approve`);
    assert.equal(a.calls[1]!.body, null);
    assert.match(a.out(), new RegExp(`Approved: review ${UUID_D} \\(approved\\), approved by the Setter's agent; task approved, assignment completed\\.`));
    assert.match(a.out(), /Payment: status captured, authorised \(held\) A\$25\.00, captured A\$25\.00, Hunter's fee A\$3\.75, Hunter's net A\$21\.25 \(the Setter pays no fee; the net is before Stripe's own fee and lands in the Hunter's Stripe balance\)/);
    assert.match(a.out(), /Approved: A\$25\.00 captured; nothing more is charged\./);
    assert.doesNotMatch(a.out(), /application_fee_minor|amount_minor/);

    const raised = { ...sampleReview, status: 'issue_raised', issue_type: 'acceptance_mismatch', hunter_response_deadline_at: '2026-10-07T00:00:00.000Z' };
    const i = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: setterTask },
      [`POST /v1/assignments/${UUID_B}/issues`]: { status: 201, json: raised },
    }));
    assert.equal(await run(['issue', UUID_A, '--type', 'acceptance_mismatch', '--text', 'The document is one page and skips the third paper.', '--json'], i.cli), 0);
    assert.deepEqual(i.calls[1]!.body, { issue_type: 'acceptance_mismatch', detail: 'The document is one page and skips the third paper.' });
    assert.equal(JSON.parse(i.out()).review.status, 'issue_raised');
    assert.match(JSON.parse(i.out()).next_step, /hunter_response_deadline_at/);

    const fromFile = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: setterTask },
      [`POST /v1/assignments/${UUID_B}/issues`]: { status: 201, json: raised },
    }), { readFile: () => 'The document is one page and skips the third paper.\n' });
    assert.equal(await run(['issue', UUID_A, '--type', 'acceptance_mismatch', '--text-file', '/tmp/issue.txt'], fromFile.cli), 0);
    // --text-file keeps the bytes as given (2026-10-15.12, like --summary-file): the trailing newline is sent.
    assert.deepEqual(fromFile.calls[1]!.body, { issue_type: 'acceptance_mismatch', detail: 'The document is one page and skips the third paper.\n' });

    const badType = io(ENV_KEY);
    assert.equal(await run(['issue', UUID_A, '--type', 'meh', '--text', 'x'.repeat(20)], badType.cli), 2);
    assert.match(badType.err(), /--type must be one of quality_issue/);
    assert.equal(badType.calls.length, 0);
    const noText = io(ENV_KEY);
    assert.equal(await run(['issue', UUID_A, '--type', 'quality_issue'], noText.cli), 2);
    assert.match(noText.err(), /--text or --text-file is required/);

    const answered = { ...sampleReview, status: 'issue_raised', hunter_response: 'Page 2 covers the third paper.' };
    const r = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'issue_raised', participant: { role: 'hunter', application: null, assignment: sampleAssignment } } },
      [`POST /v1/assignments/${UUID_B}/issue-response`]: { json: answered },
    }));
    assert.equal(await run(['respond', UUID_A, '--text', 'Page 2 covers the third paper.'], r.cli), 0);
    assert.deepEqual(r.calls[1]!.body, { text: 'Page 2 covers the third paper.' });
    assert.match(r.out(), /Response recorded: review .* \(issue_raised\)/);

    const viaStdin = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'issue_raised', participant: { role: 'hunter', application: null, assignment: sampleAssignment } } },
      [`POST /v1/assignments/${UUID_B}/issue-response`]: { json: answered },
    }), { stdin: () => 'Page 2 covers the third paper.\n\nSee the heading "Paper 3".\n' });
    assert.equal(await run(['respond', UUID_A, '--text-file', '-'], viaStdin.cli), 0);
    assert.deepEqual(viaStdin.calls[1]!.body, { text: 'Page 2 covers the third paper.\n\nSee the heading "Paper 3".\n' });

    // withdraw-issue (2026-10-15.16): the Setter's door; the platform echoes the resumed review, statuses, payment and next_step.
    const withdrawn = {
      ...sampleReview, status: 'pending', issue_type: 'acceptance_mismatch', hunter_response: 'Page 2 covers the third paper.',
      issue_withdrawn_at: '2026-10-06T13:00:00.000Z', issue_closed_as: 'withdrawn_after_response', review_deadline_at: '2026-10-07T13:00:00.000Z',
      assignment: { id: UUID_B, status: 'delivered' }, task: { id: UUID_A, status: 'delivered' },
      payment: { status: 'held', authorised_minor: 2500, captured_minor: 0, refunded_minor: 0, hunter_fee_minor: 375, hunter_net_minor: 2125, currency: 'AUD' },
      next_step: 'Issue withdrawn after the Hunter\'s response; the review is pending again until 2026-10-07T13:00:00.000Z (at least 24 hours from now). Approve with approve_delivery (captures exactly the A$25.00 authorised at acceptance) or raise_issue again before then; silence auto-confirms. Nothing is captured meanwhile.',
    };
    const w = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...setterTask, status: 'issue_raised' } },
      [`POST /v1/assignments/${UUID_B}/issues/withdraw`]: { json: withdrawn },
    }));
    assert.equal(await run(['withdraw-issue', UUID_A], w.cli), 0);
    assert.equal(w.calls.length, 2, 'the platform echoes everything: no read-back');
    assert.equal(w.calls[1]!.method, 'POST');
    assert.equal(w.calls[1]!.url.pathname, `/v1/assignments/${UUID_B}/issues/withdraw`);
    assert.equal(w.calls[1]!.body, null);
    assert.match(w.out(), new RegExp(`Issue withdrawn: review ${UUID_D} \\(pending, withdrawn_after_response\\); review deadline 2026-10-07T13:00:00\\.000Z; task delivered, assignment delivered\\.`));
    assert.match(w.out(), /Payment: status held, authorised \(held\) A\$25\.00/);
    assert.match(w.out(), /Issue withdrawn after the Hunter's response; the review is pending again until 2026-10-07T13:00:00\.000Z/);
    const wj = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...setterTask, status: 'issue_raised' } },
      [`POST /v1/assignments/${UUID_B}/issues/withdraw`]: { json: { ...sampleReview, status: 'pending', issue_closed_as: 'withdrawn' } },
    }));
    assert.equal(await run(['withdraw-issue', UUID_A, '--json'], wj.cli), 0);
    const wjDoc = JSON.parse(wj.out());
    // An older deployment answers with the bare review: the statuses are what a withdrawal leaves behind, the step the fallback.
    assert.deepEqual(wjDoc.assignment, { id: UUID_B, status: 'delivered' });
    assert.deepEqual(wjDoc.task, { id: UUID_A, status: 'delivered' });
    assert.match(wjDoc.next_step, /^Issue withdrawn; the review is pending again until review_deadline_at/);
    assert.equal(wjDoc.review.issue_closed_as, 'withdrawn');

    const none = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }));
    assert.equal(await run(['approve', UUID_A], none.cli), 1);
    assert.match(none.err(), /assignment_not_found \(HTTP 404\)/);
    assert.match(none.err(), /no live assignment/);
    assert.equal(none.calls.length, 1);
  });

  it('approve against an older deployment folds the former payment block into the one shape and words the next step with the amount', async () => {
    const setterTask = { ...sampleOwnerTask, status: 'delivered', participant: { role: 'setter', applications: [], assignment: sampleAssignment } };
    const bare = { ...sampleReview, status: 'approved', approved_at: '2026-10-06T00:00:00.000Z' };
    const { approved_by: _by, ...legacyReview } = bare;
    const legacyPayment = { status: 'captured', amount_minor: 2500, application_fee_minor: 375, captured_minor: 2500, refunded_minor: 0, capture_before_at: null, currency: 'AUD' };
    const a = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: setterTask },
      [`POST /v1/assignments/${UUID_B}/approve`]: { json: legacyReview },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: { ...sampleAssignment, status: 'completed' }, task: sampleTask, deliveries: [sampleDelivery], review: legacyReview, payment: legacyPayment } },
    }));
    assert.equal(await run(['approve', UUID_A, '--json'], a.cli), 0);
    const result = JSON.parse(a.out());
    assert.deepEqual(result.payment, capturedPayment);
    assert.equal(result.review.approved_by, null, 'approved_by is present (null) even when the deployment did not send it');
    assert.equal(result.next_step, STEP.approved);
  });

  it('write commands refuse to run without BOUNTYMARKET_API_KEY and make no request', async () => {
    for (const argv of [['apply', UUID_A], ['deliver', UUID_B, '--summary', 'done'], ['events'], ['events', '--task', UUID_A], ['me'], ['tasks', 'mine'], ['assignments'],
      ['tasks', 'auto-accept', 'disable', UUID_A],
      ['approve', UUID_A], ['issue', UUID_A, '--type', 'quality_issue', '--text', 't'.repeat(20)], ['respond', UUID_A, '--text', 'x'], ['withdraw-issue', UUID_A],
      ['tasks', 'cancel', UUID_A], ['cancel-request', UUID_A],
      ['tasks', 'post', '--title', 'tttttttt', '--brief', 'b'.repeat(20), '--deliverable', 'd', '--criteria', 'c', '--category', 'other', '--bounty', '1000', '--hours', '1'],
      ['tasks', 'post', '--dry-run', '--from-json', '/tmp/task.json']]) {
      const t = io(ENV);
      assert.equal(await run(argv, t.cli), 1, argv.join(' '));
      assert.match(t.err(), /BOUNTYMARKET_API_KEY is not set/);
      assert.equal(t.calls.length, 0);
    }
  });

  it('tasks mine and assignments list the owner\'s side with a count in --json', async () => {
    const mine = io(ENV_KEY, routes({ 'GET /v1/me/tasks': { json: { tasks: [{ ...sampleTask, status: 'pending_review' }] } } }));
    assert.equal(await run(['tasks', 'mine', '--json'], mine.cli), 0);
    assert.equal(mine.calls[0]!.headers.authorization, 'Bearer bhk_test_key');
    assert.deepEqual(JSON.parse(mine.out()), { tasks: [{ ...sampleTask, status: 'pending_review', pending_owner_action: null }], count: 1 });

    const asg = io(ENV_KEY, routes({
      'GET /v1/me/assignments': { json: { assignments: [{ ...sampleAssignment, task: { id: UUID_A, title: sampleTask.title, status: 'assigned', category_code: 'data_research' } }] } },
    }));
    assert.equal(await run(['assignments'], asg.cli), 0);
    assert.match(asg.out(), /15%/);
    assert.match(asg.out(), /A\$21\.25/);
    assert.match(asg.out(), /Summarise three research papers/);
    assert.doesNotMatch(asg.out(), /fee holiday/);

    // A contract accepted during a fee holiday: 0% fee, net = bounty, and the row says why.
    const holiday = io(ENV_KEY, routes({
      'GET /v1/me/assignments': { json: { assignments: [{ ...holidayAssignment, task: { id: UUID_A, title: sampleTask.title, status: 'assigned', category_code: 'data_research' } }] } },
    }));
    assert.equal(await run(['assignments'], holiday.cli), 0);
    assert.match(holiday.out(), /0% \(fee holiday\)\s+A\$25\.00/);
  });

  it('tasks cancel and cancel-request (platform 2026-11-10) print the outcome and the platform\'s next_step; tasks mine names the owner\'s pending click', async () => {
    const DONE = 'Cancelled: the task is off the board, pending applications are closed and no money moved. Posting a new task is post_task / POST /v1/tasks.';
    const c = io(ENV_KEY, routes({ [`POST /v1/tasks/${UUID_A}/cancel`]: { json: { ...sampleTask, status: 'cancelled', already_cancelled: false, next_step: DONE } } }));
    assert.equal(await run(['tasks', 'cancel', UUID_A], c.cli), 0);
    assert.match(c.out(), new RegExp(`Cancelled task ${UUID_A} \\(cancelled\\)\\.`));
    assert.match(c.out(), /no money moved/);

    const r = io(ENV_KEY, routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'assigned', participant: { role: 'hunter', my_application: null, assignment: sampleAssignment, cancellation_requested_by: null } } },
      [`POST /v1/assignments/${sampleAssignment.id}/cancellation/request`]: { json: { ok: true } },
    }));
    assert.equal(await run(['cancel-request', UUID_A, '--json'], r.cli), 0);
    const doc = JSON.parse(r.out());
    assert.equal(doc.requested_by, 'hunter');
    assert.match(doc.next_step, /Nothing changes until the Setter's account holder confirms on the website, a human click/);

    const mine = io(ENV_KEY, routes({ 'GET /v1/me/tasks': { json: { tasks: [{ ...sampleTask, work: { pending_applications: 1, hunter: null, review_deadline_at: null } }] } } }));
    assert.equal(await run(['tasks', 'mine'], mine.cli), 0);
    assert.match(mine.out(), new RegExp(`Account holder action on ${UUID_A}: accept_applicant at https://web\\.test/task/${UUID_A}`));
  });

  it('tasks post for a listing the screen held for an online-only check prints the hold with review_reasons; the platform\'s next_step passes through and an older deployment gets the same words', async () => {
    const heldArgv = POST_ARGV.map((arg, i) => (POST_ARGV[i - 1] === '--title' ? heldOwnerTask.title : arg));
    const t = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: { ...heldOwnerTask, next_step: STEP.postedHeldForOnlineCheck } } }));
    assert.equal(await run(heldArgv, t.cli), 0);
    assert.match(t.out(), /Posted task .* \(pending_review\), bounty A\$25\.00\./);
    assert.match(t.out(), /Held for a founder check \(BountyMarket is online-only at launch; review_reasons: offline_task\)\. If the work is online, no action is needed; the founder will release it\./);
    assert.match(t.out(), /Your listing is held for a founder check because it looks like it may need in-person work/);
    assert.match(t.out(), /No confirm_url: nothing needs a click on the website right now\./);

    const old = io(ENV_KEY, routes({ 'POST /v1/tasks': { status: 201, json: withoutWebsiteUrl(heldOwnerTask) } }));
    assert.equal(await run([...POST_ARGV, '--json'], old.cli), 0);
    const filled = JSON.parse(old.out());
    assert.equal(filled.next_step, STEP.postedHeldForOnlineCheck);
    assert.deepEqual(filled.task.review_reasons, ['offline_task']);
    assert.equal('confirm_url' in filled, false);

    const get = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...heldOwnerTask, participant: { role: 'setter', applications: [], ...emptyParticipant, next_step: STEP.postedHeldForOnlineCheck, confirm_hint: STEP.postedHeldForOnlineCheck } } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], get.cli), 0);
    assert.match(get.out(), /Held for a founder check \(BountyMarket is online-only at launch; review_reasons: offline_task\)/);
    assert.match(get.out(), /Next step: Your listing is held for a founder check/);
  });

  it('apply posts the optional message and prints the auto-accept outcome with the matching next step', async () => {
    const skipped = { ...sampleApplication, auto_accept_skipped_reason: 'agents_not_eligible' };
    const t = io(ENV_KEY, routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...skipped, assignment: null, auto_accept_outcome: 'agents_not_eligible', next_step: STEP.applicantNotEligible } },
    }));
    assert.equal(await run(['apply', UUID_A, '--message', 'I am an AI agent acting for Bob.'], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { message: 'I am an AI agent acting for Bob.' });
    assert.match(t.out(), new RegExp(`Applied: application ${UUID_C} \\(pending\\); auto_accept_outcome agents_not_eligible\\.`));
    assert.match(t.out(), /does not include AI agents \(auto_accept\.allow_agents is false\)/);
    assert.doesNotMatch(t.out(), /Assignment /);

    const accepted = { ...sampleApplication, status: 'accepted', decided_at: '2026-10-05T02:00:00.000Z' };
    const auto = io(ENV_KEY, routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...accepted, assignment: sampleAssignment, auto_accept_outcome: 'accepted', next_step: 'Accepted automatically: deliver before the deadline.' } },
    }));
    assert.equal(await run(['apply', UUID_A], auto.cli), 0);
    assert.deepEqual(auto.calls[0]!.body, {});
    assert.match(auto.out(), /auto_accept_outcome accepted\./);
    assert.match(auto.out(), new RegExp(`Assignment ${UUID_B}: deliver before 2026-10-06T02:00:00\\.000Z, net A\\$21\\.25 \\(before Stripe's own fee\\)\\.`));
    // Accepted at once: the hold is printed too (folded from the assignment's locked fee when an older deployment omits payment).
    assert.match(auto.out(), /Payment: status held, authorised \(held\) A\$25\.00, captured A\$0\.00, Hunter's fee A\$3\.75, Hunter's net A\$21\.25/);
    const json = io(ENV_KEY, routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...accepted, assignment: sampleAssignment, auto_accept_outcome: 'accepted', next_step: 'Accepted automatically: deliver before the deadline.' } },
    }));
    assert.equal(await run(['apply', UUID_A, '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), { application: accepted, assignment: sampleAssignment, auto_accept_outcome: 'accepted', payment: heldPayment, next_step: 'Accepted automatically: deliver before the deadline.' });
    // The platform's own payment block (2026-10-11.6) passes through as is.
    const withPayment = io(ENV_KEY, routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...accepted, assignment: sampleAssignment, auto_accept_outcome: 'accepted', payment: heldPayment, next_step: 'Accepted automatically: deliver before the deadline.' } },
    }));
    assert.equal(await run(['apply', UUID_A, '--json'], withPayment.cli), 0);
    assert.deepEqual(JSON.parse(withPayment.out()).payment, heldPayment);
    assert.equal('payment' in JSON.parse(json.out()), true);
  });

  it('tasks get shows the auto-accept terms and, for the Setter, the owner\'s one click as confirm_url', async () => {
    const pending = { ...sampleOwnerTask, auto_accept: { enabled: true, allow_agents: false, min_settled: 1, active: false, confirmed_at: null } };
    const confirmUrl = `${WEBSITE_URL_A}?confirm=auto_accept`;
    const participant = { role: 'setter', applications: [], ...emptyParticipant, next_step: STEP.setterOpenAwaiting, confirm_hint: STEP.setterOpenAwaiting, confirm_url: confirmUrl, auto_accept_status: 'pending_owner_confirmation', auto_accept_confirm_url: confirmUrl };
    const t = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...pending, participant, confirm_url: confirmUrl } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], t.cli), 0);
    assert.match(t.out(), /auto-accept requested, awaiting the account holder's confirmation \(agents not allowed, min settled tasks 1\)/);
    assert.match(t.out(), /Assignment: none yet\nDeliveries: 0\nReview: none\nPayment: status none, authorised \(held\) A\$0\.00, captured A\$0\.00, Hunter's fee A\$0\.00, Hunter's net A\$0\.00 \(the Setter pays no fee; the net is before Stripe's own fee and lands in the Hunter's Stripe balance\)/);
    assert.match(t.out(), /Next step: Confirm auto-accept at confirm_url \(one click; auto_accept_status is pending_owner_confirmation/);
    assert.ok(t.out().includes(`${CONFIRM_LABEL}: ${confirmUrl}`));
    assert.ok(t.out().includes(`auto_accept_confirm_url (the account holder confirms auto-accept here): ${confirmUrl}`));
  });

  it('tasks get for the Setter lists each application with its skipped reason, the held amount with the Hunter\'s fee, and confirm_url only while an applicant waits', async () => {
    const skipped = { ...sampleApplication, auto_accept_skipped_reason: 'agents_not_eligible' };
    const participant = { role: 'setter', applications: [skipped], ...emptyParticipant, next_step: STEP.setterSkipped, confirm_hint: STEP.setterSkipped, confirm_url: WEBSITE_URL_A };
    const t = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, participant, confirm_url: WEBSITE_URL_A } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], t.cli), 0);
    assert.match(t.out(), new RegExp(`Applications: 1\\n\\s+${UUID_C}  pending  agent  not auto-accepted: agents_not_eligible`));
    assert.match(t.out(), /Next step: 1 pending application did not qualify for auto-accept \(agents_not_eligible\); accept manually at confirm_url/);
    assert.ok(t.out().includes(`${CONFIRM_LABEL}: ${WEBSITE_URL_A}`));

    const accepted = { ...sampleApplication, status: 'accepted' };
    const working = { role: 'setter', applications: [accepted], assignment: sampleAssignment, deliveries: [], review: null, payment: heldPayment, next_step: STEP.setterAssigned, confirm_hint: STEP.setterAssigned };
    const held = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'assigned', participant: working } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], held.cli), 0);
    assert.match(held.out(), /Payment: status held, authorised \(held\) A\$25\.00, captured A\$0\.00, Hunter's fee A\$3\.75, Hunter's net A\$21\.25 \(the Setter pays no fee; the net is before Stripe's own fee and lands in the Hunter's Stripe balance\)/);
    assert.match(held.out(), new RegExp(`Assignment: ${UUID_B} \\(active\\), deadline 2026-10-06T02:00:00\\.000Z, net A\\$21\\.25`));
    assert.match(held.out(), /No confirm_url: nothing needs a click on the website right now \(link with website_url\)\./);
    assert.doesNotMatch(held.out(), /confirm_url \(one thing/);

    const settled = { ...working, deliveries: [sampleDelivery], review: approvedReview, payment: capturedPayment, next_step: STEP.setterSettled, confirm_hint: STEP.setterSettled };
    const done = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'approved', participant: settled } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], done.cli), 0);
    assert.match(done.out(), /Review: approved \(approved by the Setter's agent\), deadline 2026-10-08T02:00:00\.000Z/);
    assert.match(done.out(), /Payment: status captured, authorised \(held\) A\$25\.00, captured A\$25\.00, Hunter's fee A\$3\.75, Hunter's net A\$21\.25/);
    assert.match(done.out(), /No confirm_url/);

    const applicant = { role: 'applicant', my_application: skipped, ...emptyParticipant, next_step: STEP.applicantNotEligible, confirm_hint: STEP.applicantNotEligible };
    const mine = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: applicant } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], mine.cli), 0);
    assert.match(mine.out(), new RegExp(`Your application: ${UUID_C} \\(pending; not auto-accepted: agents_not_eligible\\)`));
    assert.doesNotMatch(mine.out(), /confirm_url \(one thing/, 'an applicant has nothing to do on the website');
    assert.match(mine.out(), /No confirm_url/);
  });

  it('deliver collects repeated --link flags, prints the payment and reads the digest back from the assignment', async () => {
    const t = io(ENV_KEY, routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [sampleDelivery], review: sampleReview, payment: heldPayment } },
    }));
    assert.equal(await run(['deliver', UUID_B, '--summary', 'Done: summary attached.', '--link', 'https://a.test', '--link', 'https://b.test', '--json'], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { summary: 'Done: summary attached.', links: ['https://a.test', 'https://b.test'] });
    const result = JSON.parse(t.out());
    // An older deployment without the write-op echo (2026-10-15.12): the delivery, assignment and task come from the read-back.
    assert.deepEqual(result, {
      assignment_id: UUID_B, review: sampleReview, content_digest: 'sha256:abc',
      delivery: sampleDelivery, assignment: { id: UUID_B, status: 'active' }, task: { id: UUID_A, status: 'open' },
      payment: heldPayment, next_step: STEP.delivered,
    });
    assert.match(result.next_step, /A\$21\.25 \(the A\$25\.00 held at acceptance less your A\$3\.75 platform fee, before Stripe's own processing fee\)/);

    const human = io(ENV_KEY, routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [sampleDelivery], review: sampleReview, payment: heldPayment } },
    }));
    assert.equal(await run(['deliver', UUID_B, '--summary', 'Done: summary attached.'], human.cli), 0);
    assert.match(human.out(), /Payment: status held, authorised \(held\) A\$25\.00, captured A\$0\.00, Hunter's fee A\$3\.75, Hunter's net A\$21\.25/);
  });

  it('deliver reads the summary from --summary-file or stdin (-), and insists on exactly one of --summary and --summary-file', async () => {
    const handler = routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
    });
    const long = 'Paragraph one, with "quotes".\n\nParagraph two.\n';
    const file = io(ENV_KEY, handler, { readFile: (path) => { if (path === '/tmp/summary.md') return long; throw new Error('ENOENT'); } });
    assert.equal(await run(['deliver', UUID_B, '--summary-file', '/tmp/summary.md', '--link', 'https://a.test'], file.cli), 0);
    // 2026-10-15.12: the file's bytes are sent as given, trailing newline included, so a digest computed over the file matches content_digest.
    assert.deepEqual(file.calls[0]!.body, { summary: 'Paragraph one, with "quotes".\n\nParagraph two.\n', links: ['https://a.test'] });

    const stdin = io(ENV_KEY, handler, { stdin: () => long });
    assert.equal(await run(['deliver', UUID_B, '--summary-file', '-'], stdin.cli), 0);
    assert.deepEqual(stdin.calls[0]!.body, { summary: 'Paragraph one, with "quotes".\n\nParagraph two.\n', links: [] });

    const both = io(ENV_KEY, handler, { readFile: () => long });
    assert.equal(await run(['deliver', UUID_B, '--summary', 'x', '--summary-file', '/tmp/summary.md'], both.cli), 2);
    assert.match(both.err(), /give either --summary or --summary-file, not both/);
    const neither = io(ENV_KEY, handler);
    assert.equal(await run(['deliver', UUID_B], neither.cli), 2);
    assert.match(neither.err(), /--summary or --summary-file is required/);
    const unreadable = io(ENV_KEY, handler, { readFile: () => { throw new Error('EACCES: permission denied'); } });
    assert.equal(await run(['deliver', UUID_B, '--summary-file', '/tmp/secret.md'], unreadable.cli), 2);
    assert.match(unreadable.err(), /cannot read \/tmp\/secret\.md: EACCES/);
    assert.equal(both.calls.length + neither.calls.length + unreadable.calls.length, 0);
  });

  it('deliver --attach (repeatable) sends attachment_ids with the summary and links; the ids are checked locally before any request', async () => {
    const handler = routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [{ ...sampleDelivery, attachments: [sampleAttachment], content_digest: 'sha256:withfiles' }], review: sampleReview, payment: heldPayment } },
    });
    const t = io(ENV_KEY, handler);
    assert.equal(await run(['deliver', UUID_B, '--summary', 'Done.', '--link', 'https://a.test', '--attach', UUID_FILE, '--attach', UUID_FILE_2, '--json'], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { summary: 'Done.', links: ['https://a.test'], attachment_ids: [UUID_FILE, UUID_FILE_2] });
    const result = JSON.parse(t.out());
    assert.equal(result.content_digest, 'sha256:withfiles', 'the digest covers the attachment ids');
    assert.deepEqual(Object.keys(result), ['assignment_id', 'review', 'content_digest', 'delivery', 'assignment', 'task', 'payment', 'next_step'], 'the hosted result shape (with the 2026-10-15.12 echo)');

    const plain = io(ENV_KEY, handler);
    assert.equal(await run(['deliver', UUID_B, '--summary', 'Done.'], plain.cli), 0);
    assert.deepEqual(plain.calls[0]!.body, { summary: 'Done.', links: [] }, 'without --attach the body is unchanged');

    const bad = io(ENV_KEY, handler);
    assert.equal(await run(['deliver', UUID_B, '--summary', 'Done.', '--attach', 'nope'], bad.cli), 2);
    assert.match(bad.err(), /--attach must be a file id from "bountymarket upload --assignment <id> <path>" \(uuid\), got "nope"/);
    const many = io(ENV_KEY, handler);
    const argv = ['deliver', UUID_B, '--summary', 'Done.'];
    for (let i = 0; i < 11; i++) argv.push('--attach', UUID_FILE);
    assert.equal(await run(argv, many.cli), 2);
    assert.match(many.err(), /--attach may be given at most 10 times/);
    assert.equal(bad.calls.length + many.calls.length, 0);
  });

  it('tasks post --attach (or attachment_ids in --from-json) sends attachment_ids; the posted task lists its brief files', async () => {
    const handler = routes({ 'POST /v1/tasks': { status: 201, json: { ...sampleOwnerTask, attachments: [sampleBriefFile], next_step: STEP.setterOpen } } });
    const t = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV, '--attach', UUID_FILE_2], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { ...POST_BODY, attachment_ids: [UUID_FILE_2] });
    assert.match(t.out(), new RegExp(`Posted task ${UUID_A} \\(open\\), bounty A\\$25\\.00\\.\\nBrief files \\(1\\):\\n    ${UUID_FILE_2}  papers\\.zip \\(3 bytes, application/zip\\)\\n`));

    const taskJson = JSON.stringify({ ...POST_BODY, attachment_ids: [UUID_FILE_2] });
    const fromJson = io(ENV_KEY, handler, { readFile: () => taskJson });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json'], fromJson.cli), 0);
    assert.deepEqual(fromJson.calls[0]!.body, { ...POST_BODY, attachment_ids: [UUID_FILE_2] });
    const override = io(ENV_KEY, handler, { readFile: () => taskJson });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json', '--attach', UUID_FILE], override.cli), 0);
    assert.deepEqual((override.calls[0]!.body as Record<string, unknown>).attachment_ids, [UUID_FILE], '--attach overrides the file');

    const bad = io(ENV_KEY, handler, { readFile: () => JSON.stringify({ ...POST_BODY, attachment_ids: ['nope'] }) });
    assert.equal(await run(['tasks', 'post', '--from-json', '/tmp/task.json'], bad.cli), 2);
    assert.match(bad.err(), /"attachment_ids" in --from-json must be an array of file ids \(uuid\) from "bountymarket upload <path>"/);
    const badFlag = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV, '--attach', 'nope'], badFlag.cli), 2);
    assert.match(badFlag.err(), /--attach must be a file id from "bountymarket upload <path>" \(uuid\), got "nope"/);
    assert.equal(bad.calls.length + badFlag.calls.length, 0);
  });

  it('deliver accepts the task id instead of the assignment id; a miss prints the platform\'s tailored hint', async () => {
    const t = io(ENV_KEY, routes({
      [`POST /v1/assignments/${UUID_A}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [sampleDelivery], review: sampleReview, payment: heldPayment } },
    }));
    assert.equal(await run(['deliver', UUID_A, '--summary', 'Done.'], t.cli), 0);
    assert.equal(t.calls[0]!.url.pathname, `/v1/assignments/${UUID_A}/deliveries`);
    assert.match(t.out(), new RegExp(`Delivered: assignment ${UUID_B}, review ${sampleReview.id} \\(pending\\)`));

    const message = `deliver needs an assignment: pass assignment_id (from list_my_assignments, GET /v1/me/assignments or the assignment.created event) or task_id of a task where you are the accepted Hunter. No live assignment for you on task ${UUID_A}. Your application ${UUID_C} on this task is still pending: the Setter has not accepted it yet (watch get_events for assignment.created).`;
    const miss = io(ENV_KEY, routes({
      [`POST /v1/assignments/${UUID_A}/deliveries`]: { status: 404, json: { error: { code: 'assignment_not_found', message, status: 404, details: { assignment_id: null, task_id: UUID_A, pending_application_id: UUID_C } } } },
    }));
    assert.equal(await run(['deliver', UUID_A, '--summary', 'Done.'], miss.cli), 1);
    assert.match(miss.err(), /assignment_not_found \(HTTP 404\)/);
    assert.match(miss.err(), /Your application .* is still pending/);
    assert.match(miss.err(), /"pending_application_id":"33333333-3333-4333-8333-333333333333"/);
    assert.match(miss.err(), /deliver takes the assignment id \(from "bountymarket assignments" or the assignment\.created event\) or the id of a task where your account is the accepted Hunter/);
  });

  it('events passes the cursor, the optional --task filter, and prints next_after', async () => {
    const events = [{ seq: 41, id: 'e1', type: 'application.created', task_id: UUID_A, assignment_id: null, actor_kind: 'agent', visibility: 'participants', payload: { application_id: UUID_C, auto_accept_outcome: 'accepted' }, created_at: '2026-10-05T03:00:00.000Z' }];
    const t = io(ENV_KEY, routes({ 'GET /v1/events': { json: { events, next_after: 41 } } }));
    assert.equal(await run(['events', '--after', '40', '--limit', '5'], t.cli), 0);
    assert.equal(t.calls[0]!.url.search, '?after=40&limit=5');
    assert.match(t.out(), /application\.created/);
    assert.match(t.out(), /next_after: 41/);

    const one = io(ENV_KEY, routes({ 'GET /v1/events': { json: { events, next_after: 41 } } }));
    assert.equal(await run(['events', '--after', '40', '--limit', '5', '--task', UUID_A, '--json'], one.cli), 0);
    assert.equal(one.calls[0]!.url.search, `?after=40&limit=5&task_id=${UUID_A}`);
    assert.equal(JSON.parse(one.out()).events[0].payload.auto_accept_outcome, 'accepted');

    const bad = io(ENV_KEY);
    assert.equal(await run(['events', '--task', 'nope'], bad.cli), 2);
    assert.match(bad.err(), /--task must be a task id \(uuid\)/);
    assert.equal(bad.calls.length, 0);
  });

  it('me prints the owner and the agent authority', async () => {
    const me = {
      id: 'u1', display_name: 'Ada', country_code: 'AU', terms_version: 'v1', terms_accepted_at: '2026-10-01T00:00:00.000Z',
      over_18_attested_at: '2026-10-01T00:00:00.000Z', is_admin: false, status: 'active', created_at: '2026-10-01T00:00:00.000Z',
      agent: { id: 'a1', display_name: 'Ada Bot', api_key_prefix: 'bhk_abcd', setter_mode: 'always', hunter_mode: 'deny', status: 'active', created_at: null, last_used_at: null },
      terms_current_version: 'v1', terms_current_accepted: true, hunter_account: null, payment_method_count: 1,
    };
    const t = io(ENV_KEY, routes({ 'GET /v1/me': { json: me } }));
    assert.equal(await run(['me'], t.cli), 0);
    assert.match(t.out(), /Ada Bot \(bhk_abcd\.\.\.\) setter_mode always, hunter_mode deny/);
    assert.match(t.out(), /Hunter account: not onboarded/);
    assert.doesNotMatch(t.out(), /bhk_test_key/);
    assert.doesNotMatch(t.out(), /Active assignments:/, 'an older deployment without the limits prints none');
    // The limits before they bite (platform 2026-10-15.3).
    const limits = {
      ...me, hunter_active_assignments: 1, hunter_max_active_assignments: 2, hunter_active_assignment_ids: [UUID_A],
      setter_daily_cap_minor: 20000, setter_daily_used_minor: 18500, setter_daily_posts_limit: 20, setter_daily_posts_used: 3,
      setter_daily_resets_at: '2026-10-16T00:00:00.000Z', setter_is_new: true, new_setter_task_cap_minor: 5000, max_task_bounty_minor: 10000,
    };
    const l = io(ENV_KEY, routes({ 'GET /v1/me': { json: limits } }));
    assert.equal(await run(['me'], l.cli), 0);
    assert.match(l.out(), new RegExp(`Active assignments: 1 of 2 \\(${UUID_A}\\); delivered ones count until the Setter settles\\.`));
    assert.match(l.out(), /Posting today: A\$15\.00 of A\$200\.00 left, 3 of 20 listings used; resets 2026-10-16T00:00:00\.000Z\./);
    assert.match(l.out(), /New Setter: the next listing is capped at A\$50\.00 and is read by a person before it goes live, normally within 24 hours\./);
    assert.doesNotMatch(l.out(), /Trust preview/, 'an older deployment without me.trust prints none');
    // Trust preview (platform 2026-10-18.1, shadow): display only, one line, nothing enforced.
    const ladder = (side: 'hunter' | 'setter', tier: string) => ({
      side, seasoned_minor: 0, tier, tier_rank: 1, money_tier: tier, time_gate_ok: true, time_gate_days: 0, gate_clears_at: null, account_age_days: 8,
      next_tier: 'silver', next_at_minor: 25000, remaining_minor: 25000, counted_contracts: 0, distinct_counterparties: 0, repeat_contracts: 0,
      pending_season_minor: 0, seasons_at: null, season_days: side === 'hunter' ? 7 : 14, fee_bps_planned: side === 'hunter' ? 1500 : null, member_since: '2026-10-01T00:00:00.000Z',
    });
    const trust = {
      ...limits,
      trust: {
        mode: 'shadow',
        hunter: { ladder: ladder('hunter', 'silver'), slots: { tier: 'silver', slots: 3, active_now: 1 }, track_record: { completed_count: 3, distinct_setters: 1, repeat_contracts: 2, approval_median_hours: null, approval_samples_30d: 3, auto_confirmed_pct: 0, lost_disputes_180d: 0, expired_180d: 0, member_since: '2026-10-01T00:00:00.000Z' } },
        // Setter row = slots x total in flight; loss ledger shown alongside. Display only.
        setter: {
          ladder: ladder('setter', 'bronze'),
          row: { tier: 'bronze', slots: 2, slots_used: 1, cap_minor: 5000, in_flight_minor: 10000, available_minor: 0, per_task_cap_minor: 5000, auto_accept_cap_minor: 5000, daily_cap_minor: 10000, charged_today_minor: 0 },
          loss: { outstanding_minor: 0, effective_cap_minor: 5000 },
        },
      },
    };
    const w = io(ENV_KEY, routes({ 'GET /v1/me': { json: trust } }));
    assert.equal(await run(['me'], w.cli), 0);
    assert.match(w.out(), /Trust preview \(shadow, nothing enforced\): Hunter silver, Setter bronze; the fee and caps above still apply\./);
    assert.match(w.out(), /Active assignments: 1 of 2/, 'today\'s limits are still printed');
  });

  it('money prints the owner\'s ledger: the fee ladder, both sides, Stripe flags and the payout hint; --json returns the document', async () => {
    const t = io(ENV_KEY, routes({ 'GET /v1/me/money': { json: sampleMoney } }));
    assert.equal(await run(['money'], t.cli), 0);
    assert.match(t.out(), /Fee tier: bronze · 15% fee · 1\/5 to silver \(14%\)/);
    assert.match(t.out(), /As Hunter: earned A\$34\.00 after the platform fee over 1 captured \(before Stripe's own fee, about A\$1\.00 in total\)/);
    assert.match(t.out(), /Stripe: charges enabled, payouts enabled; https:\/\/connect\.stripe\.com\/express_login/);
    assert.match(t.out(), /Stripe releases funds to your balance after capture; payouts follow your Stripe schedule\./);
    assert.match(t.out(), /approved_captured/);
    assert.match(t.out(), /As Setter: held on your card now A\$25\.00 across 1 task; charged this month A\$0\.00; refunded A\$0\.00 lifetime\./);
    assert.doesNotMatch(t.out(), /paid out|settled /i, 'no Hunter amount is called paid out or settled');
    const j = io(ENV_KEY, routes({ 'GET /v1/me/money': { json: sampleMoney } }));
    assert.equal(await run(['money', '--json'], j.cli), 0);
    assert.deepEqual(JSON.parse(j.out()), sampleMoney);
  });

  it('platform errors exit 1 with the code, details, the next step and a hint; --json prints the error document to stdout in the platform shape', async () => {
    const handler = routes({
      'POST /v1/tasks': { status: 422, json: { error: { code: 'prohibited_task', message: 'This task matches a prohibited category.', status: 422, details: { categories: ['fake_reviews'] } }, next_step: 'Do not rephrase to evade the screen; see details.categories and get_rules.' } },
    });
    const argv = ['tasks', 'post', '--title', 'Buy 100 five-star reviews', '--brief', 'b'.repeat(20), '--deliverable', 'd', '--criteria', 'c', '--category', 'other', '--bounty', '1000', '--hours', '1'];
    const human = io(ENV_KEY, handler);
    assert.equal(await run(argv, human.cli), 1);
    assert.match(human.err(), /prohibited_task \(HTTP 422\): This task matches a prohibited category\./);
    assert.match(human.err(), /fake_reviews/);
    assert.match(human.err(), /Next step: Do not rephrase to evade the screen; see details\.categories and get_rules\./);
    assert.match(human.err(), /Do not rephrase/);
    const json = io(ENV_KEY, handler);
    assert.equal(await run([...argv, '--json'], json.cli), 1);
    assert.equal(json.err(), '', 'nothing on stderr with --json');
    const doc = JSON.parse(json.out());
    assert.deepEqual(doc, {
      error: { code: 'prohibited_task', message: 'This task matches a prohibited category.', status: 422, details: { categories: ['fake_reviews'] }, retryable: false },
      next_step: 'Do not rephrase to evade the screen; see details.categories and get_rules.',
    });
  });

  it('the Hunter cap refusal prints the facts and the next step; an older error without next_step prints none', async () => {
    const ids = [UUID_A, UUID_B];
    const handler = routes({
      [`POST /v1/tasks/${UUID_C}/applications`]: { status: 409, json: {
        error: { code: 'hunter_active_limit_reached', status: 409, details: { active: 2, max: 2, assignment_ids: ids, frees_at: null },
          message: `You hold 2 of 2 active assignments (${ids.join(', ')}; delivered ones count until the Setter settles). Deliver or wait for a settlement before applying.` },
        next_step: 'Finish an assignment: deliver it, or wait for a settlement.',
      } },
      [`POST /v1/tasks/${UUID_D}/applications`]: { status: 409, json: { error: { code: 'task_not_open', message: 'task_not_open', status: 409 } } },
    });
    const text = io(ENV_KEY, handler);
    assert.equal(await run(['apply', UUID_C], text.cli), 1);
    assert.match(text.err(), /You hold 2 of 2 active assignments/);
    assert.match(text.err(), /details: \{"active":2,"max":2/);
    assert.match(text.err(), /Next step: Finish an assignment/);
    const json = io(ENV_KEY, handler);
    assert.equal(await run(['apply', UUID_C, '--json'], json.cli), 1);
    assert.deepEqual(JSON.parse(json.out()).error.details.assignment_ids, ids);
    assert.equal(JSON.parse(json.out()).next_step, 'Finish an assignment: deliver it, or wait for a settlement.');
    const old = io(ENV_KEY, handler);
    assert.equal(await run(['apply', UUID_D, '--json'], old.cli), 1);
    assert.equal('next_step' in JSON.parse(old.out()), false);
    const oldText = io(ENV_KEY, handler);
    assert.equal(await run(['apply', UUID_D], oldText.cli), 1);
    assert.doesNotMatch(oldText.err(), /Next step:/);
  });

  it('capabilities prints mode, live charges, UTC, the caps, eligibility, agent actions, categories, the first-listing review target and median, the cap auto-scale, the fee holiday when one runs, activity, event types, the confirm_url rule and the links note', async () => {
    const doc = {
      name: 'BountyMarket', version: '0.1.0', description: 'Online task marketplace.', status: 'public_sandbox', mode: 'sandbox', live_charges: false,
      server_time: '2026-11-02T00:00:00.000Z', timezone: 'UTC',
      money: {
        minimum_bounty_minor: 1000, max_task_bounty_minor: 10000, new_setter_task_cap_minor: 5000, new_setter_review_count: 1,
        setter_daily_cap_minor: 20000, auto_accept_max_bounty_minor: 5000, live_charges_paused: false, live_charges: false, fee_tiers: [{ code: 'bronze', fee_percent: 15 }],
        fee_holiday_until: null, fee_holiday: 'Platform fee is 0% for every Hunter, human or AI agent alike, for tasks accepted before fee_holiday_until; after that the tiers apply.',
      },
      caps_autoscale: {
        enabled: true, streak: 0, target: 20, level: 0,
        ceilings: { max_task_bounty_minor: 50000, new_setter_task_cap_minor: 10000, setter_daily_cap_minor: 100000, site_daily_cap_minor: 500000 },
        last_changed_at: null, description: 'The money caps grow with the marketplace\'s track record.',
      },
      // The platform's shape since 2026-11-12.2: the Setter sentence, the refused card issuing countries (the 27 EU member states, GB and,
      // since 2026-11-12.3, VN: 29 codes) and the rule.
      eligibility: {
        setters: 'Setters may be anywhere in the world except the European Union, the United Kingdom and Vietnam: for now the platform does not accept cards issued in an EU country, the UK or Vietnam, or prepaid cards. Every bounty is charged in AUD.',
        hunters: 'Australia only: Stripe Connect account with an Australian bank account and an ABN or hobby statement.',
        setter_card_countries_refused: ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'VN'],
        setter_card_country_rule: 'The platform checks the card\'s issuing country. A card issued in a country of setter_card_countries_refused is refused when it is saved (it is not kept and is removed from the Stripe customer) and again before any hold at acceptance: 412 card_country_not_supported with details.country. Posting a task needs no card; GET /v1/me readiness shows the setter gap card_country until the account holder saves a card issued elsewhere.',
      },
      agent_actions: { accept_application: 'human_or_pre_authorised_auto_accept', approve_delivery: 'agent_allowed', raise_issue: 'agent_allowed', respond_to_issue: 'agent_allowed' },
      tasks: {
        // The platform's shape since 2026-10-11.2: code, label, label_zh, description (two of the eight here; the rest print the same way).
        categories: [
          { code: 'testing_qa', label: 'Testing and QA', label_zh: '测试与 QA', description: 'Try a product, flow, app or API and report what you find: bugs, confusing steps, device checks, usability notes.' },
          { code: 'writing_editing', label: 'Writing and editing', label_zh: '写作与校对', description: 'Write, rewrite, proofread or edit text: copy, documentation, emails, product descriptions, summaries.' },
          { code: 'other', label: 'Other', label_zh: '其他', description: 'Any other online task with a clear deliverable that fits none of the seven categories above; say what it is in the brief.' },
        ],
        // The platform's default since 2026-11-12.1 (the operator's setting, 12 to 48).
        delivery_hours: { min: 1, max: 96 }, review_window_hours: 24,
      },
      activity: {
        open_tasks: 1, settled_last_30_days: 0, active_hunters_last_30_days: 0,
        median_hours_to_first_application_last_30_days: null, median_hours_to_acceptance_last_30_days: null, as_of: '2026-11-02T00:00:00.000Z',
      },
      review: { new_setter_first_listings: 1, target_hours: 24, median_hours_to_approval_last_30_days: null, note: 'A target, not a guarantee.' },
      events: { how: 'Poll GET /v1/events?after=<seq>.', types: [{ type: 'task.pending_review', visible_to: 'the Setter and admins', meaning: '...' }, { type: 'task.published', visible_to: 'everyone (public)', meaning: '...' }] },
      confirm_url: 'confirm_url appears in a result ONLY when the account holder has one thing to do on the website, signed in, that an agent key cannot do: accept an applicant by hand, confirm an agent-requested auto-accept (one click), or confirm the other side\'s cancellation request. next_step says which.',
      links: { website: 'https://web.test', api: 'https://api.test/v1', mcp: 'https://api.test/mcp', task_page: 'https://web.test/task/{id}' },
      links_note: 'api, openapi, mcp, manifest, policy, capabilities, events, tasks and report are built from the origin that answered this request (the API). website, task_page, rules, terms, privacy and contact are built from the public website base (PUBLIC_BASE_URL), which can be a different host.',
    };
    const sandbox = io(ENV, routes({ 'GET /v1/capabilities': { json: doc } }));
    assert.equal(await run(['capabilities'], sandbox.cli), 0);
    assert.match(sandbox.out(), /Mode: sandbox; live charges off/);
    assert.match(sandbox.out(), /Time: 2026-11-02T00:00:00\.000Z \(every timestamp is UTC, ISO-8601 with Z\)/);
    assert.match(sandbox.out(), /^Who can use it: Setters may be anywhere in the world except the European Union, the United Kingdom and Vietnam: for now the platform does not accept cards issued in an EU country, the UK or Vietnam, or prepaid cards\. Every bounty is charged in AUD\. Hunters: Australia only: Stripe Connect account with an Australian bank account and an ABN or hobby statement\.$/mu);
    assert.match(sandbox.out(), /^Setter cards issued in these countries are refused for now: AT, BE, BG, CY, CZ, DE, DK, EE, ES, FI, FR, GB, GR, HR, HU, IE, IT, LT, LU, LV, MT, NL, PL, PT, RO, SE, SI, SK, VN$/mu);
    assert.match(sandbox.out(), /Auto-accept: a task of at most A\$50\.00 may accept the first qualifying applicant automatically; the account holder confirms the opt-in on the website\n/);
    assert.match(sandbox.out(), /Agent actions \(sandbox and live alike\): accept_application human_or_pre_authorised_auto_accept; approve_delivery agent_allowed; raise_issue agent_allowed; respond_to_issue agent_allowed/);
    assert.match(sandbox.out(), /Bounty: A\$10\.00 to A\$100\.00 per task \(new Setters: A\$50\.00 until their first listing is approved\); A\$200\.00 per Setter per day/);
    assert.match(sandbox.out(), /Fee \(paid by the Hunter at settlement\): bronze 15%/);
    assert.doesNotMatch(sandbox.out(), /Fee holiday/, 'fee_holiday_until null: no holiday line');
    assert.match(sandbox.out(), /Categories:\n\s+testing_qa\s+Testing and QA \(测试与 QA\): Try a product, flow, app or API and report what you find: bugs, confusing steps, device checks, usability notes\.\n\s+writing_editing\s+Writing and editing \(写作与校对\): Write, rewrite, proofread or edit text: copy, documentation, emails, product descriptions, summaries\.\n\s+other\s+Other \(其他\): Any other online task/);
    assert.match(sandbox.out(), /Delivery: 1-96 hours \(at most 4 days\); the clock starts at acceptance, not at posting; review window 24 hours \(set by the operator; each delivery's review\.review_deadline_at is authoritative\)\n/);
    assert.match(sandbox.out(), /Review: a new Setter's first listing is reviewed by the founder, target 24 hours \(a target, not a guarantee\); recent median n\/a \(fewer than 3 samples\) from posting to approval; a listing whose wording suggests in-person work is held the same way for an online-only check \(review_reasons\)/);
    assert.match(sandbox.out(), /Caps auto-scale: on; 0 of 20 consecutive dispute-free settlements towards the next doubling \(level 0, never changed yet\); ceilings: per task A\$500\.00, new Setter per task A\$100\.00, per Setter per day A\$1000\.00, site per day A\$5000\.00\. Any raised issue resets the streak; caps never decrease automatically; the auto-accept cap never scales\./);
    assert.doesNotMatch(sandbox.out(), /first listings/);
    assert.match(sandbox.out(), /Activity: 1 open tasks; last 30 days: 0 settled, 0 active Hunters, median n\/a \(fewer than 3 samples\) to first application, median n\/a \(fewer than 5 samples\) from application to acceptance \(as of 2026-11-02T00:00:00\.000Z\)/);
    assert.match(sandbox.out(), /Event types: task\.pending_review, task\.published/);
    assert.match(sandbox.out(), /confirm_url rule: confirm_url appears in a result ONLY when the account holder has one thing to do on the website, signed in, that an agent key cannot do/);
    // An older deployment without tasks.review_window_hours: the Delivery line names no review window rather than a guess. Before
    // platform 2026-11-12.2 eligibility had no card-country list and its Setter sentence did not name the Setters: no list line, the label stays.
    const older = io(ENV, routes({ 'GET /v1/capabilities': { json: {
      ...doc,
      tasks: { ...doc.tasks, review_window_hours: undefined },
      eligibility: { setters: 'Anyone, any country, with a non-prepaid card; charged in AUD.', hunters: doc.eligibility.hunters },
    } } }));
    assert.equal(await run(['capabilities'], older.cli), 0);
    assert.match(older.out(), /Delivery: 1-96 hours \(at most 4 days\); the clock starts at acceptance, not at posting\n/);
    assert.doesNotMatch(older.out(), /review window/);
    assert.match(older.out(), /^Who can use it: Setters: Anyone, any country, with a non-prepaid card; charged in AUD\. Hunters: Australia only: Stripe Connect account with an Australian bank account and an ABN or hobby statement\.$/mu);
    assert.doesNotMatch(older.out(), /refused for now/);
    assert.match(sandbox.out(), /Website: https:\/\/web\.test \(task pages are https:\/\/web\.test\/task\/<task_id>\)/);
    assert.match(sandbox.out(), /API: https:\/\/api\.test\/v1; MCP: https:\/\/api\.test\/mcp/);
    assert.match(sandbox.out(), /Links note: api, openapi, mcp, manifest, policy, capabilities, events, tasks and report are built from the origin that answered this request \(the API\)\. website, task_page, rules, terms, privacy and contact are built from the public website base/);
    assert.doesNotMatch(sandbox.out(), /paused/);

    const live = io(ENV, routes({ 'GET /v1/capabilities': { json: {
      ...doc, status: 'live', mode: 'live', live_charges: true,
      money: { ...doc.money, fee_holiday_until: '2026-12-31T00:00:00.000Z', max_task_bounty_minor: 20000 },
      review: { ...doc.review, median_hours_to_approval_last_30_days: 6 },
      caps_autoscale: { ...doc.caps_autoscale, streak: 3, level: 1, last_changed_at: '2026-11-01T00:00:00.000Z' },
      activity: { ...doc.activity, settled_last_30_days: 4, active_hunters_last_30_days: 2, median_hours_to_first_application_last_30_days: 3, median_hours_to_acceptance_last_30_days: 5.5 },
    } } }));
    assert.equal(await run(['capabilities'], live.cli), 0);
    assert.match(live.out(), /Mode: live; live charges on/);
    assert.match(live.out(), /Bounty: A\$10\.00 to A\$200\.00 per task/, 'the current caps come from money, not from the ceilings');
    assert.match(live.out(), /Fee holiday: 0% platform fee for every Hunter, human or AI agent alike, on tasks accepted before 2026-12-31T00:00:00\.000Z; after that the tiers apply \(money\.fee_holiday_until\)/);
    assert.match(live.out(), /Caps auto-scale: on; 3 of 20 consecutive dispute-free settlements towards the next doubling \(level 1, last changed 2026-11-01T00:00:00\.000Z\)/);
    assert.match(live.out(), /recent median 6 h from posting to approval/);
    assert.match(live.out(), /4 settled, 2 active Hunters, median 3 h to first application, median 5\.5 h from application to acceptance/);

    const off = io(ENV, routes({ 'GET /v1/capabilities': { json: { ...doc, caps_autoscale: { ...doc.caps_autoscale, enabled: false } } } }));
    assert.equal(await run(['capabilities'], off.cli), 0);
    assert.match(off.out(), /Caps auto-scale: off; 0 of 20/);

    const json = io(ENV, routes({ 'GET /v1/capabilities': { json: doc } }));
    assert.equal(await run(['capabilities', '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), doc);
  });

  it('tasks get lists the brief files and each delivery\'s files with how to download them', async () => {
    const delivered = { ...sampleDelivery, attachments: [sampleAttachment] };
    const participant = {
      role: 'setter', applications: [], assignment: sampleAssignment, deliveries: [delivered], review: sampleReview, payment: heldPayment,
      next_step: STEP.setterDelivered, confirm_hint: STEP.setterDelivered,
    };
    const t = io(ENV_KEY, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'delivered', attachments: [sampleBriefFile], participant } } }));
    assert.equal(await run(['tasks', 'get', UUID_A], t.cli), 0);
    assert.match(t.out(), new RegExp(`\\nBrief files \\(1; participants download with "bountymarket files get <file_id> --out <path>"\\):\\n    ${UUID_FILE_2}  papers\\.zip \\(3 bytes, application/zip\\)\\n`));
    assert.match(t.out(), new RegExp(`Deliveries: 1\\n    delivery delivery-1 \\(attempt 1\\) files \\(1; "bountymarket files get <file_id> --out <path>"\\):\\n        ${UUID_FILE}  summary\\.pdf \\(4 bytes, application/pdf\\)\\n`));
    const none = io(ENV, routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }));
    assert.equal(await run(['tasks', 'get', UUID_A], none.cli), 0);
    assert.doesNotMatch(none.out(), /Brief files/, 'no line for an empty list');
  });

  it('rules --guide <name> prints one guide as get_rules { guide } returns it; the money guide reads this deployment\'s capabilities; plain rules --json carries the guide index', async () => {
    const errors = io(ENV);
    assert.equal(await run(['rules', '--guide', 'errors'], errors.cli), 0);
    assert.equal(errors.out(), GUIDES.find((g) => g.name === 'errors')!.text);
    assert.equal(errors.calls.length, 0, 'four guides need no request');
    const doc = { money: { fee_schedule: 'fee_tiers', fee_tiers: ladderFeeTiers, legacy_fee_tiers: legacyFeeTiers }, trust: { mode: 'enforce', enforced: true } };
    const money = io(ENV, routes({ 'GET /v1/capabilities': { json: doc } }));
    assert.equal(await run(['rules', '--guide', 'money', '--json'], money.cli), 0);
    assert.deepEqual(JSON.parse(money.out()), { guide: guidesForCapabilities(doc).find((g) => g.name === 'money') });
    assert.deepEqual(money.calls.map((c) => `${c.method} ${c.url.pathname}`), ['GET /v1/capabilities']);
    const down = io(ENV, () => ({ status: 503, json: { error: { code: 'payments_unavailable', message: 'x', status: 503 } } }));
    assert.equal(await run(['rules', '--guide', 'money'], down.cli), 0, 'unreadable capabilities: the fallback money guide');
    assert.equal(down.out(), guidesForCapabilities(null).find((g) => g.name === 'money')!.text);
    const bad = io(ENV);
    assert.equal(await run(['rules', '--guide', 'nope'], bad.cli), 2);
    const index = io(ENV, routes({ 'GET /.well-known/bountymarket-policy.json': { json: { policy_id: 'p', policy_version: '1', status: 'public_sandbox', digest: 'd', plain_language_summary: ['One.'] } } }));
    assert.equal(await run(['rules', '--json'], index.cli), 0);
    assert.deepEqual(JSON.parse(index.out()).agent_guides.map((g: { name: string }) => g.name), GUIDES.map((g) => g.name));
    const human = io(ENV, routes({ 'GET /.well-known/bountymarket-policy.json': { json: { policy_id: 'p', digest: 'd', plain_language_summary: ['One.'] } } }));
    assert.equal(await run(['rules'], human.cli), 0);
    assert.match(human.out(), /\nGuides \(bountymarket rules --guide <name>\): errors, waiting, issue-flow, money, files\n$/);
  });

  it('an unreachable API exits 1 with network_error', async () => {
    const t = io(ENV, () => { throw new TypeError('fetch failed'); });
    assert.equal(await run(['capabilities'], t.cli), 1);
    assert.match(t.err(), /network_error/);
    assert.match(t.err(), /BOUNTYMARKET_API_URL/);
  });
});

describe('cli: files (2026-10-11): upload over REST, attach by id, download, delete', () => {
  const PDF = new TextEncoder().encode('%PDF');
  const ZIP = new TextEncoder().encode('PK\u0003');
  const files: Record<string, Uint8Array> = { '/work/summary.pdf': PDF, '/work/papers.zip': ZIP, '/work/data.parquet': ZIP, '/work/setup.exe': ZIP, '/work/README': ZIP };
  const readBinary = (path: string) => { const bytes = files[path]; if (!bytes) throw new Error('ENOENT: no such file'); return bytes; };
  const uploads = routes({ 'POST /v1/uploads': (call) => ({ status: 201, json: { ...sampleAttachment, filename: decodeURIComponent(call.headers['x-filename']!), content_type: call.headers['content-type']!, size: call.bytes!.byteLength } }) });

  it('upload --assignment sends the raw bytes with X-Filename and Content-Type to POST /v1/uploads?assignment_id= and prints the file id with how to attach it', async () => {
    const t = io(ENV_KEY, uploads, { readBinary });
    assert.equal(await run(['upload', '--assignment', UUID_B, '/work/summary.pdf'], t.cli), 0);
    const call = t.calls[0]!;
    assert.equal(call.url.href, `https://api.test/v1/uploads?assignment_id=${UUID_B}`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer bhk_test_key');
    assert.equal(call.headers['x-filename'], 'summary.pdf');
    assert.equal(call.headers['content-type'], 'application/pdf', 'guessed from the extension');
    assert.equal(call.headers['idempotency-key'], undefined, 'the raw route has no Idempotency-Key');
    assert.equal(call.body, null);
    assert.deepEqual(call.bytes, PDF);
    assert.equal(t.out(), `Uploaded summary.pdf (4 bytes, application/pdf): file id ${UUID_FILE}\n`
      + `Uploaded for assignment ${UUID_B}. Pass the id as attachment_ids in submit_delivery (CLI: deliver ... --attach ${UUID_FILE}); `
      + 'the Setter downloads it at GET /v1/files/{id} once the delivery is submitted. Not yet attached: DELETE /v1/files/{id} removes it until then.\n');

    const json = io(ENV_KEY, uploads, { readBinary });
    assert.equal(await run(['upload', '--assignment', UUID_B, '/work/summary.pdf', '--json'], json.cli), 0);
    const result = JSON.parse(json.out());
    assert.deepEqual(result.attachment, sampleAttachment);
    assert.match(result.next_step, /deliver \.\.\. --attach/);
  });

  it('upload --task adds a brief file to a posted task; without a scope it is a draft for "tasks post --attach"; --name and --content-type override the defaults; unknown extensions go as octet-stream', async () => {
    const posted = io(ENV_KEY, uploads, { readBinary });
    assert.equal(await run(['upload', '--task', UUID_A, '/work/papers.zip'], posted.cli), 0);
    assert.equal(posted.calls[0]!.url.search, `?task_id=${UUID_A}`);
    assert.equal(posted.calls[0]!.headers['content-type'], 'application/zip');
    assert.match(posted.out(), new RegExp(`^Uploaded papers\\.zip \\(3 bytes, application/zip\\): file id ${UUID_FILE}\\nAttached to task ${UUID_A} as a brief file: applicants and participants can download it at GET /v1/files/\\{id\\}\\. DELETE /v1/files/\\{id\\} removes it while the task is pending_review or open\\.\\n$`));

    const draft = io(ENV_KEY, uploads, { readBinary });
    assert.equal(await run(['upload', '/work/papers.zip', '--name', 'reading list.zip', '--content-type', 'application/x-zip-compressed'], draft.cli), 0);
    assert.equal(draft.calls[0]!.url.search, '', 'no query: a draft brief file');
    assert.equal(draft.calls[0]!.headers['x-filename'], 'reading%20list.zip', 'percent-encoded for the header');
    assert.equal(draft.calls[0]!.headers['content-type'], 'application/x-zip-compressed');
    assert.match(draft.out(), new RegExp(`^Uploaded reading list\\.zip \\(3 bytes, application/x-zip-compressed\\): file id ${UUID_FILE}\\nUploaded as a draft brief file\\. Pass the id as attachment_ids in post_task \\(CLI: tasks post \\.\\.\\. --attach ${UUID_FILE}\\); until then only you can read it, and it is swept after 20 days if never attached\\.\\n$`));

    const unknown = io(ENV_KEY, uploads, { readBinary });
    assert.equal(await run(['upload', '/work/data.parquet'], unknown.cli), 0);
    assert.equal(unknown.calls[0]!.headers['content-type'], 'application/octet-stream', 'the platform accepts the generic type for every allowed extension');
  });

  it('upload checks the scope and the file before any request: both scopes, bad ids, an unreadable path, a refused extension, no extension, empty, over 25 MB; and needs a key', async () => {
    const cases: Array<[string[], RegExp, IoExtras?]> = [
      [['upload', '--assignment', UUID_B, '--task', UUID_A, '/work/summary.pdf'], /give either --assignment or --task, not both/],
      [['upload', '--assignment', 'nope', '/work/summary.pdf'], /--assignment must be an assignment id \(uuid\)/],
      [['upload', '--task', 'nope', '/work/summary.pdf'], /--task must be a task id \(uuid\)/],
      [['upload', '/work/missing.pdf'], /cannot read \/work\/missing\.pdf: ENOENT/],
      [['upload', '/work/setup.exe'], /\.exe files are refused: executables, installers and runnable scripts cannot be attached \(file_type_not_allowed\)/],
      [['upload', '/work/README'], /"README" has no extension; the platform needs one/],
      [['upload', '/work/summary.pdf'], /"summary\.pdf" is empty; nothing to upload/, { readBinary: () => new Uint8Array(0) }],
      [['upload', '/work/summary.pdf'], /"summary\.pdf" is 25\.0 MB, over the 25\.0 MB limit per file \(file_too_large\)/, { readBinary: () => new Uint8Array(25 * 1024 * 1024 + 1) }],
      [['upload'], /"bountymarket upload" takes 1 argument\(s\): <path>/],
    ];
    for (const [argv, pattern, extras] of cases) {
      const t = io(ENV_KEY, uploads, { readBinary, ...(extras ?? {}) });
      assert.equal(await run(argv, t.cli), 2, argv.join(' '));
      assert.match(t.err(), pattern);
      assert.equal(t.calls.length, 0, `${argv.join(' ')}: nothing was sent`);
    }
    const noKey = io(ENV, uploads, { readBinary });
    assert.equal(await run(['upload', '--assignment', UUID_B, '/work/summary.pdf'], noKey.cli), 1);
    assert.match(noKey.err(), /BOUNTYMARKET_API_KEY is not set/);
    assert.equal(noKey.calls.length, 0);
  });

  it('upload prints the platform\'s refusal with the code, details and a hint', async () => {
    const refusals: Record<string, { status: number; code: string; details?: unknown; hint: RegExp }> = {
      file_type_not_allowed: { status: 422, code: 'file_type_not_allowed', details: { filename: 'summary.pdf' }, hint: /The platform checks the extension and the declared Content-Type\. Allowed: documents/ },
      file_too_large: { status: 413, code: 'file_too_large', details: { limit_bytes: 26214400 }, hint: /Files are at most 25\.0 MB each \(details\.limit_bytes\)/ },
      too_many_attachments: { status: 422, code: 'too_many_attachments', hint: /At most 10 files per delivery and 10 per task brief\. Remove one with "bountymarket files delete <file_id>"/ },
      not_assignment_hunter: { status: 403, code: 'not_assignment_hunter', hint: /Only the accepted Hunter of this assignment/ },
      assignment_not_active: { status: 409, code: 'assignment_not_active', hint: /only be uploaded while the assignment is active/ },
      task_settled: { status: 409, code: 'task_settled', hint: /Brief files can no longer be added/ },
      not_implemented: { status: 501, code: 'not_implemented', hint: /This deployment has no file storage/ },
    };
    for (const [code, r] of Object.entries(refusals)) {
      const t = io(ENV_KEY, routes({ 'POST /v1/uploads': { status: r.status, json: { error: { code: r.code, message: `refused: ${code}`, status: r.status, ...(r.details ? { details: r.details } : {}) } } } }), { readBinary });
      assert.equal(await run(['upload', '--assignment', UUID_B, '/work/summary.pdf'], t.cli), 1, code);
      assert.match(t.err(), new RegExp(`error: ${code} \\(HTTP ${r.status}\\): refused: ${code}`));
      assert.match(t.err(), r.hint, code);
    }
  });

  it('files get downloads to --out and prints the stored name and type; --json prints the metadata; the hints for non-participants and unknown files', async () => {
    const written: Record<string, Uint8Array> = {};
    const handler = routes({
      [`GET /v1/files/${UUID_FILE}`]: { bytes: PDF, headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="summary.pdf"; filename*=UTF-8\'\'summary.pdf', 'x-content-type-options': 'nosniff' } },
      [`GET /v1/files/${UUID_FILE_2}`]: { status: 403, json: { error: { code: 'not_a_participant', message: 'Only the task\'s participants can download this file.', status: 403 } } },
      [`GET /v1/files/${UUID_A}`]: { status: 404, json: { error: { code: 'file_not_found', message: 'No such file.', status: 404 } } },
    });
    const t = io(ENV_KEY, handler, { writeBinary: (path, bytes) => { written[path] = bytes; } });
    assert.equal(await run(['files', 'get', UUID_FILE, '--out', '/work/downloaded.pdf'], t.cli), 0);
    assert.equal(t.calls[0]!.url.pathname, `/v1/files/${UUID_FILE}`);
    assert.equal(t.calls[0]!.headers.accept, '*/*');
    assert.equal(t.calls[0]!.headers.authorization, 'Bearer bhk_test_key');
    assert.deepEqual(written['/work/downloaded.pdf'], PDF);
    assert.equal(t.out(), 'Saved summary.pdf (4 bytes, application/pdf) to /work/downloaded.pdf\n');

    const json = io(ENV_KEY, handler, { writeBinary: (path, bytes) => { written[path] = bytes; } });
    assert.equal(await run(['files', 'get', UUID_FILE, '--out', '/work/again.pdf', '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), {
      file_id: UUID_FILE, filename: 'summary.pdf', size: 4, content_type: 'application/pdf',
      content_disposition: 'inline; filename="summary.pdf"; filename*=UTF-8\'\'summary.pdf', saved_to: '/work/again.pdf',
    });
    assert.deepEqual(written['/work/again.pdf'], PDF);

    const noOut = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'get', UUID_FILE], noOut.cli), 2);
    assert.match(noOut.err(), /--out is required/);
    const badId = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'get', 'nope', '--out', '/work/x'], badId.cli), 2);
    assert.match(badId.err(), /<file_id> must be a file id \(uuid\)/);
    assert.equal(noOut.calls.length + badId.calls.length, 0);
    const unwritable = io(ENV_KEY, handler, { writeBinary: () => { throw new Error('EACCES: permission denied'); } });
    assert.equal(await run(['files', 'get', UUID_FILE, '--out', '/root/x.pdf'], unwritable.cli), 2);
    assert.match(unwritable.err(), /cannot write \/root\/x\.pdf: EACCES/);

    const forbidden = io(ENV_KEY, handler, { writeBinary: () => undefined });
    assert.equal(await run(['files', 'get', UUID_FILE_2, '--out', '/work/x.pdf'], forbidden.cli), 1);
    assert.match(forbidden.err(), /not_a_participant \(HTTP 403\)/);
    assert.match(forbidden.err(), /Files are private: only the task's Setter, its accepted Hunter, applicants \(brief files\), the uploader and admins can download them\./);
    const gone = io(ENV_KEY, handler, { writeBinary: () => undefined });
    assert.equal(await run(['files', 'get', UUID_A, '--out', '/work/x.pdf'], gone.cli), 1);
    assert.match(gone.err(), /file_not_found \(HTTP 404\)/);
    assert.match(gone.err(), /files are deleted 20 days after the task settles/);
  });

  it('files delete removes a file the owner uploaded while it is editable; a submitted delivery\'s file is immutable (file_not_editable)', async () => {
    const handler = routes({
      [`DELETE /v1/files/${UUID_FILE}`]: { status: 204 },
      [`DELETE /v1/files/${UUID_FILE_2}`]: { status: 409, json: { error: { code: 'file_not_editable', message: 'The delivery was submitted; its files are part of the record.', status: 409 } } },
      [`DELETE /v1/files/${UUID_A}`]: { status: 403, json: { error: { code: 'not_file_uploader', message: 'Only the uploader can delete a file.', status: 403 } } },
    });
    const t = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'delete', UUID_FILE], t.cli), 0);
    assert.equal(t.calls[0]!.method, 'DELETE');
    assert.equal(t.calls[0]!.url.pathname, `/v1/files/${UUID_FILE}`);
    assert.equal(t.out(), `Deleted file ${UUID_FILE}.\n`);
    const json = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'delete', UUID_FILE, '--json'], json.cli), 0);
    assert.deepEqual(JSON.parse(json.out()), { ok: true, file_id: UUID_FILE });

    const immutable = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'delete', UUID_FILE_2], immutable.cli), 1);
    assert.match(immutable.err(), /file_not_editable \(HTTP 409\)/);
    assert.match(immutable.err(), /part of a submitted delivery or a settled task and can no longer be removed/);
    const notMine = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'delete', UUID_A], notMine.cli), 1);
    assert.match(notMine.err(), /Only the uploader can delete a file\./);
    const badId = io(ENV_KEY, handler);
    assert.equal(await run(['files', 'delete', 'nope'], badId.cli), 2);
    assert.match(badId.err(), /<file_id> must be a file id \(uuid\)/);
    assert.equal(badId.calls.length, 0);
    const noKey = io(ENV, handler);
    assert.equal(await run(['files', 'delete', UUID_FILE], noKey.cli), 1);
    assert.match(noKey.err(), /BOUNTYMARKET_API_KEY is not set/);
  });
});

describe('cli: limits (trust stage 1, platform 2026-10-19.2): limit-request, limit-requests, min_hunter_tier, enforce-mode me / money / capabilities', () => {
  const REASON = 'A 40-page translation that will not split into A$50 pieces.';

  it('limit-request files a request for the owner: the flags become the body, the platform\'s next_step prints; --reason-file reads stdin; usage errors before any request', async () => {
    const handler = routes({
      'POST /v1/me/limit-requests': (call) => ({ status: 201, json: { request: { ...sampleLimitRequest, task_id: null, ...(call.body as Record<string, unknown>) }, next_step: LIMIT_REQUEST_STEP } }),
    });
    const t = io(ENV_KEY, handler);
    assert.equal(await run(['limit-request', '--side', 'setter', '--level', '1', '--task', UUID_A, '--per-task-cap', '15000', '--reason', REASON], t.cli), 0);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0]!.method, 'POST');
    assert.equal(t.calls[0]!.url.pathname, '/v1/me/limit-requests');
    assert.equal(t.calls[0]!.headers.authorization, 'Bearer bhk_test_key');
    assert.ok(t.calls[0]!.headers['idempotency-key'], 'a write: Idempotency-Key sent');
    assert.deepEqual(t.calls[0]!.body, { side: 'setter', level: 1, task_id: UUID_A, requested: { per_task_cap_minor: 15000 }, reason: REASON });
    assert.match(t.out(), new RegExp(`Filed limit request ${UUID_REQ}  level 1 setter, task ${UUID_A}  pending  asked: per task A\\$150\\.00  filed 2026-10-19T10:00:00\\.000Z by an agent key`));
    assert.match(t.out(), /Filed\. The founder answers in the console, normally within 24 hours/);
    assert.doesNotMatch(t.out(), /bhk_test_key/);

    // A Hunter line names slots only; every Setter key goes through; the reason may come from a file or stdin.
    const h = io(ENV_KEY, handler, { stdin: () => REASON });
    assert.equal(await run(['limit-request', '--side', 'hunter', '--level', '2', '--slots', '5', '--reason-file', '-'], h.cli), 0);
    assert.deepEqual(h.calls[0]!.body, { side: 'hunter', level: 2, requested: { slots: 5 }, reason: REASON });
    assert.match(h.out(), /level 2 hunter  pending  asked: slots 5/);
    const all = io(ENV_KEY, handler);
    assert.equal(await run(['limit-request', '--side', 'setter', '--level', '3', '--per-task-cap', '30000', '--total-cap', '200000', '--daily-cap', '100000', '--slots', '10', '--posts-per-day', '50', '--cooling-bypass', '--reason', REASON], all.cli), 0);
    assert.deepEqual(all.calls[0]!.body, {
      side: 'setter', level: 3, requested: { per_task_cap_minor: 30000, total_cap_minor: 200000, daily_cap_minor: 100000, slots: 10, posts_per_day: 50, cooling_bypass: true }, reason: REASON,
    });
    assert.match(all.out(), /asked: per task A\$300\.00, in flight A\$2000\.00, per 24 h A\$1000\.00, slots 10, listings per 24 h 50, cooling lifted/);

    // --json prints the platform's document.
    const j = io(ENV_KEY, handler);
    assert.equal(await run(['limit-request', '--side', 'setter', '--level', '1', '--per-task-cap', '15000', '--reason', REASON, '--json'], j.cli), 0);
    assert.deepEqual(JSON.parse(j.out()), { request: { ...sampleLimitRequest, task_id: null, side: 'setter', level: 1, requested: { per_task_cap_minor: 15000 }, reason: REASON }, next_step: LIMIT_REQUEST_STEP });

    // Usage errors, before any request.
    for (const [argv, message] of [
      [['limit-request', '--side', 'setter', '--level', '1', '--reason', REASON], /name at least one limit: --per-task-cap, --total-cap, --daily-cap, --slots, --posts-per-day or --cooling-bypass \(a Hunter line names --slots only\)/],
      [['limit-request', '--side', 'setter', '--level', '1', '--per-task-cap', '15000', '--reason', 'too short'], /--reason must be at least 20 characters/],
      [['limit-request', '--side', 'setter', '--level', '1', '--per-task-cap', '15000'], /--reason or --reason-file is required/],
      [['limit-request', '--side', 'setter', '--level', '2', '--task', UUID_A, '--slots', '3', '--reason', REASON], /--task goes with --level 1/],
      [['limit-request', '--side', 'setter', '--level', '4', '--slots', '3', '--reason', REASON], /--level must be 1, 2 or 3/],
      [['limit-request', '--side', 'setter', '--level', '1', '--task', 'nope', '--slots', '3', '--reason', REASON], /--task must be a task id \(uuid\)/],
      [['limit-request', '--side', 'both', '--level', '1', '--slots', '3', '--reason', REASON], /--side must be one of setter, hunter/],
      [['limit-request', '--level', '1', '--slots', '3', '--reason', REASON], /--side is required/],
    ] as Array<[string[], RegExp]>) {
      const u = io(ENV_KEY, handler);
      assert.equal(await run(argv, u.cli), 2, argv.join(' '));
      assert.match(u.err(), message);
      assert.equal(u.calls.length, 0, 'no request');
    }
    const noKey = io(ENV, handler);
    assert.equal(await run(['limit-request', '--side', 'setter', '--level', '1', '--slots', '3', '--reason', REASON], noKey.cli), 1);
    assert.match(noKey.err(), /BOUNTYMARKET_API_KEY is not set/);

    // The platform's pacing refusal prints the facts, its next step and the CLI door.
    const busy = io(ENV_KEY, routes({ 'POST /v1/me/limit-requests': { status: 409, json: {
      error: { code: 'limit_request_open_exists', status: 409, message: 'You already have a limit request waiting (level 1, setter side, filed 2026-10-19T10:00:00.000Z); the founder answers one at a time.', details: { request_id: UUID_REQ, level: 1, side: 'setter' } },
      next_step: 'Wait for the decision, or withdraw it with DELETE /v1/me/limit-requests/' + UUID_REQ + ' and file the right one.',
    } } }));
    assert.equal(await run(['limit-request', '--side', 'setter', '--level', '1', '--slots', '3', '--reason', REASON], busy.cli), 1);
    assert.match(busy.err(), /limit_request_open_exists \(HTTP 409\): You already have a limit request waiting/);
    assert.match(busy.err(), /Next step: Wait for the decision/);
    assert.match(busy.err(), /"bountymarket limit-requests withdraw <request_id>" \(details\.request_id\)/);
  });

  it('limit-requests prints the open request, the pacing, the lines in force and the table; withdraw sends DELETE and prints the echo', async () => {
    const summary = {
      ...sampleLimitSummary,
      requests: [sampleLimitRequest, { ...sampleLimitRequest, id: UUID_B, level: 2, status: 'approved', decided: true, decided_at: '2026-10-12T00:00:00.000Z', decision_note: 'ok', approved_values: { slots: 3 }, valid_until: '2026-10-13T00:00:00.000Z', task_id: null, requested: { slots: 3 }, created_by_agent_id: null, filed_by: 'human' }],
      active_overrides: [sampleLimitOverride],
      effective: { setter: { per_task_cap_minor: 15000, total_cap_minor: 25000, daily_cap_minor: 25000 }, hunter: null },
    };
    const t = io(ENV_KEY, routes({ 'GET /v1/me/limit-requests': { json: summary } }));
    assert.equal(await run(['limit-requests'], t.cli), 0);
    assert.equal(t.calls[0]!.url.pathname, '/v1/me/limit-requests');
    assert.match(t.out(), new RegExp(`Open request: ${UUID_REQ}  level 1 setter, task ${UUID_A}  pending  asked: per task A\\$150\\.00`));
    assert.match(t.out(), /Pacing: 1 of 3 filings used in the last 30 days \(withdrawn ones count\); next allowed later; an unanswered request expires after 7 days\./);
    assert.match(t.out(), new RegExp(`Lines in force \\(1; effective = max\\(tier row, line\\)\\):\\n    ${UUID_LINE}  setter task ${UUID_A}: per task A\\$150\\.00, in flight A\\$250\\.00, per 24 h A\\$250\\.00; until 2026-10-26T12:00:00\\.000Z`));
    assert.match(t.out(), /Effective now: Setter per task A\$150\.00, in flight A\$250\.00, per 24 h A\$250\.00; Hunter tier row\./);
    assert.match(t.out(), /ID\s+LEVEL\s+SIDE\s+STATUS\s+ASKED\s+FILED\s+DECIDED\s+VALID UNTIL/);
    assert.match(t.out(), new RegExp(`${UUID_B}\\s+2\\s+setter\\s+approved\\s+slots 3\\s+2026-10-19T10:00:00\\.000Z\\s+2026-10-12T00:00:00\\.000Z\\s+2026-10-13T00:00:00\\.000Z`));
    const empty = io(ENV_KEY, routes({ 'GET /v1/me/limit-requests': { json: { ...sampleLimitSummary, open: null, requests: [], pacing: { ...sampleLimitSummary.pacing, used_30d: 0, can_request_now: true } } } }));
    assert.equal(await run(['limit-requests'], empty.cli), 0);
    assert.match(empty.out(), /Open request: none\.\nPacing: 0 of 3 filings used in the last 30 days \(withdrawn ones count\); you may file now; an unanswered request expires after 7 days\.\nLines in force: none; the tier row applies\.\nNo requests yet\. File one with "bountymarket limit-request/);
    const cooled = io(ENV_KEY, routes({ 'GET /v1/me/limit-requests': { json: { ...sampleLimitSummary, open: null, pacing: { ...sampleLimitSummary.pacing, cooldown_until: '2026-11-18T00:00:00.000Z' } } } }));
    assert.equal(await run(['limit-requests'], cooled.cli), 0);
    assert.match(cooled.out(), /declined twice in a row: the next request waits until 2026-11-18T00:00:00\.000Z/);
    const j = io(ENV_KEY, routes({ 'GET /v1/me/limit-requests': { json: summary } }));
    assert.equal(await run(['limit-requests', '--json'], j.cli), 0);
    assert.deepEqual(JSON.parse(j.out()), summary);

    // withdraw
    const withdrawn = { ...sampleLimitRequest, status: 'withdrawn' };
    const handler = routes({
      [`DELETE /v1/me/limit-requests/${UUID_REQ}`]: { json: { request: withdrawn, next_step: 'Withdrawn; it still counts toward the three filings per 30 days.' } },
      [`DELETE /v1/me/limit-requests/${UUID_B}`]: { status: 409, json: { error: { code: 'limit_request_not_pending', status: 409, message: 'This request was already decided.', details: { status: 'approved' } } } },
    });
    const w = io(ENV_KEY, handler);
    assert.equal(await run(['limit-requests', 'withdraw', UUID_REQ], w.cli), 0);
    assert.equal(w.calls[0]!.method, 'DELETE');
    assert.equal(w.calls[0]!.url.pathname, `/v1/me/limit-requests/${UUID_REQ}`);
    assert.match(w.out(), new RegExp(`Withdrawn: ${UUID_REQ}  level 1 setter, task ${UUID_A}  withdrawn  asked: per task A\\$150\\.00`));
    assert.match(w.out(), /Withdrawn; it still counts toward the three filings per 30 days\./);
    const decided = io(ENV_KEY, handler);
    assert.equal(await run(['limit-requests', 'withdraw', UUID_B], decided.cli), 1);
    assert.match(decided.err(), /limit_request_not_pending \(HTTP 409\)/);
    assert.match(decided.err(), /Only a pending request can be withdrawn/);
    const bad = io(ENV_KEY, handler);
    assert.equal(await run(['limit-requests', 'withdraw', 'nope'], bad.cli), 2);
    assert.match(bad.err(), /<request_id> must be a limit request id \(uuid\)/);
    assert.equal(bad.calls.length, 0);
    const extra = io(ENV_KEY, handler);
    assert.equal(await run(['limit-requests', 'everything'], extra.cli), 2, 'an unknown sub-command is a usage error, not a list');
  });

  it('tasks post --min-hunter-tier sends min_hunter_tier (also from --from-json); an unknown tier is a usage error; tasks get prints the Setter\'s condition', async () => {
    const posted = { ...sampleOwnerTask, status: 'open', min_hunter_tier: 'silver' };
    const handler = routes({ 'POST /v1/tasks': { status: 201, json: { ...posted, next_step: STEP.setterOpen } }, [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, min_hunter_tier: 'gold' } } });
    const t = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV, '--min-hunter-tier', 'silver'], t.cli), 0);
    assert.deepEqual(t.calls[0]!.body, { ...POST_BODY, min_hunter_tier: 'silver' });
    const plain = io(ENV_KEY, handler);
    assert.equal(await run(POST_ARGV, plain.cli), 0);
    assert.equal('min_hunter_tier' in (plain.calls[0]!.body as Record<string, unknown>), false, 'omitted unless given: an older deployment never sees the key');
    const fromJson = io(ENV_KEY, handler, { readFile: () => JSON.stringify({ ...POST_BODY, min_hunter_tier: 'gold' }) });
    assert.equal(await run(['tasks', 'post', '--from-json', 'task.json'], fromJson.cli), 0);
    assert.equal((fromJson.calls[0]!.body as Record<string, unknown>).min_hunter_tier, 'gold');
    const nullJson = io(ENV_KEY, handler, { readFile: () => JSON.stringify({ ...POST_BODY, min_hunter_tier: null }) });
    assert.equal(await run(['tasks', 'post', '--from-json', 'task.json'], nullJson.cli), 0);
    assert.equal('min_hunter_tier' in (nullJson.calls[0]!.body as Record<string, unknown>), false, 'null = anyone, sent as absent');
    const bad = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV, '--min-hunter-tier', 'wood'], bad.cli), 2);
    assert.match(bad.err(), /--min-hunter-tier must be one of bronze, silver, gold, platinum, diamond, obsidian/);
    assert.equal(bad.calls.length, 0);
    const badJson = io(ENV_KEY, handler, { readFile: () => JSON.stringify({ ...POST_BODY, min_hunter_tier: 'wood' }) });
    assert.equal(await run(['tasks', 'post', '--from-json', 'task.json'], badJson.cli), 2);
    assert.match(badJson.err(), /"min_hunter_tier" must be one of bronze, silver, gold, platinum, diamond, obsidian \(or left out: anyone may apply\)/);
    const get = io(ENV, handler);
    assert.equal(await run(['tasks', 'get', UUID_A], get.cli), 0);
    assert.match(get.out(), /Hunters of tier gold or above only \(the Setter's own condition, min_hunter_tier; others are refused with 422 min_tier_not_met\)/);
  });

  it('me in enforce mode prints the Hunter slots with the grace window, the fee tier, the Setter row with the next tier and the limit-request line; the shadow lines are not printed', async () => {
    const ladder = (side: 'hunter' | 'setter', tier: string, seasoned: number, next: string | null, nextAt: number | null) => ({
      side, seasoned_minor: seasoned, tier, tier_rank: 2, money_tier: tier, time_gate_ok: true, time_gate_days: 7, gate_clears_at: null, account_age_days: 40,
      next_tier: next, next_at_minor: nextAt, remaining_minor: nextAt === null ? null : nextAt - seasoned, counted_contracts: 3, distinct_counterparties: 2, repeat_contracts: 1,
      pending_season_minor: 0, seasons_at: null, season_days: side === 'hunter' ? 7 : 14, fee_bps_planned: side === 'hunter' ? 1500 : null, member_since: '2026-09-09T00:00:00.000Z',
    });
    const me = {
      id: 'u1', display_name: 'Ada', country_code: 'AU', terms_version: 'v1', terms_accepted_at: '2026-10-01T00:00:00.000Z',
      over_18_attested_at: '2026-10-01T00:00:00.000Z', is_admin: false, status: 'active', created_at: '2026-09-09T00:00:00.000Z',
      agent: { id: 'a1', display_name: 'Ada Bot', api_key_prefix: 'bhk_abcd', setter_mode: 'always', hunter_mode: 'always', status: 'active', created_at: null, last_used_at: null },
      terms_current_version: '2026-10-19.1', terms_current_accepted: true, hunter_account: null, payment_method_count: 1,
      hunter_tier_code: 'silver', hunter_tier_basis: 'seasoned_net_earnings', hunter_tier_eligible_count: 3,
      hunter_active_assignments: 1, hunter_max_active_assignments: 4, hunter_active_assignment_ids: [UUID_A],
      limits_note: 'trust.mode is enforce: your Setter limits are trust.setter.row ...',
      // Retired static caps, kept for compatibility: never printed as limits in enforce mode.
      setter_daily_cap_minor: 20000, setter_daily_used_minor: 18500, setter_daily_posts_limit: 20, setter_daily_posts_used: 3,
      setter_daily_resets_at: '2026-10-20T00:00:00.000Z', setter_is_new: false, new_setter_task_cap_minor: 5000, max_task_bounty_minor: 10000,
      trust: {
        mode: 'enforce',
        hunter: {
          ladder: ladder('hunter', 'silver', 30000, 'gold', 100000),
          slots: { tier: 'silver', slots: 4, active_now: 1, enforced: true, delivered_grace_hours: 12, next_tier: 'gold', next_slots: 5, next_at_minor: 100000, seasons_at: null, override: null },
          track_record: { completed_count: 3, distinct_setters: 2, repeat_contracts: 1, approval_median_hours: null, approval_samples_30d: 3, auto_confirmed_pct: 0, lost_disputes_180d: 0, expired_180d: 0, member_since: '2026-09-09T00:00:00.000Z' },
        },
        setter: {
          ladder: ladder('setter', 'bronze', 0, 'silver', 25000),
          row: {
            tier: 'bronze', slots: 2, slots_used: 1, cap_minor: 10000, in_flight_minor: 5000, available_minor: 5000, per_task_cap_minor: 5000, auto_accept_cap_minor: 5000,
            daily_cap_minor: 10000, charged_today_minor: 2500, enforced: true, charged_24h_minor: 2500, daily_resets_at: '2026-10-20T08:00:00.000Z', posts_per_day: 20, posts_24h: 3,
            posts_resets_at: null, cooling_days: 0, cooling_bypass: false, cooling_held_slots: 0, cooling_held_minor: 0, live_slots_used: 1, live_in_flight_minor: 5000, override: null,
            next_tier: 'silver', next_row: setterRows.silver, next_at_minor: 25000, seasons_at: null,
          },
          loss: { outstanding_minor: 0, effective_cap_minor: 10000 },
        },
      },
      limit_requests: sampleLimitSummary,
    };
    const t = io(ENV_KEY, routes({ 'GET /v1/me': { json: me } }));
    assert.equal(await run(['me'], t.cli), 0);
    assert.match(t.out(), new RegExp(`Active assignments: 1 of 4 \\(${UUID_A}\\); your silver tier's slots \\(enforced\\); a delivered one stops counting 12 hours after delivery\\. Next: gold allows 5 from A\\$1000\\.00 seasoned net earnings\\.`));
    assert.match(t.out(), /Hunter fee tier: silver \(15% platform fee at the next acceptance\); gold from A\$1000\.00 seasoned net earnings \(A\$300\.00 so far\)\./);
    assert.match(t.out(), /Setter limits \(bronze tier, enforced\): 1 of 2 slots; in flight A\$50\.00 of A\$100\.00 \(A\$50\.00 available\); per task A\$50\.00 \(also the auto-accept cap\); charged in the last 24 h A\$25\.00 of A\$100\.00; listings in the last 24 h 3 of 20\./);
    assert.match(t.out(), /Next Setter tier: silver from A\$250\.00 seasoned spend: 3 slots, A\$100\.00 in flight, A\$50\.00 per task, A\$200\.00 per 24 h, 40 listings per 24 h\./);
    assert.match(t.out(), new RegExp(`Limit requests: open: ${UUID_REQ} \\(level 1, setter, filed 2026-10-19T10:00:00\\.000Z\\); 0 lines in force; filed 1 of 3 in 30 days \\("bountymarket limit-requests" for the list, "bountymarket limit-request" to file one\\)\\.`));
    assert.doesNotMatch(t.out(), /Posting today|Trust preview|New Setter|delivered ones count until the Setter settles/, 'the shadow-mode lines give way to the enforced row');

    // A line in force, cooling held, a loss outstanding and a gated promotion all print.
    const held = {
      ...me,
      trust: {
        ...me.trust,
        hunter: { ...me.trust.hunter, ladder: { ...me.trust.hunter.ladder, time_gate_ok: false, gate_clears_at: '2026-10-25T00:00:00.000Z' }, slots: { ...me.trust.hunter.slots, override: { slots: 6, valid_until: '2026-10-20T10:00:00.000Z' } } },
        setter: {
          ...me.trust.setter,
          row: { ...me.trust.setter.row, tier: 'platinum', slots: 5, slots_used: 4, cooling_days: 1, cooling_held_slots: 1, cooling_held_minor: 3000, live_slots_used: 3, override: { per_task_cap_minor: 40000, valid_until: '2026-10-26T12:00:00.000Z', scope: 'account' }, next_tier: 'diamond', next_row: setterRows.diamond, next_at_minor: 1500000 },
          loss: { outstanding_minor: 2500, effective_cap_minor: 7500 },
        },
      },
      limit_requests: { ...sampleLimitSummary, open: null, active_overrides: [sampleLimitOverride], pacing: { ...sampleLimitSummary.pacing, used_30d: 2, cooldown_until: '2026-11-18T00:00:00.000Z' } },
    };
    const h = io(ENV_KEY, routes({ 'GET /v1/me': { json: held } }));
    assert.equal(await run(['me'], h.cli), 0);
    assert.match(h.out(), /a limit line raises it to 6 until 2026-10-20T10:00:00\.000Z/);
    assert.match(h.out(), /the promotion already earned takes effect 2026-10-25T00:00:00\.000Z \(account-age gate\)/);
    assert.match(h.out(), /Setter limits \(platinum tier, enforced\): 4 of 5 slots \(1 cooling 1 d after settlement\); in flight A\$50\.00 of A\$100\.00 \(A\$50\.00 available, A\$25\.00 owed to the platform\);.*; a limit line is in force \(per task A\$400\.00 until 2026-10-26T12:00:00\.000Z\)\./);
    // The founder's final Diamond row (2026-10-19): daily A$1,000, no cooling (cooling_days 0 prints nothing); the cooling_days 1 above is the fixture's own, exercising the mechanism.
    assert.match(h.out(), /Next Setter tier: diamond from A\$15000\.00 seasoned spend: 8 slots, A\$1500\.00 in flight, A\$300\.00 per task, A\$1000\.00 per 24 h, 300 listings per 24 h\./);
    assert.match(h.out(), /Limit requests: none open; 1 line in force; filed 2 of 3 in 30 days; declined twice: wait until 2026-11-18T00:00:00\.000Z/);
  });

  it('money prints the ladder by seasoned net earnings when fee_tier.basis is seasoned_net_earnings; the count ladder otherwise', async () => {
    const byMoney = {
      ...sampleMoney,
      fee_tier: {
        code: 'silver', fee_bps: 1500, fee_percent: 15, settled_count: 3, window_days: 180, next_tier: 'gold', next_fee_bps: 1300, next_fee_percent: 13, needed: 100000, remaining: 70000,
        basis: 'seasoned_net_earnings', seasoned_minor: 30000, pending_season_minor: 4000, seasons_at: '2026-10-26T00:00:00.000Z', money_tier: 'silver', time_gate_ok: true, gate_clears_at: null,
      },
    };
    const t = io(ENV_KEY, routes({ 'GET /v1/me/money': { json: byMoney } }));
    assert.equal(await run(['money'], t.cli), 0);
    assert.match(t.out(), /Fee tier: silver · 15% fee · A\$300\.00 of A\$1000\.00 seasoned net earnings to gold \(13%\); A\$40\.00 more seasons by 2026-10-26T00:00:00\.000Z/);
    const gated = io(ENV_KEY, routes({ 'GET /v1/me/money': { json: { ...byMoney, fee_tier: { ...byMoney.fee_tier, money_tier: 'gold', time_gate_ok: false, gate_clears_at: '2026-10-25T00:00:00.000Z', pending_season_minor: 0 } } } }));
    assert.equal(await run(['money'], gated.cli), 0);
    assert.match(gated.out(), /to gold \(13%\); the promotion to gold takes effect 2026-10-25T00:00:00\.000Z \(account-age gate\)/);
    const top = io(ENV_KEY, routes({ 'GET /v1/me/money': { json: { ...byMoney, fee_tier: { ...byMoney.fee_tier, code: 'obsidian', fee_bps: 500, next_tier: null, next_fee_bps: null, needed: null } } } }));
    assert.equal(await run(['money'], top.cli), 0);
    assert.match(top.out(), /Fee tier: obsidian · 5% fee · top tier/);
    const legacy = io(ENV_KEY, routes({ 'GET /v1/me/money': { json: sampleMoney } }));
    assert.equal(await run(['money'], legacy.cli), 0);
    assert.match(legacy.out(), /Fee tier: bronze · 15% fee · 1\/5 to silver \(14%\)/, 'no basis (an older deployment) or settled_count_180d: the count ladder');
  });

  it('capabilities in enforce mode prints the Setter tier rows, the Hunter slots, the six fee tiers by money, the auto-accept rule and the limit-request pacing; in shadow the legacy tiers are named as charged', async () => {
    const doc = {
      name: 'BountyMarket', version: '0.1.0', description: 'Online task marketplace.', status: 'public_sandbox', mode: 'sandbox', live_charges: false,
      money: {
        minimum_bounty_minor: 1000, new_setter_task_cap_minor: 5000, new_setter_review_count: 1, limits_enforced_by: 'tier_rows', fee_schedule: 'fee_tiers', fee_policy_version: 3,
        fee_tiers: ladderFeeTiers, legacy_fee_tiers: legacyFeeTiers, fee_holiday_until: null, auto_accept_max_bounty_minor: 5000,
        // Retired values the platform still serves for compatibility; never printed as the limit in enforce mode.
        max_task_bounty_minor: 10000, setter_daily_cap_minor: 20000, retired_now: true,
      },
      caps_autoscale: {
        enabled: true, streak: 0, target: 20, level: 0,
        ceilings: { max_task_bounty_minor: 50000, new_setter_task_cap_minor: 10000, setter_daily_cap_minor: 100000, site_daily_cap_minor: 500000 },
        last_changed_at: null,
      },
      trust: {
        mode: 'enforce', enforced: true, tiers: ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'obsidian'], setter_rows: setterRows,
        hunter_slots: { bronze: 3, silver: 4, gold: 5, platinum: 6, diamond: 8, obsidian: 10 }, delivered_grace_hours: 12,
      },
      limit_requests: {
        how: 'POST /v1/me/limit-requests ...', who_may_file: ['human', 'ai_agent'], levels: { 1: '...', 2: '...', 3: '...' },
        pacing: { one_open_request: true, max_per_30d: 3, declines_for_cooldown: 2, decline_cooldown_days: 30, pending_expiry_days: 7, note: '...' },
        ceilings: { in_flight_minor: 1000000, daily_minor: 2000000, note: '...' }, rules: {}, routes: { file: 'POST /v1/me/limit-requests', mcp_tool: 'request_limit' },
      },
      tasks: { categories: [], delivery_hours: { min: 1, max: 96 }, review_window_hours: 24, auto_accept: { max_bounty_minor: 5000, max_bounty_rule: 'The auto-accept cap is the Setter\'s per-task cap.' } },
      links: { website: 'https://web.test' },
    };
    const t = io(ENV, routes({ 'GET /v1/capabilities': { json: doc } }));
    assert.equal(await run(['capabilities'], t.cli), 0);
    assert.match(t.out(), /Bounty: at least A\$10\.00 per task; a new Setter's first listing is reviewed first; the other limits are the Setter's tier row \(trust\.setter_rows\), enforced:\n\s+bronze\s+2 slots, A\$100\.00 in flight, A\$50\.00 per task, A\$100\.00 per 24 h, 20 listings per 24 h\n\s+silver\s+3 slots, A\$100\.00 in flight, A\$50\.00 per task, A\$200\.00 per 24 h, 40 listings per 24 h\n/);
    assert.match(t.out(), /\s+platinum\s+5 slots, A\$500\.00 in flight, A\$200\.00 per task, A\$750\.00 per 24 h, 150 listings per 24 h\n/);
    assert.match(t.out(), /\s+obsidian\s+unlimited slots, A\$3000\.00 in flight, A\$500\.00 per task, A\$1500\.00 per 24 h, unlimited listings per 24 h\n/);
    // cooling_days 0 at every tier prints no cooling at all; a row that sets one would print "cooling N d".
    assert.doesNotMatch(t.out(), /cooling \d+ d/);
    assert.match(t.out(), /Hunter slots \(concurrent assignments by tier; a delivered one stops counting 12 h after delivery\): bronze 3, silver 4, gold 5, platinum 6, diamond 8, obsidian 10/);
    assert.match(t.out(), /Fee \(paid by the Hunter at settlement, by lifetime seasoned net earnings\): bronze 20%, silver 15% from A\$250\.00, gold 13% from A\$1000\.00, platinum 10% from A\$5000\.00, diamond 8% from A\$15000\.00, obsidian 5% from A\$30000\.00\n/);
    assert.match(t.out(), /Auto-accept: a task of at most the Setter's per-task cap \(their tier row; a task raised by an approved limit request up to the raised cap\) may accept the first qualifying applicant automatically; the account holder confirms the opt-in on the website/);
    assert.match(t.out(), /Limit requests: anyone may ask the founder for a higher limit \(a human session or the account's agent key; "bountymarket limit-request"\): level 1 one task, 2 an account line \(24 hours by default\), 3 a long-term line; one open request at a time, 3 per 30 days, 2 declines in a row → a 30-day wait, unanswered for 7 days → expired; ceilings A\$10000\.00 in flight, A\$20000\.00 per day/);
    assert.doesNotMatch(t.out(), /A\$10\.00 to A\$100\.00 per task|per Setter per day|at most A\$50\.00 may accept/, 'the retired static caps are not the limit');
    assert.match(t.out(), /\nCaps auto-scale: retired while trust\.mode is enforce \(the Setter tier rows apply, trust\.setter_rows\)\.\n/);
    assert.doesNotMatch(t.out(), /ceilings: per task|consecutive dispute-free settlements/, 'no retired ceilings or streak in enforce mode');

    // Shadow: the static caps print as before, the ladder is shown with the legacy tiers named as what is charged.
    const shadow = io(ENV, routes({ 'GET /v1/capabilities': { json: {
      ...doc, money: { ...doc.money, limits_enforced_by: 'static_caps', fee_schedule: 'legacy_fee_tiers', fee_policy_version: 2, retired_now: false }, trust: { ...doc.trust, mode: 'shadow', enforced: false },
    } } }));
    assert.equal(await run(['capabilities'], shadow.cli), 0);
    assert.match(shadow.out(), /Bounty: A\$10\.00 to A\$100\.00 per task \(new Setters: A\$50\.00 until their first listing is approved\); A\$200\.00 per Setter per day/);
    assert.match(shadow.out(), /obsidian 5% from A\$30000\.00\. Charged while trust\.mode is shadow: the legacy count tiers bronze 15%, silver 14%, gold 12\.5%, diamond 10%\n/);
    assert.match(shadow.out(), /Auto-accept: a task of at most A\$50\.00 may accept/);
    assert.doesNotMatch(shadow.out(), /enforced:/);
    assert.match(shadow.out(), /Caps auto-scale: on; 0 of 20 consecutive dispute-free settlements towards the next doubling \(level 0, never changed yet\); ceilings: per task A\$500\.00/, 'shadow mode keeps the auto-scale line');
  });

  it('capabilities with the first-listing review off (new_setter_review_count 0, since 2026-11-10): a first listing opens at once, no new-Setter cap, the in-person hold and target stay; back at 1 the old lines return', async () => {
    const base = {
      name: 'BountyMarket', version: '0.1.0', description: 'Online task marketplace.', status: 'public_sandbox', mode: 'sandbox', live_charges: false,
      money: { minimum_bounty_minor: 1000, max_task_bounty_minor: 10000, new_setter_task_cap_minor: 5000, new_setter_review_count: 0, setter_daily_cap_minor: 20000, limits_enforced_by: 'static_caps' },
      review: { new_setter_first_listings: 0, target_hours: 24, median_hours_to_approval_last_30_days: null, note: 'A target, not a guarantee.' },
      links: { website: 'https://web.test' },
    };
    const off = io(ENV, routes({ 'GET /v1/capabilities': { json: base } }));
    assert.equal(await run(['capabilities'], off.cli), 0);
    assert.match(off.out(), /Bounty: A\$10\.00 to A\$100\.00 per task; A\$200\.00 per Setter per day\n/, 'the new-Setter cap shares the switch: at 0 it does not apply');
    assert.match(off.out(), /Review: no first-listing review \(new_setter_first_listings 0\): a new Setter's first listing opens at once; a listing whose wording suggests in-person work is held for an online-only check \(review_reasons\), target 24 hours \(a target, not a guarantee\); recent median n\/a \(fewer than 3 samples\) from posting to approval\n/);
    assert.doesNotMatch(off.out(), /reviewed first|reviewed by the founder|new Setters:|first 0 listings/);

    // Enforce mode (tier rows): the first-listing clause says the review is off.
    const enforced = io(ENV, routes({ 'GET /v1/capabilities': { json: {
      ...base, money: { ...base.money, limits_enforced_by: 'tier_rows' },
      trust: { mode: 'enforce', enforced: true, setter_rows: { bronze: { open_task_slots: 2, in_flight_cap_minor: 10000, per_task_cap_minor: 5000, daily_cap_minor: 10000, posts_per_day: 20, cooling_days: 0 } } },
    } } }));
    assert.equal(await run(['capabilities'], enforced.cli), 0);
    assert.match(enforced.out(), /Bounty: at least A\$10\.00 per task; no first-listing review \(a new Setter's first listing opens at once\); the other limits are the Setter's tier row/);

    // The founder switches it back on: the 2026-10-08 lines exactly.
    const on = io(ENV, routes({ 'GET /v1/capabilities': { json: {
      ...base, money: { ...base.money, new_setter_review_count: 1 }, review: { ...base.review, new_setter_first_listings: 1 },
    } } }));
    assert.equal(await run(['capabilities'], on.cli), 0);
    assert.match(on.out(), /Bounty: A\$10\.00 to A\$100\.00 per task \(new Setters: A\$50\.00 until their first listing is approved\); A\$200\.00 per Setter per day/);
    assert.match(on.out(), /Review: a new Setter's first listing is reviewed by the founder, target 24 hours \(a target, not a guarantee\); recent median n\/a/);
  });

  it('a Setter tier-limit refusal prints the facts, the platform\'s next step and the limit-request door; min_tier_not_met names the Setter\'s condition; the auto-accept cap hint names the per-task cap', async () => {
    const handler = routes({
      'POST /v1/tasks': (call) => ((call.body as Record<string, unknown>).auto_accept
        ? { status: 422, json: { error: { code: 'auto_accept_bounty_above_cap', status: 422, message: 'Auto-accept is only for bounties up to A$50.00.', details: { cap_minor: 5000, bounty_minor: 6000 } } } }
        : { status: 422, json: {
          error: {
            code: 'setter_task_cap_exceeded', status: 422, message: 'The bounty (A$60.00) is above your per-task cap of A$50.00 (bronze). Silver allows A$50.00 per task from A$250.00 seasoned spend.',
            details: { tier: 'bronze', cap_minor: 5000, bounty_minor: 6000, next_tier: 'silver', next_row: setterRows.silver, next_at_minor: 25000, seasons_at: null, override: null, request_route: 'POST /v1/me/limit-requests' },
          },
          next_step: 'Lower bounty_minor to at most 5000 (details.cap_minor), split the work into tasks within it, or ask for a higher limit: POST /v1/me/limit-requests or the website (Account → Limits); an agent key may file it for its owner. Level 1 raises one task; a raised task may still auto-accept.',
        } }),
      [`POST /v1/tasks/${UUID_C}/applications`]: { status: 422, json: {
        error: { code: 'min_tier_not_met', status: 422, message: 'The Setter asks for Hunters of tier gold or above on this task; you are silver.', details: { have: 'silver', need: 'gold', have_rank: 2, need_rank: 3, setter_chosen: true } },
        next_step: 'This is the Setter\'s own condition (min_hunter_tier), not a platform rule: apply to tasks without it or with a lower one.',
      } },
    });
    const cap = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV.slice(0, -4), '--bounty', '6000', '--hours', '24'], cap.cli), 1);
    assert.match(cap.err(), /setter_task_cap_exceeded \(HTTP 422\): The bounty \(A\$60\.00\) is above your per-task cap of A\$50\.00 \(bronze\)/);
    assert.match(cap.err(), /details: \{"tier":"bronze","cap_minor":5000,"bounty_minor":6000,"next_tier":"silver"/);
    assert.match(cap.err(), /Next step: Lower bounty_minor to at most 5000 \(details\.cap_minor\), split the work into tasks within it, or ask for a higher limit: POST \/v1\/me\/limit-requests/);
    assert.match(cap.err(), /Your account's Setter tier row is the limit \("me": trust\.setter\.row; details carry the numbers, the next tier's row and request_route\)\. .*"bountymarket limit-request --side setter --level 1 --task <id> --per-task-cap <cents> --reason \.\.\." raises one task, "--level 2" an account line \(24 hours by default; up to the next tier's row\); the founder decides, normally within 24 hours, and may decline\./);
    const json = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV.slice(0, -4), '--bounty', '6000', '--hours', '24', '--json'], json.cli), 1);
    assert.equal(JSON.parse(json.out()).error.details.request_route, 'POST /v1/me/limit-requests');
    const auto = io(ENV_KEY, handler);
    assert.equal(await run([...POST_ARGV.slice(0, -4), '--bounty', '6000', '--hours', '24', '--auto-accept'], auto.cli), 1);
    assert.match(auto.err(), /your account's per-task cap once the trust ladder is enforced \("me": trust\.setter\.row\.auto_accept_cap_minor; details\.cap_minor\)/);
    const tier = io(ENV_KEY, handler);
    assert.equal(await run(['apply', UUID_C], tier.cli), 1);
    assert.match(tier.err(), /min_tier_not_met \(HTTP 422\): The Setter asks for Hunters of tier gold or above on this task; you are silver\./);
    assert.match(tier.err(), /Next step: This is the Setter's own condition/);
    assert.match(tier.err(), /The Setter's own entry condition \(min_hunter_tier\), not a platform rule: apply to tasks without it/);
  });
});

describe('cli: trust stage 2 (platform 2026-10-30.1): identity in me and capabilities, the level-3 form, the hold-gate and identity hints', () => {
  const REASON = 'A long-term agency line for weekly batches of translation work.';
  const baseMe = {
    id: 'u1', display_name: 'Ada', country_code: 'AU', terms_version: 'v1', terms_accepted_at: '2026-10-01T00:00:00.000Z',
    over_18_attested_at: '2026-10-01T00:00:00.000Z', is_admin: false, status: 'active', created_at: '2026-09-09T00:00:00.000Z',
    agent: { id: 'a1', display_name: 'Ada Bot', api_key_prefix: 'bhk_abcd', setter_mode: 'always', hunter_mode: 'always', status: 'active', created_at: null, last_used_at: null },
    terms_current_version: '2026-10-19.1', terms_current_accepted: true, hunter_account: null, payment_method_count: 1,
  };
  const identity = {
    status: 'not_started', enabled: true, required_for_tier: 'platinum', required_now: true, gate_applies: true, row_tier_while_unverified: 'gold',
    verified_at: null, failed_reason: null, sessions_30d: 0, max_sessions_30d: 2, site_sessions_30d: 4, site_monthly_cap: 100, can_start_now: true,
    documents: ['driving_license', 'passport'], country: 'AU', stored: 'The outcome only.', route: 'POST /v1/me/identity/session',
  };

  it('me prints the identity line: gate applied and startable, pending, failed with the reason, verified, paced out, and off; an older deployment prints none', async () => {
    const gated = io(ENV_KEY, routes({ 'GET /v1/me': { json: { ...baseMe, identity } } }));
    assert.equal(await run(['me'], gated.cli), 0);
    assert.match(gated.out(), /Identity: not started; your Setter tier is platinum or above, so the gold row applies until verified \(fee and badge unchanged\); the account holder starts it on the website, signed in \(Account > Identity, Australian driving licence or passport; never an agent key\)\n/);

    const pending = io(ENV_KEY, routes({ 'GET /v1/me': { json: { ...baseMe, identity: { ...identity, status: 'pending', sessions_30d: 1, can_start_now: false } } } }));
    assert.equal(await run(['me'], pending.cli), 0);
    assert.match(pending.out(), /Identity: pending \(a session was started; the outcome arrives by webhook within minutes\); your Setter tier is platinum or above, so the gold row applies until verified \(fee and badge unchanged\); no new session now \(1 of 2 per 30 days used, site 4 of 100\)\n/);

    const failed = io(ENV_KEY, routes({ 'GET /v1/me': { json: { ...baseMe, identity: { ...identity, status: 'failed', failed_reason: 'not_au_document', sessions_30d: 1 } } } }));
    assert.equal(await run(['me'], failed.cli), 0);
    assert.match(failed.out(), /Identity: failed \(not_au_document\); your Setter tier is platinum or above, so the gold row applies until verified/);

    const verified = io(ENV_KEY, routes({ 'GET /v1/me': { json: { ...baseMe, identity: { ...identity, status: 'verified', verified_at: '2026-10-30T01:00:00.000Z', required_now: false, gate_applies: false, row_tier_while_unverified: null, can_start_now: false } } } }));
    assert.equal(await run(['me'], verified.cli), 0);
    assert.match(verified.out(), /Identity: verified \(Australian document, 2026-10-30T01:00:00\.000Z\); required for Setters from the platinum tier and for a level-3 line\n/);

    const below = io(ENV_KEY, routes({ 'GET /v1/me': { json: { ...baseMe, identity: { ...identity, required_now: false, gate_applies: false, row_tier_while_unverified: null } } } }));
    assert.equal(await run(['me'], below.cli), 0);
    assert.match(below.out(), /Identity: not started; required for Setters from the platinum tier and for a level-3 line; the account holder starts it on the website, signed in/);

    const off = io(ENV_KEY, routes({ 'GET /v1/me': { json: { ...baseMe, identity: { ...identity, enabled: false, required_for_tier: null, required_now: false, gate_applies: false, row_tier_while_unverified: null, can_start_now: false } } } }));
    assert.equal(await run(['me'], off.cli), 0);
    assert.match(off.out(), /Identity: not started; verification is off on this deployment \(no limit depends on it\)\n/);

    const older = io(ENV_KEY, routes({ 'GET /v1/me': { json: baseMe } }));
    assert.equal(await run(['me'], older.cli), 0);
    assert.doesNotMatch(older.out(), /Identity:/);
  });

  it('capabilities prints the identity block when the platform serves it (on with the gate tier and pacing; off), nothing on an older deployment', async () => {
    const doc = {
      name: 'BountyMarket', status: 'public_sandbox', mode: 'sandbox', live_charges: false,
      money: { minimum_bounty_minor: 1000, max_task_bounty_minor: 10000, new_setter_task_cap_minor: 5000, setter_daily_cap_minor: 20000, fee_tiers: [{ code: 'bronze', fee_percent: 15 }] },
      tasks: { categories: [], delivery_hours: { min: 1, max: 96 }, review_window_hours: 24 },
      links: { website: 'https://web.test' },
    };
    const on = { ...doc, identity: {
      enabled: true, provider: 'stripe_identity', required_from_tier: 'platinum', applies_to: 'setter', documents: ['driving_license', 'passport'], country: 'AU',
      rule: '...', how: '...', accepted: '...', stored: '...', pacing: { per_account_30d: 2, site_30d: 100, note: '...' },
      routes: { start: 'POST /v1/me/identity/session', status: 'GET /v1/me (identity)', return: '/account/identity' },
    } };
    const t = io(ENV, routes({ 'GET /v1/capabilities': { json: on } }));
    assert.equal(await run(['capabilities'], t.cli), 0);
    assert.match(t.out(), /Identity verification: on for Setters from the platinum tier \(Stripe Identity, Australian driving licence or passport; until verified such a Setter reads the row of the tier below; a level-3 line needs it\); the account holder starts it on the website, signed in \(Account > Identity; never an agent key\); 2 sessions per account and 100 site-wide per 30 days; the platform stores the outcome only\n/);

    const off = io(ENV, routes({ 'GET /v1/capabilities': { json: { ...on, identity: { ...on.identity, enabled: false, required_from_tier: null } } } }));
    assert.equal(await run(['capabilities'], off.cli), 0);
    assert.match(off.out(), /Identity verification: off on this deployment \(no limit depends on it; capabilities\.identity\.required_from_tier is null\)\n/);

    const older = io(ENV, routes({ 'GET /v1/capabilities': { json: doc } }));
    assert.equal(await run(['capabilities'], older.cli), 0);
    assert.doesNotMatch(older.out(), /Identity verification/);
  });

  it('a level-3 request without the application form is the platform\'s 422 limit_request_invalid { field: detail }; the hint sends the owner to the website', async () => {
    const t = io(ENV_KEY, routes({ 'POST /v1/me/limit-requests': { status: 422, json: {
      error: { code: 'limit_request_invalid', status: 422, message: 'A level-3 request carries the application form (detail).', details: { field: 'detail', reason: 'required_at_level_3' } },
      next_step: 'File the Contractor application on the website (Account → Limits): legal name, ABN, use case, expected spend, a contact phone.',
    } } }));
    assert.equal(await run(['limit-request', '--side', 'setter', '--level', '3', '--total-cap', '200000', '--reason', REASON], t.cli), 1);
    assert.match(t.err(), /limit_request_invalid \(HTTP 422\): A level-3 request carries the application form \(detail\)\./);
    assert.match(t.err(), /Next step: File the Contractor application on the website/);
    assert.match(t.err(), /details\.field "detail" \(or detail\.<key>\): a level-3 Contractor line carries an application form \(legal name, ABN, use case, expected spend, a contact phone, a verification call\) that the account holder fills on the website \(Account > Limits\); this command and the MCP tool cannot send it\./);
    assert.match(USAGE, /since platform 2026-10-30\.1 it carries an application form the account holder fills on the website, so this command answers 422 limit_request_invalid \{ field: detail \} at level 3/);
  });

  it('the hold-gate and identity codes print the platform\'s sentence, the next step and a hint (cluster_on_hold, breaker_paused, identity_required_for_level, identity_session_limit, identity_not_available, human_only)', async () => {
    const refusals: Array<{ status: number; code: string; details: Record<string, unknown>; hint: RegExp }> = [
      { status: 422, code: 'cluster_on_hold', details: { hold_until: '2026-11-13T00:00:00.000Z', reason: 'early_fraud_warning', hold_days: 14 },
        hint: /The payer's bank flagged a card saved on the Setter's account \(early fraud warning\), so new card holds for it are refused until details\.hold_until \(details\.hold_days days\)\. Nothing was assigned/ },
      { status: 422, code: 'breaker_paused', details: { rule: 'b2', tripped_at: '2026-10-30T02:00:00.000Z', tier: 'bronze', values: {}, paused_tiers: ['bronze'] },
        hint: /New card holds for Bronze-tier Setters are paused marketplace-wide \(an automatic safety pause, details\.rule tripped at details\.tripped_at; the founder is reviewing\)\. Retry later: the pause lifts when it is cleared;/ },
      { status: 422, code: 'identity_required_for_level', details: { level: 3, identity_status: 'not_started', required_from_tier: 'platinum' },
        hint: /A level-3 Contractor line is approved only once the account holder's Stripe Identity is verified \(details\.identity_status\)\. The account holder verifies on the website \(Account > Identity: an Australian driving licence or passport, live capture; signed in, never with an agent key\)/ },
      { status: 429, code: 'identity_session_limit', details: { scope: 'account', used: 2, max: 2, window_days: 30, next_allowed_at: '2026-11-20T00:00:00.000Z', retry_after_seconds: 86400 },
        hint: /Identity sessions are paced: 2 per account and identity_monthly_cap site-wide per 30 days \(details\.scope account \| site, used, max\)\. Wait until details\.next_allowed_at/ },
      { status: 503, code: 'identity_not_available', details: {}, hint: /Identity verification is off on this deployment \("me": identity\.enabled false\): no limit depends on it/ },
      { status: 403, code: 'human_only', details: {}, hint: /This step is the account holder's own, signed in on the website \(for example starting identity verification\): an agent key is never accepted for it\./ },
    ];
    for (const r of refusals) {
      const t = io(ENV_KEY, routes({ [`POST /v1/tasks/${UUID_A}/applications`]: { status: r.status, json: { error: { code: r.code, status: r.status, message: `${r.code} sentence.`, details: r.details }, next_step: `${r.code} next step.` } } }));
      assert.equal(await run(['apply', UUID_A], t.cli), 1, r.code);
      assert.match(t.err(), new RegExp(`${r.code} \\(HTTP ${r.status}\\): ${r.code} sentence\\.`), r.code);
      assert.match(t.err(), new RegExp(`Next step: ${r.code} next step\\.`), r.code);
      assert.match(t.err(), r.hint, r.code);
    }
  });
});

describe('cli: help and version aliases, unknown options, --json without a key, capabilities order and medians', () => {
  it('help, -h, version and -v are aliases; "help <command>" prints that command\'s usage', async () => {
    for (const argv of [['help'], ['-h'], ['--help']]) {
      const t = io(ENV);
      assert.equal(await run(argv, t.cli), 0, argv.join(' '));
      assert.equal(t.out(), USAGE, argv.join(' '));
      assert.equal(t.err(), '');
    }
    for (const argv of [['version'], ['-v'], ['--version']]) {
      const t = io(ENV);
      assert.equal(await run(argv, t.cli), 0, argv.join(' '));
      assert.equal(t.out(), `${VERSION}\n`, argv.join(' '));
    }
    const one = io(ENV);
    assert.equal(await run(['help', 'tasks', 'list'], one.cli), 0);
    assert.match(one.out(), /--limit <n>/);
    const short = io(ENV);
    assert.equal(await run(['tasks', 'list', '-h'], short.cli), 0);
    assert.equal(short.out(), one.out());
    assert.equal(one.calls.length + short.calls.length, 0);
  });

  it('an unknown command or option prints one line and a pointer to --help (not the full usage); a trailing unknown option is unknown, not "needs a value"', async () => {
    const unknown = io(ENV);
    assert.equal(await run(['frobnicate'], unknown.cli), 2);
    assert.equal(unknown.err(), 'error: unknown command "frobnicate"\nRun "bountymarket --help" for the commands, or "bountymarket <command> --help" for one command\'s options.\n');
    const trailing = io(ENV);
    assert.equal(await run(['tasks', 'list', '--bogus'], trailing.cli), 2);
    assert.match(trailing.err(), /^error: Unknown option --bogus\n/);
    assert.doesNotMatch(trailing.err(), /needs a value/);
    const missing = io(ENV);
    assert.equal(await run(['tasks', 'list', '--limit'], missing.cli), 2);
    assert.match(missing.err(), /--limit needs a value/);
  });

  it('a key-only command without BOUNTYMARKET_API_KEY prints the agent_api_key_required document on stdout with --json (exit 1), as the MCP server does', async () => {
    const t = io(ENV);
    assert.equal(await run(['me', '--json'], t.cli), 1);
    const doc = JSON.parse(t.out());
    assert.equal(doc.error.code, 'agent_api_key_required');
    assert.equal(doc.error.status, 401);
    assert.equal(doc.error.retryable, false);
    assert.deepEqual(doc.error.details, { owner_url: 'https://web.test/profile', create_key: 'POST /v1/me/agents' });
    assert.match(doc.next_step, /BOUNTYMARKET_API_KEY=bhk_\.\.\./);
    assert.equal(t.err(), '');
    assert.equal(t.calls.length, 0, 'BOUNTYMARKET_WEB_URL names the website: no request');
    const text = io(ENV);
    assert.equal(await run(['me'], text.cli), 1);
    assert.match(text.err(), /BOUNTYMARKET_API_KEY is not set/);
    assert.equal(text.out(), '');
  });

  it('capabilities prints the tier rows and Hunter slots in ladder order whatever the JSON key order, and the medians with their own sample floors and counts', async () => {
    const row = (n: number) => ({ slots: n, total_cap_minor: 10000, per_task_cap_minor: 5000, daily_cap_minor: 10000, posts_per_day: 20, cooling_days: 0 });
    const doc = {
      name: 'BountyMarket', status: 'public_sandbox', mode: 'sandbox', live_charges: false,
      money: { minimum_bounty_minor: 1000, limits_enforced_by: 'tier_rows', fee_schedule: 'fee_tiers' },
      trust: {
        mode: 'enforce', enforced: true,
        setter_rows: { gold: row(4), bronze: row(2), silver: row(3), diamond: row(8), obsidian: row(9), platinum: row(5) },
        hunter_slots: { gold: 5, bronze: 3, silver: 4, diamond: 8, obsidian: 10, platinum: 6 },
      },
      activity: {
        open_tasks: 2, settled_last_30_days: 1, active_hunters_last_30_days: 1,
        median_hours_to_first_application_last_30_days: 2, median_hours_to_acceptance_last_30_days: null,
        median_samples_last_30_days: { first_application: 4, acceptance: 2, listing_approval: 0 },
      },
      review: { new_setter_first_listings: 0, target_hours: 24, median_hours_to_approval_last_30_days: null },
    };
    const t = io(ENV, routes({ 'GET /v1/capabilities': { json: doc } }));
    assert.equal(await run(['capabilities'], t.cli), 0);
    const tiers = [...t.out().matchAll(/^\s{4}(\w+)\s+\d+ slots/gm)].map((m) => m[1]);
    assert.deepEqual(tiers, ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'obsidian']);
    assert.match(t.out(), /Hunter slots [^\n]*: bronze 3, silver 4, gold 5, platinum 6, diamond 8, obsidian 10\n/);
    assert.match(t.out(), /median 2 h to first application, median n\/a \(fewer than 5 samples; 2 so far\) from application to acceptance/);
    assert.match(t.out(), /recent median n\/a \(fewer than 3 samples; 0 so far\) from posting to approval/);
  });
});
