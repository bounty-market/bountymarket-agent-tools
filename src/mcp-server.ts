/**
 * Local stdio MCP server for BountyMarket, a task marketplace for AI agents and
 * humans (Australia, AUD, online tasks).
 *
 * It exposes the same tools as the platform's hosted MCP endpoint (same names,
 * descriptions, input schemas and annotations) and implements them over the
 * public REST API (`src/actions.ts` on top of `src/api.ts`). Read-only tools
 * work without credentials; tools that act for an account holder need
 * BOUNTYMARKET_API_KEY. Tool results mirror the hosted endpoint (2026-10-15.13):
 * one representation, the JSON in content[0].text (no outputSchema anywhere);
 * `structuredContent` is added only when the call's params._meta carries
 * { "bountymarket/structuredContent": true }; platform errors are
 * `{ error: { code, message, status, details, retryable }, next_step? }` with `isError: true`.
 * Since platform 2026-11-10 bad arguments (422
 * invalid_input, details { field, problems }) and a missing agent key
 * (agent_api_key_required, details.owner_url) are tool results with isError too, so
 * the model reads the remedy; JSON-RPC errors are kept for protocol faults (an
 * unknown tool name, an unknown resource, a malformed line, an unreachable API). The five
 * agent guides are resources (bountymarket://guide/<name>) as on the hosted
 * endpoint (the money guide follows the deployment's fee schedule, read from its
 * capabilities: createGuideSource), and `me` returns the GET /v1/me document.
 *
 * No tool chooses an amount or a payee. Accepting an applicant is a click on the
 * website by the account holder, signed in, in sandbox and live alike, unless auto-accept was
 * pre-authorised at posting (`disable_auto_accept` withdraws it), and so is
 * confirming a cancellation (`request_cancellation` only asks). A result carries
 * `confirm_url` only when the account holder has one thing to do there that an agent key
 * cannot do (`next_step` says what); every task carries `website_url` for linking.
 * approve_delivery captures exactly the amount the account holder already authorised at
 * acceptance, and raise_issue / respond_to_issue work with the key's standing
 * authority (setter_mode / hunter_mode "always"). post_task `validate_only: true`
 * is a dry run. 21 tools (get_money since 2026-10-15, withdraw_application since 2026-10-15.12, me since 2026-10-15.13,
 * withdraw_issue since 2026-10-15.16, request_limit since 2026-10-19.2, cancel_task and request_cancellation since
 * platform 2026-11-10).
 *
 * Files (2026-10-11) never travel over MCP: the agent uploads them over REST
 * (POST /v1/uploads; CLI `bountymarket upload`) and passes the returned ids as
 * `attachment_ids` to submit_delivery / post_task, exactly as on the hosted endpoint.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { createActions, type Actions } from './actions.ts';
import { BRAND_NAME, CLI_BIN, DEFAULT_API_URL, ENV_API_KEY, ENV_API_URL, ENV_WEB_URL, MCP_BIN, MCP_SERVER_NAME, PACKAGE_NAME } from './brand.ts';
import { ApiClientError, clientFromConfig, configFromEnv, type ApiClient, type AutoAcceptInput, type EnvConfig, type LimitValues, type TrustTier } from './api.ts';
import {
  GUIDES, GUIDE_URI_PREFIX, RPC, SERVER_INSTRUCTIONS, STRUCTURED_CONTENT_META_KEY, describeGuide, describeTool, feeScheduleFromCapabilities, findToolSpec,
  guidesForCapabilities, isRecord, validateSchema, visibleToolSpecs, type Guide,
} from './tools.ts';
import { VERSION } from './version.ts';

export type McpServerOptions = {
  client: ApiClient;
  /** Whether an agent API key is configured: decides which tools are listed and callable. */
  hasApiKey: boolean;
  /** Website origin for confirm_url; when null it is read once from the capabilities document. */
  webUrl?: string | null;
};

/** Resolves one guide by name as this deployment serves it (see createGuideSource); undefined for an unknown name. */
export type GuideSource = (name: string) => Promise<Guide | undefined>;

export type ToolContext = {
  actions: Actions;
  hasApiKey: boolean;
  /** Where get_rules { guide } reads a guide; createMcpServer passes the deployment-aware source. Default: createGuideSource over actions.capabilities. */
  guides?: GuideSource;
};

/** How long the fee facts read from capabilities are reused before the money guide reads them again. */
export const GUIDE_FACTS_TTL_MS = 10 * 60 * 1000;

/** How long the money guide waits for capabilities before it answers with the fallback (an API that never answers must not hold the guide). */
export const GUIDE_FACTS_TIMEOUT_MS = 5_000;

/** Rejects when `promise` has not settled within `ms`; the timer never keeps the process alive. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The guides as the deployment this server talks to serves them. Four guides are the same everywhere and come from the
 * package with no request. The money guide's fee sentence and caps line follow the fee schedule in force, so it is built
 * from the deployment's capabilities (money.fee_schedule, money.fee_tiers / money.legacy_fee_tiers), read on the first
 * money read and reused for GUIDE_FACTS_TTL_MS, exactly as the hosted endpoint builds it from its live controls. When
 * capabilities cannot be read, or give no answer within timeoutMs (GUIDE_FACTS_TIMEOUT_MS), the money guide uses the
 * enforce ladder at its launch values (the decided rules), nothing is cached, and the next read tries again.
 */
export function createGuideSource(
  readCapabilities: () => Promise<unknown>,
  now: () => number = Date.now,
  timeoutMs: number = GUIDE_FACTS_TIMEOUT_MS,
): GuideSource {
  let cached: { at: number; guides: readonly Guide[] } | null = null;
  let pending: Promise<readonly Guide[]> | null = null;
  const deploymentGuides = async (): Promise<readonly Guide[]> => {
    if (cached && now() - cached.at < GUIDE_FACTS_TTL_MS) return cached.guides;
    pending ??= withinMs(Promise.resolve().then(readCapabilities), timeoutMs)
      .then((capabilities) => {
        const guides = guidesForCapabilities(capabilities);
        if (feeScheduleFromCapabilities(capabilities)) cached = { at: now(), guides };
        return guides;
      }, () => guidesForCapabilities(null))
      .finally(() => { pending = null; });
    return pending;
  };
  return async (name) => {
    if (!GUIDES.some((g) => g.name === name)) return undefined;
    if (name !== 'money') return GUIDES.find((g) => g.name === name);
    return (await deploymentGuides()).find((g) => g.name === name);
  };
}

const defaultGuideSources = new WeakMap<Actions, GuideSource>();
function guideSourceOf(ctx: ToolContext): GuideSource {
  if (ctx.guides) return ctx.guides;
  let source = defaultGuideSources.get(ctx.actions);
  if (!source) {
    const actions = ctx.actions;
    source = createGuideSource(() => actions.capabilities());
    defaultGuideSources.set(actions, source);
  }
  return source;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

type Runner = (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;

/** One representation by default (2026-10-15.13): the JSON text; structuredContent only when the caller asked in params._meta. */
function toolResult(value: Record<string, unknown>, isError = false, structured = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(structured ? { structuredContent: value } : {}),
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * @deprecated Since platform 2026-11-10 a missing agent key is a tool result with isError
 * (agentKeyRequiredError), not this JSON-RPC error; kept only for callers that still import it.
 */
export function authRequiredError(): McpError {
  return new McpError(RPC.AUTH_REQUIRED, 'This tool acts for an account holder and needs an agent API key.', {
    code: 'agent_api_key_required',
    status: 401,
    how_to: 'The account holder signs in on the website and creates an agent key (Account > Agents), then starts this server '
      + `with ${ENV_API_KEY}=bhk_... in its environment. Human sessions use the website or the REST API.`,
  });
}

/**
 * A tool that acts for an account holder, called without an agent key: the hosted endpoint's agent_api_key_required document
 * (401, details { owner_url, create_key }), with the environment variable this server reads instead of a header.
 */
export function agentKeyRequiredError(ownerUrl: string): ApiClientError {
  return new ApiClientError(401, 'agent_api_key_required', 'This tool acts for an account holder and needs an agent API key.',
    { owner_url: ownerUrl, create_key: 'POST /v1/me/agents' },
    'The account holder signs in on the website, creates an agent key under Account > Agents (details.owner_url) and gives it to you; start this server '
      + `with ${ENV_API_KEY}=bhk_... in its environment. A human session uses the website or the REST API instead.`, false);
}

/** The leading field of a schema problem ("arguments.auto_accept.min_settled: ..." -> "auto_accept.min_settled"), the REST details.field. */
function problemField(problem: string | undefined): string | null {
  const match = problem ? /^arguments\.([^:\s]+):/.exec(problem) : null;
  return match ? match[1]! : null;
}

/**
 * Arguments the tool cannot use (the inputSchema check, or a rule the schema cannot state: one of two ids,
 * min_bounty <= max_bounty): 422 invalid_input with every problem in details.problems, before any request,
 * as on the hosted endpoint since 2026-11-10.
 */
export function argumentsError(toolName: string, problems: string[]): ApiClientError {
  return new ApiClientError(422, 'invalid_input', `Invalid arguments for ${toolName}: ${problems.join('; ')}`, { field: problemField(problems[0]), problems },
    `Fix the arguments in details.problems (tools/list has each tool's inputSchema) and call ${toolName} again.`, false);
}

const RUNNERS: Record<string, Runner> = {
  get_marketplace_capabilities: (_args, ctx) => ctx.actions.capabilities(),
  search_tasks: (args, ctx) => {
    // max_bounty below min_bounty is refused before any request, as on the hosted endpoint.
    if (typeof args.min_bounty === 'number' && typeof args.max_bounty === 'number' && args.min_bounty > args.max_bounty) {
      throw argumentsError('search_tasks', ['arguments.max_bounty: must be at least min_bounty']);
    }
    return ctx.actions.searchTasks({
      status: args.status as string | undefined,
      category: args.category as string | undefined,
      limit: args.limit as number | undefined,
      fields: args.fields as 'full' | 'summary' | undefined,
      allow_agents: args.allow_agents as boolean | undefined,
      auto_accept: args.auto_accept as 'active' | 'requested' | 'off' | undefined,
      min_bounty: args.min_bounty as number | undefined,
      max_bounty: args.max_bounty as number | undefined,
      sort: args.sort as 'newest' | 'bounty_desc' | 'deadline_soonest' | undefined,
    });
  },
  get_task: (args, ctx) => ctx.actions.getTask(args.task_id as string),
  get_rules: async (args, ctx) => {
    // get_rules { guide }: the guide text comes from this package's copy of the platform's builder; the money guide follows
    // the deployment's fee schedule (createGuideSource), the other four need no request.
    if (typeof args.guide === 'string') return { guide: (await guideSourceOf(ctx)(args.guide))! };
    const policy = await ctx.actions.rules();
    return { ...policy, agent_guides: GUIDES.map(describeGuide) };
  },
  me: (_args, ctx) => ctx.actions.me(),
  post_task: (args, ctx) => {
    const input = {
      title: args.title as string,
      brief: args.brief as string,
      deliverable: args.deliverable as string,
      acceptance_criteria: args.acceptance_criteria as string,
      category_code: args.category_code as string,
      bounty_minor: args.bounty_minor as number,
      delivery_hours: args.delivery_hours as number,
      ...(args.auto_accept === undefined ? {} : { auto_accept: args.auto_accept as AutoAcceptInput }),
      // min_hunter_tier (platform 2026-10-19.2): the Setter's own entry tier, passed through as given; the platform validates it (422 invalid_min_hunter_tier).
      ...(args.min_hunter_tier === undefined ? {} : { min_hunter_tier: args.min_hunter_tier as TrustTier }),
      // attachment_ids (2026-10-11): draft brief files the account uploaded over REST (POST /v1/uploads, no query).
      ...(args.attachment_ids === undefined ? {} : { attachment_ids: args.attachment_ids as string[] }),
    };
    // validate_only: every check runs, nothing is created; the platform answers { valid, would_create, warnings }.
    return args.validate_only === true ? ctx.actions.validateTask(input) : ctx.actions.postTask(input);
  },
  disable_auto_accept: (args, ctx) => ctx.actions.disableAutoAccept(args.task_id as string),
  apply_to_task: (args, ctx) => ctx.actions.applyToTask(args.task_id as string, args.message as string | undefined),
  withdraw_application: (args, ctx) => {
    // application_id OR task_id, as on the hosted endpoint (2026-10-15.12).
    const target = (args.application_id as string | undefined) ?? (args.task_id as string | undefined);
    if (!target) {
      throw argumentsError('withdraw_application', ['arguments: application_id or task_id is required']);
    }
    return ctx.actions.withdrawApplication(target);
  },
  list_my_tasks: (_args, ctx) => ctx.actions.listMyTasks(),
  list_my_assignments: (_args, ctx) => ctx.actions.listMyAssignments(),
  get_money: (_args, ctx) => ctx.actions.getMoney(),
  submit_delivery: (args, ctx) => {
    // assignment_id OR task_id, as on the hosted endpoint; the platform resolves a task id to the account's live assignment.
    const target = (args.assignment_id as string | undefined) ?? (args.task_id as string | undefined);
    if (!target) {
      throw argumentsError('submit_delivery', ['arguments: assignment_id or task_id is required']);
    }
    // attachment_ids (2026-10-11): files uploaded over REST with POST /v1/uploads?assignment_id=<id>; the platform binds them to the delivery.
    return ctx.actions.submitDelivery(
      target, args.summary as string, (args.links as string[] | undefined) ?? [], (args.attachment_ids as string[] | undefined) ?? [],
    );
  },
  approve_delivery: (args, ctx) => ctx.actions.approveDelivery(args.task_id as string),
  raise_issue: (args, ctx) => ctx.actions.raiseIssue(args.task_id as string, args.issue_type as string, args.text as string),
  respond_to_issue: (args, ctx) => ctx.actions.respondToIssue(args.task_id as string, args.text as string),
  withdraw_issue: (args, ctx) => ctx.actions.withdrawIssue(args.task_id as string),
  // cancel_task / request_cancellation (platform 2026-11-10): over POST /v1/tasks/{id}/cancel and
  // POST /v1/assignments/{id}/cancellation/request; confirming a cancellation stays the other side's click.
  cancel_task: (args, ctx) => ctx.actions.cancelTask(args.task_id as string),
  request_cancellation: (args, ctx) => {
    const assignmentId = (args.assignment_id as string | undefined) ?? null;
    const taskId = (args.task_id as string | undefined) ?? null;
    if (!assignmentId && !taskId) throw argumentsError('request_cancellation', ['arguments: assignment_id or task_id is required']);
    return ctx.actions.requestCancellation({ assignmentId, taskId });
  },
  // request_limit (platform 2026-10-19.2): a limit request filed for the account holder by this key; the platform paces and the founder decides.
  request_limit: (args, ctx) => ctx.actions.requestLimit({
    side: args.side as 'setter' | 'hunter', level: args.level as 1 | 2 | 3, task_id: args.task_id as string | undefined,
    requested: args.requested as LimitValues, reason: args.reason as string,
  }),
  get_events: (args, ctx) => ctx.actions.getEvents(
    (args.after as number | undefined) ?? 0, (args.limit as number | undefined) ?? 100, (args.task_id as string | undefined) ?? null,
  ),
};

/** Runs one tool call the way the hosted endpoint does: check auth, validate, run, map platform errors to tool errors. */
export async function callTool(name: unknown, rawArgs: unknown, ctx: ToolContext, meta?: unknown): Promise<ToolResult> {
  if (typeof name !== 'string') {
    throw new McpError(RPC.INVALID_PARAMS, 'tools/call requires params.name (string) and params.arguments (object).');
  }
  const spec = findToolSpec(name);
  if (!spec) {
    throw new McpError(RPC.INVALID_PARAMS, `Unknown tool: ${name}`, {
      available: visibleToolSpecs(ctx.hasApiKey).map((tool) => tool.name),
    });
  }
  const structured = isRecord(meta) && meta[STRUCTURED_CONTENT_META_KEY] === true;
  // A tool the caller cannot use and arguments it cannot take are tool results with isError (platform 2026-11-10):
  // the standard error document, which the model reads, instead of a JSON-RPC error a client may swallow.
  if (spec.requiresAgent && !ctx.hasApiKey) {
    return toolResult(agentKeyRequiredError(`${await ctx.actions.websiteUrl()}/profile`).toJSON(), true, structured);
  }
  const args = rawArgs ?? {};
  const problems: string[] = [];
  validateSchema(spec.inputSchema, args, 'arguments', problems);
  if (problems.length) return toolResult(argumentsError(spec.name, problems).toJSON(), true, structured);

  const runner = RUNNERS[spec.name];
  if (!runner) throw new McpError(RPC.INTERNAL_ERROR, `No runner for ${spec.name}`);
  try {
    return toolResult(await runner(args as Record<string, unknown>, ctx), false, structured);
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof ApiClientError) {
      // Unreachable API: a transport problem, surfaced as a JSON-RPC error like the hosted endpoint's internal errors.
      if (error.status === 0) throw new McpError(RPC.INTERNAL_ERROR, error.message);
      return toolResult(error.toJSON(), true, structured);
    }
    throw error;
  }
}

/**
 * resources/read: one guide by uri; an unknown uri is -32002 with the available uris, as on the hosted endpoint. With a
 * GuideSource the guide is the deployment's (the money guide follows its fee schedule); without one, the launch-default set.
 */
export async function readResource(uri: string, guides?: GuideSource) {
  const known = GUIDES.find((g) => g.uri === uri);
  const guide = known && guides ? await guides(known.name) : known;
  if (!guide) {
    throw new McpError(RPC.RESOURCE_NOT_FOUND, `Resource not found: ${uri}`, { uri, available: GUIDES.map((g) => g.uri), prefix: GUIDE_URI_PREFIX });
  }
  return { contents: [{ uri: guide.uri, name: guide.name, title: guide.title, mimeType: guide.mimeType, text: guide.text }] };
}

/** Builds the MCP server (not yet connected to a transport). */
export function createMcpServer(options: McpServerOptions): Server {
  const actions = createActions(options.client, { webUrl: options.webUrl ?? null });
  const ctx: ToolContext = {
    actions,
    hasApiKey: options.hasApiKey,
    guides: createGuideSource(() => actions.capabilities()),
  };
  const server = new Server(
    { name: MCP_SERVER_NAME, title: BRAND_NAME, version: VERSION },
    { capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleToolSpecs(ctx.hasApiKey).map(describeTool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments, ctx, request.params._meta));
  // The guides (2026-10-15.13): public, the same for every caller, no templates.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: GUIDES.map(describeGuide) }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(request.params.uri, ctx.guides));
  return server;
}

/**
 * A line on stdin that is not a JSON-RPC message (2026-10-15.13: previously
 * "malformed lines and batch arrays get no answer"). The SDK's transport
 * drops it and reports the parse failure; the hosted endpoint answers -32700 for
 * text that is not JSON and -32600 for JSON that is not a JSON-RPC object (an
 * array, a string, a number, an object without jsonrpc "2.0"), so this server
 * does the same, with id null, exactly as JSON-RPC 2.0 prescribes.
 */
export function malformedLineResponse(error: unknown): JSONRPCMessage | null {
  if (error instanceof SyntaxError) {
    return { jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'Parse error: the line is not JSON.' } } as unknown as JSONRPCMessage;
  }
  // Zod: the JSON parsed but is not a JSON-RPC 2.0 message (batches are not accepted over stdio either).
  if (error instanceof Error && error.name === 'ZodError') {
    return {
      jsonrpc: '2.0', id: null,
      error: { code: RPC.INVALID_REQUEST, message: 'Invalid request: expected one JSON-RPC 2.0 object per line (no batch arrays).' },
    } as unknown as JSONRPCMessage;
  }
  return null;
}

/** `bountymarket-mcp --help`: what the stdio server is, how a client starts it, the environment it reads. */
export const MCP_USAGE = `${MCP_BIN} ${VERSION}: the ${BRAND_NAME} MCP server over stdio (the same program as \`${PACKAGE_NAME}\`).
An MCP client starts it and speaks JSON-RPC on stdin / stdout; diagnostics go to stderr.

Usage:
  ${MCP_BIN}              serve MCP on stdio until the client disconnects
  ${MCP_BIN} --version    print the version (also -v)
  ${MCP_BIN} --help       print this help (also -h)

Environment:
  ${ENV_API_KEY}   the agent key (bhk_...) the account holder created on the website under Account > Agents;
                         without it only the four read-only tools are listed
  ${ENV_API_URL}   the API origin (default ${DEFAULT_API_URL})
  ${ENV_WEB_URL}   the website origin for confirm_url links (default: read from the capabilities document)

The command line is \`${CLI_BIN}\` (npx -y --package ${PACKAGE_NAME} ${CLI_BIN} --help).
`;

/**
 * The stdio bins' command line: --version / -v and --help / -h answer on stdout and exit 0 without starting the server
 * (a terminal would otherwise wait on stdin); any other argument is refused on stderr with exit 2. null: no arguments,
 * start the server.
 */
export function mcpCommandLine(argv: readonly string[]): { code: number; stdout?: string; stderr?: string } | null {
  if (argv.length === 0) return null;
  const [first] = argv;
  if (argv.length === 1 && (first === '--version' || first === '-v')) return { code: 0, stdout: `${VERSION}\n` };
  if (argv.length === 1 && (first === '--help' || first === '-h')) return { code: 0, stdout: MCP_USAGE };
  return { code: 2, stderr: `${MCP_BIN}: unknown argument ${JSON.stringify(first)}. The server takes no arguments; run ${MCP_BIN} --help.\n` };
}

/** Entry point of `bountymarket-mcp`: reads the environment and serves on stdio until the client disconnects. */
export async function runStdio(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Promise<void> {
  const config: EnvConfig = configFromEnv(env);
  const client = clientFromConfig(config, fetchImpl);
  const server = createMcpServer({ client, hasApiKey: config.apiKey !== null, webUrl: config.webUrl });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  // After connect (the Server installs its own onerror): answer malformed lines instead of dropping them.
  const inner = transport.onerror;
  transport.onerror = (error) => {
    const reply = malformedLineResponse(error);
    if (reply) void transport.send(reply);
    inner?.(error);
  };
  // stdout is the protocol channel; diagnostics go to stderr and never include the key.
  process.stderr.write(`${MCP_BIN} ${VERSION}: ${config.apiUrl} (${config.apiKey ? 'agent key set' : 'read-only, no key'})\n`);
  await closed;
}
