/**
 * End-to-end over an in-memory MCP transport: a real SDK client talks to the
 * real server; the REST API is a fake fetch. No network.
 */
import assert from 'node:assert/strict';
import { LIMIT_REQUEST_STEP, UUID_REQ, sampleLimitRequest } from './fake-fetch.ts';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { createApiClient } from '../src/api.ts';
import { GUIDE_FACTS_TIMEOUT_MS, GUIDE_FACTS_TTL_MS, createGuideSource, createMcpServer } from '../src/mcp-server.ts';
import { GUIDES, RPC, SERVER_INSTRUCTIONS, guidesForCapabilities } from '../src/tools.ts';
import { VERSION } from '../src/version.ts';
import {
  STEP, UUID_A, UUID_B, UUID_C, UUID_D, UUID_FILE, UUID_FILE_2, WEBSITE_URL_A, approvedReview, capturedPayment, emptyParticipant, fakeFetch, heldOwnerTask,
  heldPayment, legacyCapturedPayment, legacyHeldPayment, noPayment, routes, sampleApplication, sampleAssignment, sampleAttachment, sampleBriefFile,
  sampleDelivery, sampleOwnerTask, sampleReview, sampleTask, withoutWebsiteUrl, type FakeHandler,
  sampleMoney,
} from './fake-fetch.ts';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/remote-tools.json', import.meta.url), 'utf8')) as {
  tools: Array<Record<string, unknown> & { name: string; requiresAgent: boolean }>;
  resources: Array<{ uri: string; name: string; title: string; description: string; mimeType: string; text: string }>;
};

const capabilities = {
  name: 'BountyMarket', status: 'public_sandbox', mode: 'sandbox', live_charges: false, currency: 'AUD', server_time: '2026-11-02T00:00:00.000Z', timezone: 'UTC',
  money: {
    minimum_bounty_minor: 1000, max_task_bounty_minor: 10000, new_setter_task_cap_minor: 5000, new_setter_review_count: 1,
    setter_daily_cap_minor: 20000, live_charges_paused: false, live_charges: false,
    fee_holiday_until: null,
    fee_holiday: 'Platform fee is 0% for every Hunter, human or AI agent alike, for tasks accepted before fee_holiday_until; after that the tiers apply. fee_holiday_until is null when no holiday is running.',
  },
  agent_actions: { accept_application: 'human_or_pre_authorised_auto_accept', approve_delivery: 'agent_allowed', raise_issue: 'agent_allowed', respond_to_issue: 'agent_allowed' },
  activity: {
    open_tasks: 1, settled_last_30_days: 0, active_hunters_last_30_days: 0,
    median_hours_to_first_application_last_30_days: null, median_hours_to_acceptance_last_30_days: null, as_of: '2026-11-02T00:00:00.000Z',
  },
  review: {
    new_setter_first_listings: 1, target_hours: 24, median_hours_to_approval_last_30_days: null,
    note: 'The founder aims to review a new Setter\'s first listing within 24 hours of posting (a target, not a guarantee). median_hours_to_approval_last_30_days is the recent median wait (null until 3 listings were reviewed). Independently of the Setter\'s history, a listing whose wording suggests in-person work is held the same way for an online-only check (task review_reasons, event payload review_reasons); if it is online, the founder releases it.',
  },
  caps_autoscale: {
    enabled: true, streak: 0, target: 20, level: 0,
    ceilings: { max_task_bounty_minor: 50000, new_setter_task_cap_minor: 10000, setter_daily_cap_minor: 100000, site_daily_cap_minor: 500000 },
    last_changed_at: null,
    description: 'The money caps grow with the marketplace\'s track record: after streak_target consecutive dispute-free settlements site-wide the caps double, up to their ceilings.',
  },
  confirm_url: 'confirm_url appears in a result ONLY when the owner has one thing only a human can do on the website: accept an applicant by hand, confirm an agent-requested auto-accept (one click), or confirm the other side\'s cancellation request. next_step says which. A result without confirm_url needs no human; every task carries website_url (<PUBLIC_BASE_URL>/task/{id}) for plain linking.',
  links: { website: 'https://web.test', task_page: 'https://web.test/task/{id}', api: 'https://api.test/v1', mcp: 'https://api.test/mcp' },
  links_note: 'api, openapi, mcp, manifest, policy, capabilities, events, tasks and report are built from the origin that answered this request (the API). website, task_page, rules, terms, privacy and contact are built from the public website base (PUBLIC_BASE_URL), which can be a different host.',
};

async function connect(opts: { apiKey?: string; webUrl?: string | null; handler?: FakeHandler }) {
  const fake = fakeFetch(opts.handler ?? routes({ 'GET /v1/capabilities': { json: capabilities } }));
  const api = createApiClient({
    baseUrl: 'https://api.test',
    auth: opts.apiKey ? { kind: 'api_key', apiKey: opts.apiKey } : { kind: 'none' },
    fetch: fake.fetch,
    idempotencyKey: () => 'idem',
  });
  const server = createMcpServer({ client: api, hasApiKey: !!opts.apiKey, webUrl: opts.webUrl });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  /** A tool call; `data` is the JSON decoded from content[0].text (the one representation since 2026-10-15.13). */
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
    const raw = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }) as { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any>; isError?: boolean };
    return { ...raw, data: JSON.parse(raw.content[0]!.text) as Record<string, any> };
  };
  const callError = async (name: string, args: Record<string, unknown> = {}): Promise<McpError> => {
    try {
      await call(name, args);
    } catch (error) {
      if (error instanceof McpError) return error;
      throw error;
    }
    throw new Error(`expected ${name} to fail`);
  };
  /**
   * A refusal the model reads (platform 2026-11-10): bad arguments and a missing agent key are tool results with
   * isError and the standard error document, not JSON-RPC errors. Returns error (code, status, details, retryable) and next_step.
   */
  const refusal = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} should be refused: ${result.content[0]!.text}`);
    return { ...(result.data.error as { code: string; message: string; status: number; retryable: boolean; details: Record<string, any> }), next_step: result.data.next_step as string | undefined };
  };
  const close = async () => { await client.close(); await server.close(); };
  return { client, call, callError, refusal, calls: fake.calls, close };
}

const strip = (tool: Record<string, unknown>) => {
  const { requiresAgent: _requiresAgent, ...rest } = tool;
  return rest;
};

const POST_ARGS = {
  title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable, acceptance_criteria: sampleTask.acceptance_criteria,
  category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24,
};

describe('mcp server: handshake and tool list', () => {
  it('reports itself as bountymarket with instructions and the tools capability', async () => {
    const s = await connect({});
    try {
      assert.deepEqual(s.client.getServerVersion(), { name: 'bountymarket', title: 'BountyMarket', version: VERSION });
      assert.equal(s.client.getInstructions(), SERVER_INSTRUCTIONS);
      // 2026-10-15.13: the short instructions (at most 1,200 characters), the env var in place of the header.
      assert.ok(SERVER_INSTRUCTIONS.length <= 1200, `${SERVER_INSTRUCTIONS.length} chars`);
      assert.match(SERVER_INSTRUCTIONS, /a result with confirm_url means the owner has one thing only a human can do there \(next_step says what\); without it nothing needs a human/);
      assert.match(SERVER_INSTRUCTIONS, /in BOUNTYMARKET_API_KEY and call me first/);
      assert.doesNotMatch(SERVER_INSTRUCTIONS, /Authorization: Bearer/);
      assert.deepEqual(s.client.getServerCapabilities(), { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
    } finally {
      await s.close();
    }
  });

  it('lists only the credential-free tools without a key, and the full remote set with one', async () => {
    const anon = await connect({});
    try {
      const { tools } = await anon.client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['get_marketplace_capabilities', 'search_tasks', 'get_task', 'get_rules']);
    } finally {
      await anon.close();
    }
    const agent = await connect({ apiKey: 'bhk_x' });
    try {
      const { tools } = await agent.client.listTools();
      assert.deepEqual(JSON.parse(JSON.stringify(tools)), snapshot.tools.map(strip));
    } finally {
      await agent.close();
    }
  });
});

describe('mcp server: read-only tools', () => {
  it('get_marketplace_capabilities returns the capabilities document as one JSON text block', async () => {
    const s = await connect({});
    try {
      const result = await s.call('get_marketplace_capabilities');
      assert.deepEqual(result.data, capabilities);
      assert.deepEqual(JSON.parse(result.content[0]!.text), capabilities);
      assert.equal(result.isError, undefined);
      // the fields agents could not tell before: is anyone active, how long applicants wait, are live charges on, how long is founder review, which clock, which links are which
      assert.equal(result.data!.live_charges, false);
      assert.equal(result.data!.mode, 'sandbox');
      assert.equal(result.data!.timezone, 'UTC');
      assert.equal(result.data!.activity.open_tasks, 1);
      assert.equal(result.data!.activity.median_hours_to_first_application_last_30_days, null);
      assert.equal(result.data!.activity.median_hours_to_acceptance_last_30_days, null);
      assert.equal(result.data!.agent_actions.accept_application, 'human_or_pre_authorised_auto_accept');
      assert.equal(result.data!.review.target_hours, 24);
      assert.equal(result.data!.review.median_hours_to_approval_last_30_days, null);
      // 2026-10-08: first listing only, fee holiday (null when off) and the cap auto-scale pass through untouched
      assert.equal(result.data!.review.new_setter_first_listings, 1);
      assert.equal(result.data!.money.new_setter_review_count, 1);
      assert.equal(result.data!.money.fee_holiday_until, null);
      assert.match(result.data!.money.fee_holiday, /0% for every Hunter, human or AI agent alike/);
      assert.deepEqual(result.data!.caps_autoscale.ceilings, { max_task_bounty_minor: 50000, new_setter_task_cap_minor: 10000, setter_daily_cap_minor: 100000, site_daily_cap_minor: 500000 });
      assert.equal(result.data!.caps_autoscale.target, 20);
      assert.match(result.data!.links_note, /built from the origin that answered this request \(the API\)/);
      assert.match(result.data!.confirm_url, /ONLY when the owner has one thing only a human can do/);
    } finally {
      await s.close();
    }
  });

  it('search_tasks defaults to open, forwards filters and returns tasks (each with website_url) with a count', async () => {
    const s = await connect({ handler: routes({ 'GET /v1/tasks': { json: { tasks: [sampleTask], next_before: null } } }) });
    try {
      const result = await s.call('search_tasks', { category: 'data_research', limit: 10 });
      assert.equal(s.calls[0]!.url.href, 'https://api.test/v1/tasks?status=open&category=data_research&limit=10');
      assert.deepEqual(result.data, { tasks: [sampleTask], count: 1 });
      assert.equal(result.data!.tasks[0].website_url, WEBSITE_URL_A);
    } finally {
      await s.close();
    }
  });

  it('search_tasks forwards fields, allow_agents, auto_accept, min_bounty, max_bounty and sort (2026-10-15.12); a keyed row keeps my_application', async () => {
    const summaryRow = { id: UUID_A, title: sampleTask.title, bounty_minor: 2500, delivery_hours: 24, category_code: 'data_research', auto_accept: sampleTask.auto_accept, published_at: sampleTask.published_at, website_url: WEBSITE_URL_A, setter_is_ai_agent: true, my_application: { id: UUID_C, status: 'pending' }, my_assignment: null };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({ 'GET /v1/tasks': { json: { tasks: [summaryRow], next_before: null } } }) });
    try {
      const result = await s.call('search_tasks', { fields: 'summary', allow_agents: true, auto_accept: 'active', min_bounty: 1000, max_bounty: 5000, sort: 'bounty_desc' });
      assert.equal(s.calls[0]!.url.search, '?status=open&fields=summary&allow_agents=true&auto_accept=active&min_bounty=1000&max_bounty=5000&sort=bounty_desc');
      assert.deepEqual(result.data, { tasks: [summaryRow], count: 1 });
      const bad = await s.refusal('search_tasks', { min_bounty: 500, max_bounty: 100 });
      assert.equal(bad.code, 'invalid_input');
      assert.deepEqual(bad.details.problems, ['arguments.max_bounty: must be at least min_bounty']);
      assert.equal(s.calls.length, 1, 'refused before any request');
      const wrong = await s.refusal('search_tasks', { fields: 'brief', sort: 'oldest' });
      assert.deepEqual(wrong.details.problems, ['arguments.fields: must be one of full, summary', 'arguments.sort: must be one of newest, bounty_desc, deadline_soonest']);
    } finally {
      await s.close();
    }
  });

  it('withdraw_application takes application_id or task_id and returns the hosted echo; neither is 422 invalid_input; no key is agent_api_key_required', async () => {
    const echo = { ok: true, application: { id: UUID_C, task_id: UUID_A, status: 'withdrawn' }, next_step: 'Withdrawn: ...' };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/applications/${UUID_C}/withdraw`]: { json: echo },
      [`POST /v1/applications/${UUID_A}/withdraw`]: { status: 409, json: { error: { code: 'application_not_pending', message: 'Not pending.', status: 409 } } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: { role: 'applicant', my_application: { id: UUID_C, status: 'pending', task_id: UUID_A }, assignment: null, deliveries: [], review: null, payment: heldPayment, next_step: 'wait', confirm_hint: null, agent_authority: null } } },
    }) });
    try {
      const byId = await s.call('withdraw_application', { application_id: UUID_C });
      assert.deepEqual(byId.data, echo);
      assert.equal(s.calls.length, 1);
      const byTask = await s.call('withdraw_application', { task_id: UUID_A });
      assert.deepEqual(byTask.data, echo);
      assert.deepEqual(s.calls.slice(1).map((c) => `${c.method} ${c.url.pathname}`), [`POST /v1/applications/${UUID_A}/withdraw`, `GET /v1/tasks/${UUID_A}`, `POST /v1/applications/${UUID_C}/withdraw`]);
      const neither = await s.refusal('withdraw_application', {});
      assert.equal(neither.code, 'invalid_input');
      assert.deepEqual(neither.details.problems, ['arguments: application_id or task_id is required']);
      const tool = (await s.client.listTools()).tools.find((t) => t.name === 'withdraw_application')!;
      assert.deepEqual(tool.annotations, { destructiveHint: false });
      assert.equal(tool.title, 'Withdraw application');
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['application_id', 'task_id']);
    } finally {
      await s.close();
    }
    const anon = await connect({});
    try {
      const error = await anon.refusal('withdraw_application', { task_id: UUID_A });
      assert.equal(error.code, 'agent_api_key_required');
    } finally {
      await anon.close();
    }
  });

  it('rejects invalid arguments with a 422 invalid_input tool result (details.field, details.problems), before any request', async () => {
    const s = await connect({});
    try {
      const error = await s.refusal('search_tasks', { status: 'bogus', limit: 500 });
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.status, 422);
      assert.equal(error.retryable, false);
      assert.equal(error.details.field, 'status', 'the leading problem names the field, as REST details.field');
      assert.match(error.next_step ?? '', /Fix the arguments in details\.problems .* and call search_tasks again\./);
      assert.deepEqual(error.details.problems, [
        'arguments.status: must be one of open, assigned, delivered, issue_raised, approved, auto_confirmed',
        'arguments.limit: must be <= 50',
      ]);
      // 2026-10-11.2: a retired launch code and a window over 96 hours are refused before any request, as on the hosted endpoint.
      const keyed = await connect({ apiKey: 'bhk_x' });
      try {
        const old = await keyed.refusal('post_task', { ...POST_ARGS, category_code: 'digital_online', delivery_hours: 97 });
        assert.equal(old.code, 'invalid_input');
        assert.deepEqual(old.details.problems, [
          'arguments.category_code: must be one of testing_qa, writing_editing, data_research, design_media, code_automation, translation_language, feedback_advice, other',
          'arguments.delivery_hours: must be <= 96',
        ]);
        assert.equal(keyed.calls.length, 0);
      } finally {
        await keyed.close();
      }
      assert.equal(s.calls.length, 0);
    } finally {
      await s.close();
    }
  });

  it('get_task without a key returns only the public task (no participant key at all)', async () => {
    const s = await connect({ handler: routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: sampleTask });
      assert.equal('participant' in result.data!, false);
      assert.equal(s.calls[0]!.headers.authorization, undefined);
    } finally {
      await s.close();
    }
  });

  it('get_task with a key that takes no part in the task returns participant: null (present, null)', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({ [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: null } } }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: sampleTask, participant: null });
      assert.equal(s.calls[0]!.headers.authorization, 'Bearer bhk_x');
    } finally {
      await s.close();
    }
    // An older deployment that leaves the key out: with credentials the local tool still says participant: null.
    const old = await connect({ apiKey: 'bhk_x', handler: routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask } }) });
    try {
      const result = await old.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: sampleTask, participant: null });
    } finally {
      await old.close();
    }
  });

  it('platform errors become tool errors carrying the error document', async () => {
    const s = await connect({ handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { status: 404, json: { error: { code: 'task_not_found', message: 'task_not_found', status: 404 } } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.equal(result.isError, true);
      assert.deepEqual(result.data, { error: { code: 'task_not_found', message: 'task_not_found', status: 404, retryable: false } });
    } finally {
      await s.close();
    }
  });

  it('an unreachable API is an INTERNAL_ERROR naming the origin', async () => {
    const s = await connect({ handler: () => { throw new TypeError('fetch failed'); } });
    try {
      const error = await s.callError('get_rules');
      assert.equal(error.code, RPC.INTERNAL_ERROR);
      assert.match(error.message, /https:\/\/api\.test/);
    } finally {
      await s.close();
    }
  });
});

describe('mcp server: agent tools', () => {
  it('refuse without a key with the hosted agent_api_key_required tool result (owner_url, create_key, the environment variable), before any platform action', async () => {
    const s = await connect({});
    try {
      for (const name of ['me', 'post_task', 'disable_auto_accept', 'apply_to_task', 'list_my_tasks', 'list_my_assignments', 'get_money', 'submit_delivery', 'approve_delivery', 'raise_issue', 'respond_to_issue', 'withdraw_issue', 'cancel_task', 'request_cancellation', 'get_events', 'request_limit']) {
        const error = await s.refusal(name, {});
        assert.equal(error.code, 'agent_api_key_required', name);
        assert.equal(error.status, 401);
        assert.equal(error.retryable, false);
        assert.deepEqual(error.details, { owner_url: 'https://web.test/profile', create_key: 'POST /v1/me/agents' });
        assert.match(error.next_step ?? '', /BOUNTYMARKET_API_KEY=bhk_\.\.\./);
      }
      // The only request is the website lookup for owner_url (capabilities links.website), once.
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), ['GET /v1/capabilities']);
      const unknown = await s.callError('accept_application');
      assert.equal(unknown.code, RPC.INVALID_PARAMS);
      assert.deepEqual((unknown.data as { available: string[] }).available, ['get_marketplace_capabilities', 'search_tasks', 'get_task', 'get_rules']);
    } finally {
      await s.close();
    }
  });

  it('post_task sends the key and returns the task (with website_url) and the platform\'s next_step; no confirm_url when nothing needs a human', async () => {
    const posted = { ...sampleOwnerTask, status: 'open' };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 201, json: { ...posted, next_step: STEP.setterOpen } },
      'GET /v1/capabilities': { json: capabilities },
    }) });
    try {
      const result = await s.call('post_task', POST_ARGS);
      const post = s.calls.find((c) => c.method === 'POST')!;
      assert.equal(post.headers.authorization, 'Bearer bhk_x');
      assert.equal(post.headers['idempotency-key'], 'idem');
      assert.deepEqual(post.body, POST_ARGS, 'no auto_accept or validate_only member unless given');
      assert.deepEqual(result.data, { task: posted, next_step: STEP.setterOpen });
      assert.equal('confirm_url' in result.data!, false, 'an open task without applications has nothing for a human to do');
      assert.equal(result.data!.task.website_url, WEBSITE_URL_A);
      assert.equal(s.calls.length, 1, 'the platform supplied everything: no capabilities round trip');
    } finally {
      await s.close();
    }
  });

  it('post_task for a new Setter: pending_review with the review hold, the median hint and the delivery clock in next_step, no confirm_url', async () => {
    const pending = { ...sampleOwnerTask, status: 'pending_review', published_at: null };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 201, json: { ...pending, next_step: STEP.postedPendingReview } },
    }) });
    try {
      const result = await s.call('post_task', POST_ARGS);
      assert.equal(result.data!.task.status, 'pending_review');
      assert.match(result.data!.next_step, /awaits founder review: .*target 24 hours, a target, not a guarantee; capabilities\.review\.median_hours_to_approval_last_30_days gives the recent median/);
      assert.match(result.data!.next_step, /task\.pending_review is in your event feed now/);
      assert.match(result.data!.next_step, /24-hour delivery clock starts at acceptance, not at posting/);
      assert.match(result.data!.next_step, /Nothing to do yet; follow it at website_url\.$/);
      assert.equal('confirm_url' in result.data!, false);
      assert.equal(result.data!.task.website_url, WEBSITE_URL_A);
    } finally {
      await s.close();
    }
  });

  it('post_task for a listing the screen held for an online-only check: pending_review whatever the Setter\'s history, review_reasons on the task, next_step opens with the hold sentence, no confirm_url', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 201, json: { ...heldOwnerTask, next_step: STEP.postedHeldForOnlineCheck } },
    }) });
    try {
      const result = await s.call('post_task', { ...POST_ARGS, title: heldOwnerTask.title });
      assert.deepEqual(result.data, { task: heldOwnerTask, next_step: STEP.postedHeldForOnlineCheck });
      assert.deepEqual(result.data!.task.review_reasons, ['offline_task']);
      assert.ok(result.data!.next_step.startsWith('Your listing is held for a founder check because it looks like it may need in-person work (BountyMarket is online-only at launch). If it is online, no action is needed; the founder will release it.'));
      assert.match(result.data!.next_step, /review_reasons: offline_task/);
      assert.equal('confirm_url' in result.data!, false);
    } finally {
      await s.close();
    }
    // An older deployment that returns review_reasons but no next_step: the same words from the fallback.
    const old = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 201, json: withoutWebsiteUrl(heldOwnerTask) },
      'GET /v1/capabilities': { json: capabilities },
    }) });
    try {
      const result = await old.call('post_task', { ...POST_ARGS, title: heldOwnerTask.title });
      assert.equal(result.data!.next_step, STEP.postedHeldForOnlineCheck);
      assert.equal(result.data!.task.website_url, WEBSITE_URL_A);
      assert.equal('confirm_url' in result.data!, false);
    } finally {
      await old.close();
    }
    // get_task for the Setter of a held listing says the same thing.
    const get = await connect({ apiKey: 'bhk_x', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...heldOwnerTask, participant: { role: 'setter', applications: [], ...emptyParticipant } } },
      'GET /v1/capabilities': { json: capabilities },
    }) });
    try {
      const result = await get.call('get_task', { task_id: UUID_A });
      assert.equal(result.data!.participant.next_step, STEP.postedHeldForOnlineCheck);
      assert.deepEqual(result.data!.task.review_reasons, ['offline_task']);
      assert.equal('confirm_url' in result.data!.participant, false);
    } finally {
      await get.close();
    }
  });

  it('post_task against an older deployment that omits website_url and next_step fills both from the same rules (and still no confirm_url)', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 201, json: { ...withoutWebsiteUrl(sampleOwnerTask), status: 'pending_review' } },
      'GET /v1/capabilities': { json: capabilities },
    }) });
    try {
      const result = await s.call('post_task', POST_ARGS);
      assert.equal(result.data!.next_step, STEP.postedPendingReview);
      assert.equal(result.data!.task.website_url, WEBSITE_URL_A, 'website from capabilities.links, /task/ path');
      assert.equal('confirm_url' in result.data!, false);
      assert.equal('auto_accept_status' in result.data!, false);
    } finally {
      await s.close();
    }
  });

  it('post_task with auto_accept from an agent key: pending_owner_confirmation and the platform\'s ?confirm=auto_accept confirm_url', async () => {
    const terms = { enabled: true, allow_agents: false, min_settled: 2, active: false, confirmed_at: null };
    const confirmUrl = `${WEBSITE_URL_A}?confirm=auto_accept`;
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      'POST /v1/tasks': {
        status: 201,
        json: { ...sampleOwnerTask, bounty_minor: 1300, auto_accept: terms, auto_accept_status: 'pending_owner_confirmation', confirm_url: confirmUrl, next_step: STEP.setterOpenAwaiting },
      },
    }) });
    try {
      const args = { ...POST_ARGS, bounty_minor: 1300, delivery_hours: 12, auto_accept: { enabled: true, allow_agents: false, min_settled: 2 } };
      const result = await s.call('post_task', args);
      assert.deepEqual(s.calls[0]!.body, args);
      assert.deepEqual(result.data, {
        task: { ...sampleOwnerTask, bounty_minor: 1300, auto_accept: terms },
        next_step: STEP.setterOpenAwaiting,
        auto_accept_status: 'pending_owner_confirmation',
        confirm_url: confirmUrl,
      });
      assert.ok(result.data!.next_step.startsWith('Confirm auto-accept at confirm_url (one click;'));
      assert.equal('auto_accept_status' in result.data!.task, false, 'the task document stays the owner view');
    } finally {
      await s.close();
    }
    // Older deployment, new Setter: the one click comes first in next_step and confirm_url is the confirmation page.
    const old = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      'POST /v1/tasks': { status: 201, json: { ...withoutWebsiteUrl(sampleOwnerTask), status: 'pending_review', published_at: null, auto_accept: { ...terms, allow_agents: true, min_settled: 0 } } },
    }) });
    try {
      const result = await old.call('post_task', { ...POST_ARGS, auto_accept: { enabled: true } });
      assert.equal(result.data!.next_step, STEP.postedPendingReviewAwaiting);
      assert.equal(result.data!.auto_accept_status, 'pending_owner_confirmation');
      assert.equal(result.data!.confirm_url, confirmUrl);
      assert.equal(result.data!.task.website_url, WEBSITE_URL_A);
    } finally {
      await old.close();
    }
  });

  it('post_task validate_only runs the platform\'s dry run and returns { valid, would_create, warnings } without creating anything', async () => {
    const dry = {
      valid: true,
      would_create: {
        ...sampleOwnerTask, id: null, website_url: null, published_at: null, created_at: null, status: 'pending_review',
        auto_accept: { enabled: true, allow_agents: true, min_settled: 0, active: false, confirmed_at: null }, auto_accept_status: 'pending_owner_confirmation',
      },
      warnings: [
        { code: 'listing_will_be_reviewed', message: 'A new Setter\'s first listing is reviewed by the founder before becoming visible: this task would be created as pending_review (target 24 hours, a target, not a guarantee; see capabilities.review).' },
        { code: 'auto_accept_needs_owner_confirmation', message: 'auto_accept was requested by an agent key: it would stay pending_owner_confirmation (nothing automatic) until the owner confirms with one click at confirm_url (https://web.test/task/{id}?confirm=auto_accept).' },
        { code: 'no_saved_card', message: 'The owner has no saved card. Posting works, but no application can be accepted (412 payment_method_required) and auto-accept would fail with payment_failed until the owner saves a card on the website.' },
      ],
    };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': (call) => ((call.body as Record<string, unknown>).validate_only === true ? { status: 200, json: dry } : { status: 500, json: {} }),
    }) });
    try {
      const result = await s.call('post_task', { ...POST_ARGS, auto_accept: { enabled: true }, validate_only: true });
      assert.deepEqual(s.calls[0]!.body, { ...POST_ARGS, auto_accept: { enabled: true }, validate_only: true });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.data, dry);
      assert.deepEqual(result.data!.warnings.map((w: { code: string }) => w.code), ['listing_will_be_reviewed', 'auto_accept_needs_owner_confirmation', 'no_saved_card']);
    } finally {
      await s.close();
    }
    const refused = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 422, json: { error: { code: 'bounty_above_new_setter_cap', message: 'New Setters may offer at most A$50 per task.', status: 422 } } },
    }) });
    try {
      const result = await refused.call('post_task', { ...POST_ARGS, bounty_minor: 6000, validate_only: true });
      assert.equal(result.isError, true);
      assert.equal(result.data!.error.code, 'bounty_above_new_setter_cap', 'a failed check is the ordinary error');
    } finally {
      await refused.close();
    }
  });

  it('disable_auto_accept withdraws the opt-in and returns the state-aware next_step; confirm_url only when an applicant now waits for the owner', async () => {
    const off = { ...sampleOwnerTask, auto_accept: { enabled: false, allow_agents: true, min_settled: 0, active: false, confirmed_at: null } };
    const quiet = { ...off, participant: { role: 'setter', applications: [], ...emptyParticipant, next_step: STEP.setterOpen, confirm_hint: STEP.setterOpen } };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: off },
      [`GET /v1/tasks/${UUID_A}`]: { json: quiet },
    }) });
    try {
      const result = await s.call('disable_auto_accept', { task_id: UUID_A });
      assert.equal(s.calls[0]!.method, 'POST');
      assert.equal(s.calls[0]!.headers['idempotency-key'], 'idem');
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), [`POST /v1/tasks/${UUID_A}/auto-accept/disable`, `GET /v1/tasks/${UUID_A}`]);
      assert.deepEqual(result.data, { task: off, next_step: `Auto-accept is off. ${STEP.setterOpen}` });
    } finally {
      await s.close();
    }
    const waiting = { ...off, participant: { role: 'setter', applications: [sampleApplication], ...emptyParticipant, next_step: STEP.setterPending, confirm_hint: STEP.setterPending, confirm_url: WEBSITE_URL_A }, confirm_url: WEBSITE_URL_A };
    const pending = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: off },
      [`GET /v1/tasks/${UUID_A}`]: { json: waiting },
    }) });
    try {
      const result = await pending.call('disable_auto_accept', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: off, confirm_url: WEBSITE_URL_A, next_step: `Auto-accept is off. ${STEP.setterPending}` });
    } finally {
      await pending.close();
    }
    const notMine = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { status: 403, json: { error: { code: 'not_task_setter', message: 'Only the Setter can do this.', status: 403 } } },
    }) });
    try {
      const refused = await notMine.call('disable_auto_accept', { task_id: UUID_A });
      assert.equal(refused.isError, true);
      assert.equal(refused.data!.error.code, 'not_task_setter');
    } finally {
      await notMine.close();
    }
  });

  it('post_task surfaces auto_accept_bounty_above_cap as a tool error', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 422, json: { error: { code: 'auto_accept_bounty_above_cap', message: 'Auto-accept is only for bounties up to A$50.', status: 422 } } },
    }) });
    try {
      const result = await s.call('post_task', { title: sampleTask.title, brief: sampleTask.brief, deliverable: 'doc', acceptance_criteria: 'cited', category_code: 'other', bounty_minor: 6000, delivery_hours: 1, auto_accept: { enabled: true } });
      assert.equal(result.isError, true);
      assert.equal(result.data!.error.code, 'auto_accept_bounty_above_cap');
    } finally {
      await s.close();
    }
  });

  it('post_task surfaces prohibited_task as a tool error with the matched categories', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/tasks': { status: 422, json: { error: { code: 'prohibited_task', message: 'This task matches a prohibited category.', status: 422, details: { categories: ['fake_engagement'] } } } },
    }) });
    try {
      const result = await s.call('post_task', { title: 'Buy 100 five-star reviews', brief: 'b'.repeat(20), deliverable: 'reviews', acceptance_criteria: 'visible', category_code: 'other', bounty_minor: 1000, delivery_hours: 1 });
      assert.equal(result.isError, true);
      assert.deepEqual(result.data!.error.details, { categories: ['fake_engagement'] });
    } finally {
      await s.close();
    }
  });

  it('get_task for the Setter of a delivered task passes the complete participant view through (one request; no confirm_url: approving is the agent\'s own tool)', async () => {
    const accepted = { ...sampleApplication, status: 'accepted', decided_at: '2026-10-05T02:00:00.000Z' };
    const participant = {
      role: 'setter', applications: [accepted], assignment: sampleAssignment, deliveries: [sampleDelivery], review: sampleReview, payment: heldPayment,
      next_step: STEP.setterDelivered, confirm_hint: STEP.setterDelivered,
      // The platform says what the key may do (2026-10-11.6); it passes through untouched.
      agent_authority: { setter_mode: 'always', hunter_mode: 'deny' },
    };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test/', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'delivered', participant } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: { ...sampleOwnerTask, status: 'delivered' }, participant });
      assert.deepEqual(s.calls.map((c) => c.url.pathname), [`/v1/tasks/${UUID_A}`], 'the platform supplies deliveries, review and payment');
      assert.equal(result.data!.participant.payment.authorised_minor, 2500, 'what this task holds right now');
      assert.equal(result.data!.participant.payment.hunter_fee_minor, 375, 'the fee is the Hunter\'s');
      assert.equal(result.data!.participant.payment.hunter_net_minor, 2125);
      assert.equal('confirm_url' in result.data!, false);
      assert.equal('confirm_url' in result.data!.participant, false);
      assert.equal(result.data!.participant.review.approved_by, null, 'null until approved');
    } finally {
      await s.close();
    }
  });

  it('get_task for the Setter of an open task: every field present (null / []), a state-aware next_step naming the skipped reason, confirm_url while an applicant waits', async () => {
    const skipped = { ...sampleApplication, auto_accept_skipped_reason: 'agents_not_eligible' };
    const terms = { enabled: true, allow_agents: false, min_settled: 0, active: true, confirmed_at: '2026-10-05T00:30:00.000Z' };
    const participant = {
      role: 'setter', applications: [skipped], ...emptyParticipant,
      next_step: STEP.setterSkipped, confirm_hint: STEP.setterSkipped, confirm_url: WEBSITE_URL_A,
    };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, auto_accept: terms, participant, confirm_url: WEBSITE_URL_A } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      const view = result.data!.participant;
      assert.deepEqual(view, participant);
      assert.equal(view.assignment, null);
      assert.deepEqual(view.deliveries, []);
      assert.equal(view.review, null);
      assert.deepEqual(view.payment, noPayment);
      assert.equal(view.applications[0].auto_accept_skipped_reason, 'agents_not_eligible');
      assert.match(view.next_step, /1 pending application did not qualify for auto-accept \(agents_not_eligible\); accept manually at confirm_url/);
      assert.equal(result.data!.confirm_url, WEBSITE_URL_A);
    } finally {
      await s.close();
    }
  });

  it('get_task for the Setter while an agent-requested auto-accept waits: confirm_url is the ?confirm=auto_accept page and next_step starts with the one click', async () => {
    const pending = { ...sampleOwnerTask, auto_accept: { enabled: true, allow_agents: true, min_settled: 0, active: false, confirmed_at: null } };
    const confirmUrl = `${WEBSITE_URL_A}?confirm=auto_accept`;
    const participant = {
      role: 'setter', applications: [], ...emptyParticipant, next_step: STEP.setterOpenAwaiting, confirm_hint: STEP.setterOpenAwaiting, confirm_url: confirmUrl,
      auto_accept_status: 'pending_owner_confirmation', auto_accept_confirm_url: confirmUrl,
    };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...pending, participant, confirm_url: confirmUrl } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: pending, participant, confirm_url: confirmUrl });
      assert.ok(result.data!.participant.next_step.startsWith('Confirm auto-accept at confirm_url (one click;'));
    } finally {
      await s.close();
    }
  });

  it('get_task against an older deployment\'s short participant block completes it: nulls, [], payment none, the platform\'s next_step wording and the confirm_url rule', async () => {
    const pending = { ...withoutWebsiteUrl(sampleOwnerTask), auto_accept: { enabled: true, allow_agents: true, min_settled: 0, active: false, confirmed_at: null } };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...pending, participant: { role: 'setter', applications: [], assignment: null } } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      const participant = result.data!.participant;
      assert.deepEqual(Object.keys(participant).sort(), [
        'agent_authority', 'applications', 'assignment', 'auto_accept_confirm_url', 'auto_accept_status', 'confirm_hint', 'confirm_url', 'deliveries', 'next_step', 'payment', 'review', 'role',
      ]);
      assert.equal(participant.agent_authority, null, 'an older deployment says nothing about the key: null, like a human session');
      assert.deepEqual(participant.payment, noPayment);
      assert.equal(result.data!.task.website_url, WEBSITE_URL_A, 'website_url filled from BOUNTYMARKET_WEB_URL');
      assert.equal(participant.confirm_url, `${WEBSITE_URL_A}?confirm=auto_accept`, 'the owner\'s one click while the opt-in waits');
      assert.equal(participant.auto_accept_confirm_url, `${WEBSITE_URL_A}?confirm=auto_accept`);
      assert.equal(participant.next_step, participant.confirm_hint);
      assert.equal(participant.next_step, STEP.setterOpenAwaiting, 'word for word the platform\'s text');
      assert.equal(result.data!.confirm_url, participant.confirm_url);
    } finally {
      await s.close();
    }
    // Setter, assigned: nothing for a human to do, so the completed block carries no confirm_url.
    const working = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'assigned', participant: { role: 'setter', applications: [{ ...sampleApplication, status: 'accepted' }], assignment: sampleAssignment, payment: { status: 'held', authorised_minor: 2500, captured_minor: 0, refunded_minor: 0, currency: 'AUD' } } } },
    }) });
    try {
      const result = await working.call('get_task', { task_id: UUID_A });
      const participant = result.data!.participant;
      assert.equal('confirm_url' in participant, false);
      assert.equal('confirm_url' in result.data!, false);
      assert.equal(participant.next_step, STEP.setterAssigned);
      assert.deepEqual(participant.payment, heldPayment, 'the fee fields are taken from the assignment\'s locked fee');
    } finally {
      await working.close();
    }
    // Setter, open with a pending application: the owner has one to accept by hand.
    const pendingApplicant = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, participant: { role: 'setter', applications: [sampleApplication], assignment: null } } },
    }) });
    try {
      const result = await pendingApplicant.call('get_task', { task_id: UUID_A });
      assert.equal(result.data!.participant.confirm_url, WEBSITE_URL_A);
      assert.equal(result.data!.participant.next_step, STEP.setterPending);
    } finally {
      await pendingApplicant.close();
    }
    const applicant = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: { role: 'applicant', application: sampleApplication, assignment: null } } },
    }) });
    try {
      const result = await applicant.call('get_task', { task_id: UUID_A });
      const participant = result.data!.participant;
      assert.deepEqual(participant.my_application, sampleApplication, 'application is renamed my_application');
      assert.equal('confirm_url' in participant, false, 'an applicant has nothing to do on the website');
      assert.equal('confirm_url' in result.data!, false);
      assert.match(participant.next_step, /Your application is pending/);
    } finally {
      await applicant.close();
    }
  });

  it('get_task for an applicant returns my_application with the skipped reason, payment none and no confirm_url', async () => {
    const mine = { ...sampleApplication, auto_accept_skipped_reason: 'agents_not_eligible' };
    const participant = { role: 'applicant', my_application: mine, ...emptyParticipant, next_step: STEP.applicantNotEligible, confirm_hint: STEP.applicantNotEligible };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: sampleTask, participant });
      assert.equal('confirm_url' in result.data!.participant, false);
      assert.match(result.data!.participant.next_step, /does not include AI agents \(auto_accept\.allow_agents is false\)/);
      assert.match(result.data!.participant.next_step, /GET \/v1\/events\?task_id=<id>/);
      assert.match(result.data!.participant.next_step, /median_hours_to_acceptance_last_30_days gives a typical wait/);
    } finally {
      await s.close();
    }
  });

  it('get_task for the Hunter: my_application, the assignment, the held amount with the fee; confirm_url only for the Setter\'s cancellation request', async () => {
    const accepted = { ...sampleApplication, status: 'accepted', decided_at: '2026-10-05T02:00:00.000Z' };
    const working = {
      role: 'hunter', my_application: accepted, assignment: sampleAssignment, deliveries: [], review: null, payment: heldPayment,
      next_step: STEP.hunterAssigned, confirm_hint: STEP.hunterAssigned, agent_authority: null,
    };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'assigned', participant: working } },
    }) });
    try {
      const result = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: { ...sampleTask, status: 'assigned' }, participant: working });
      assert.equal('confirm_url' in result.data!.participant, false, 'delivering is submit_delivery, not a website step');
      assert.match(working.next_step, new RegExp(`submit_delivery \\(task_id ${UUID_A} or assignment_id ${UUID_B}\\)`));
    } finally {
      await s.close();
    }
    const asked = { ...working, next_step: STEP.hunterCancellation, confirm_hint: STEP.hunterCancellation, confirm_url: WEBSITE_URL_A };
    const cancellation = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'assigned', participant: asked, confirm_url: WEBSITE_URL_A } },
    }) });
    try {
      const result = await cancellation.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: { ...sampleTask, status: 'assigned' }, participant: asked, confirm_url: WEBSITE_URL_A });
      assert.match(result.data!.participant.next_step, /^The Setter asked to cancel by mutual agreement: the owner confirms at confirm_url/);
    } finally {
      await cancellation.close();
    }
    const done = {
      role: 'hunter', my_application: accepted, assignment: { ...sampleAssignment, status: 'completed' }, deliveries: [sampleDelivery],
      review: approvedReview, payment: capturedPayment, next_step: STEP.hunterSettled, confirm_hint: STEP.hunterSettled, agent_authority: null,
    };
    const s2 = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'approved', participant: done } },
    }) });
    try {
      const result = await s2.call('get_task', { task_id: UUID_A });
      assert.deepEqual(result.data, { task: { ...sampleTask, status: 'approved' }, participant: done });
      assert.equal('confirm_url' in result.data!.participant, false, 'nothing left to do on the website');
      assert.deepEqual(result.data!.participant.review.approved_by, { user_id: 'u1', agent_id: 'a1', kind: 'ai_agent' });
    } finally {
      await s2.close();
    }
  });

  it('apply_to_task returns the application, assignment (null while pending), auto_accept_outcome and the matching next_step', async () => {
    const skipped = { ...sampleApplication, auto_accept_skipped_reason: 'agents_not_eligible' };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...skipped, assignment: null, auto_accept_outcome: 'agents_not_eligible', next_step: STEP.applicantNotEligible } },
    }) });
    try {
      const applied = await s.call('apply_to_task', { task_id: UUID_A, message: 'I am an AI agent acting for Bob.' });
      assert.deepEqual(applied.data, { application: skipped, assignment: null, auto_accept_outcome: 'agents_not_eligible', next_step: STEP.applicantNotEligible });
      assert.deepEqual(s.calls[0]!.body, { message: 'I am an AI agent acting for Bob.' });
    } finally {
      await s.close();
    }
    const accepted = { ...sampleApplication, status: 'accepted', decided_at: '2026-10-05T02:00:00.000Z' };
    const acceptedStep = `Accepted automatically: the assignment ${UUID_B} is attached and the delivery clock started (deadline_at 2026-10-06T02:00:00.000Z). Deliver with submit_delivery (task_id or assignment_id) before then.`;
    const auto = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...accepted, assignment: sampleAssignment, auto_accept_outcome: 'accepted', next_step: acceptedStep } },
    }) });
    try {
      const applied = await auto.call('apply_to_task', { task_id: UUID_A });
      assert.deepEqual(applied.data, { application: accepted, assignment: sampleAssignment, auto_accept_outcome: 'accepted', payment: heldPayment, next_step: acceptedStep },
        'once accepted the hold is part of the result (2026-10-11.6); folded from the assignment\'s locked fee when the deployment omits it');
      assert.deepEqual(auto.calls[0]!.body, {});
    } finally {
      await auto.close();
    }
    // An older deployment without the outcome: derived from the application status, next_step from the same rules.
    const old = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { ...sampleApplication, assignment: null } },
    }) });
    try {
      const applied = await old.call('apply_to_task', { task_id: UUID_A });
      assert.equal(applied.data!.auto_accept_outcome, 'not_enabled');
      assert.match(applied.data!.next_step, /This task has no auto-accept: the Setter accepts by hand on the website/);
      assert.equal(applied.data!.assignment, null);
    } finally {
      await old.close();
    }
  });

  it('get_money mirrors the hosted ledger document unchanged (platform 2026-10-15.11)', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({ 'GET /v1/me/money': { json: sampleMoney } }) });
    try {
      const money = await s.call('get_money');
      assert.deepEqual(money.data, sampleMoney);
      assert.equal(s.calls.at(-1)!.url.pathname, '/v1/me/money');
      const tool = (await s.client.listTools()).tools.find((t) => t.name === 'get_money')!;
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.match(tool.description ?? '', /never "settled" or "paid out" \(guide money\)/);
      const guide = await s.client.readResource({ uri: 'bountymarket://guide/money' });
      // This fake deployment's capabilities carry no fee facts, so the money guide uses the enforce ladder at its launch values (the decided rules).
      const moneyGuide = (guide.contents[0] as { text: string }).text;
      assert.match(moneyGuide, /the six-tier ladder by lifetime seasoned net earnings is charged \(trust\.mode enforce; capabilities money\.fee_schedule "fee_tiers", money\.fee_tiers\): Bronze 20%, Silver 15% from A\$250 seasoned net earnings/);
      assert.match(moneyGuide, /Caps \(trust\.mode enforce\): minimum A\$10; above that the Setter's tier row limits each posting/);
      assert.match(moneyGuide, /quote those live values, never a remembered table/);
    } finally {
      await s.close();
    }
  });

  it('list_my_tasks, list_my_assignments and get_events mirror the hosted documents; get_events task_id follows one task', async () => {
    const events = [{ seq: 7, id: 'e', type: 'application.created', task_id: UUID_A, assignment_id: null, actor_kind: 'ai_agent', visibility: 'participants', payload: { application_id: UUID_C, auto_accept_outcome: 'accepted' }, created_at: '2026-10-05T02:00:00.000Z' }];
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'GET /v1/me/tasks': { json: { tasks: [sampleTask] } },
      'GET /v1/me/assignments': { json: { assignments: [{ ...sampleAssignment, task: { id: UUID_A, title: sampleTask.title, status: 'assigned', category_code: 'data_research' } }] } },
      'GET /v1/events': { json: { events, next_after: 7 } },
    }) });
    try {
      // pending_owner_action (platform 2026-11-10): null when nothing waits for the owner (a view that cannot be read shows nothing).
      const tasks = await s.call('list_my_tasks');
      assert.deepEqual(tasks.data, { tasks: [{ ...sampleTask, pending_owner_action: null }], count: 1 });

      const assignments = await s.call('list_my_assignments');
      assert.equal(assignments.data!.count, 1);
      assert.equal(assignments.data!.assignments[0].net_minor, 2125);
      assert.equal(assignments.data!.assignments[0].pending_owner_action, null);
      assert.equal('next_step' in assignments.data!.assignments[0], false, 'next_step only when something is pending');

      const feed = await s.call('get_events', { after: 3, limit: 10 });
      assert.equal(s.calls.at(-1)!.url.search, '?after=3&limit=10');
      assert.deepEqual(feed.data, { events, next_after: 7, poll_after_seconds: 30 }, 'an older deployment without poll_after_seconds gets the default');
      assert.equal(feed.data!.events[0].payload.auto_accept_outcome, 'accepted', 'the event payload uses the apply vocabulary');

      const one = await s.call('get_events', { after: 3, limit: 10, task_id: UUID_A });
      assert.equal(s.calls.at(-1)!.url.search, `?after=3&limit=10&task_id=${UUID_A}`);
      assert.deepEqual(one.data, { events, next_after: 7, poll_after_seconds: 30 });

      const invalid = await s.refusal('get_events', { task_id: 'nope' });
      assert.equal(invalid.code, 'invalid_input');
      assert.deepEqual(invalid.details.problems, ['arguments.task_id: must be a UUID']);
    } finally {
      await s.close();
    }
  });

  it('submit_delivery posts summary and links, names the assignment, passes the payment and next_step through and reads the stored content_digest back', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [sampleDelivery], review: sampleReview, payment: heldPayment } },
    }) });
    try {
      const result = await s.call('submit_delivery', { assignment_id: UUID_B, summary: 'Done: summary attached.', links: ['https://docs.example/summary'] });
      assert.deepEqual(s.calls[0]!.body, { summary: 'Done: summary attached.', links: ['https://docs.example/summary'] });
      assert.deepEqual(result.data, {
        assignment_id: UUID_B,
        review: sampleReview,
        content_digest: 'sha256:abc',
        // The write-op echo (2026-10-15.12), filled from the read-back when the deployment is older.
        delivery: sampleDelivery,
        assignment: { id: UUID_B, status: 'active' },
        task: { id: UUID_A, status: 'open' },
        payment: heldPayment,
        next_step: STEP.delivered,
      });
      assert.doesNotMatch(JSON.stringify(result.data), /application_fee_minor|amount_minor|capture_before_at/);
    } finally {
      await s.close();
    }
  });

  it('submit_delivery by task_id lets the platform resolve the owner\'s live assignment; the result names it', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/assignments/${UUID_A}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [sampleDelivery], review: sampleReview, payment: heldPayment } },
    }) });
    try {
      const result = await s.call('submit_delivery', { task_id: UUID_A, summary: 'Done.' });
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), [`POST /v1/assignments/${UUID_A}/deliveries`, `GET /v1/assignments/${UUID_B}`]);
      assert.equal(result.data!.assignment_id, UUID_B);
      assert.equal(result.data!.content_digest, 'sha256:abc');
      assert.deepEqual(result.data!.payment, heldPayment);
    } finally {
      await s.close();
    }
  });

  it('submit_delivery with neither id is INVALID_PARAMS before any request; a miss is the platform\'s tailored assignment_not_found', async () => {
    const details = { assignment_id: null, task_id: UUID_A, pending_application_id: UUID_C };
    const message = 'deliver needs an assignment: pass assignment_id (from list_my_assignments, GET /v1/me/assignments or the assignment.created event) or task_id of a task '
      + `where you are the accepted Hunter. No live assignment for you on task ${UUID_A}. Your application ${UUID_C} on this task is still pending: the Setter has not accepted it yet (watch get_events for assignment.created).`;
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/assignments/${UUID_A}/deliveries`]: { status: 404, json: { error: { code: 'assignment_not_found', message, status: 404, details } } },
    }) });
    try {
      const neither = await s.refusal('submit_delivery', { summary: 'Done.' });
      assert.equal(neither.code, 'invalid_input');
      assert.deepEqual(neither.details.problems, ['arguments: assignment_id or task_id is required']);
      assert.equal(s.calls.length, 0);

      const miss = await s.call('submit_delivery', { task_id: UUID_A, summary: 'Done.' });
      assert.equal(miss.isError, true);
      assert.deepEqual(miss.data, { error: { code: 'assignment_not_found', message, status: 404, details, retryable: false } });
      assert.equal(miss.data!.error.details.pending_application_id, UUID_C);
    } finally {
      await s.close();
    }
  });

  it('submit_delivery and post_task pass attachment_ids through (the files went over REST first); the result shapes are the hosted ones and task.attachments / delivery.attachments come back', async () => {
    const delivered = { ...sampleDelivery, attachments: [sampleAttachment], content_digest: 'sha256:withfiles' };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [delivered], review: sampleReview, payment: heldPayment } },
      'POST /v1/tasks': { status: 201, json: { ...sampleOwnerTask, attachments: [sampleBriefFile], next_step: STEP.setterOpen } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'delivered', attachments: [sampleBriefFile], participant: { role: 'setter', applications: [], assignment: sampleAssignment, deliveries: [delivered], review: sampleReview, payment: heldPayment, next_step: STEP.setterDelivered, confirm_hint: STEP.setterDelivered } } },
    }) });
    try {
      const result = await s.call('submit_delivery', { assignment_id: UUID_B, summary: 'Done.', attachment_ids: [UUID_FILE] });
      assert.deepEqual(s.calls[0]!.body, { summary: 'Done.', links: [], attachment_ids: [UUID_FILE] });
      assert.deepEqual(Object.keys(result.data!), ['assignment_id', 'review', 'content_digest', 'delivery', 'assignment', 'task', 'payment', 'next_step'], 'the hosted shape (with the 2026-10-15.12 echo)');
      assert.equal(result.data!.content_digest, 'sha256:withfiles', 'the platform\'s digest covers the attachment ids');

      const invalid = await s.refusal('submit_delivery', { assignment_id: UUID_B, summary: 'Done.', attachment_ids: ['nope'] });
      assert.equal(invalid.code, 'invalid_input');
      assert.deepEqual(invalid.details.problems, ['arguments.attachment_ids[0]: must be a UUID']);

      const posted = await s.call('post_task', { ...POST_ARGS, attachment_ids: [UUID_FILE_2] });
      const postCall = s.calls.find((c) => c.url.pathname === '/v1/tasks')!;
      assert.deepEqual(postCall.body, { ...POST_ARGS, attachment_ids: [UUID_FILE_2] });
      assert.deepEqual(posted.data!.task.attachments, [sampleBriefFile], 'brief files are part of the task document');
      assert.deepEqual(Object.keys(posted.data!), ['task', 'next_step']);

      const before = s.calls.length;
      await s.call('submit_delivery', { assignment_id: UUID_B, summary: 'Done.' });
      assert.deepEqual(s.calls[before]!.body, { summary: 'Done.', links: [] }, 'without attachment_ids the body is unchanged (an older deployment never sees the key)');

      const view = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(view.data!.task.attachments, [sampleBriefFile]);
      assert.deepEqual(view.data!.participant.deliveries[0].attachments, [sampleAttachment], 'the Setter sees the delivered files; GET /v1/files/{id} downloads them');
    } finally {
      await s.close();
    }
  });

  it('submit_delivery still succeeds when the digest cannot be read back; an older deployment\'s payment is folded into the one shape', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { ...sampleReview, payment: heldPayment, next_step: STEP.delivered } },
    }) });
    try {
      const result = await s.call('submit_delivery', { assignment_id: UUID_B, summary: 'Done.' });
      assert.equal(result.isError, undefined);
      assert.equal(result.data!.content_digest, null);
      assert.equal(result.data!.assignment_id, UUID_B);
      assert.deepEqual(result.data!.payment, heldPayment);
    } finally {
      await s.close();
    }
    const { approved_by: _by, ...legacyReview } = sampleReview;
    const old = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: legacyReview },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [sampleDelivery], review: legacyReview, payment: legacyHeldPayment } },
    }) });
    try {
      const result = await old.call('submit_delivery', { assignment_id: UUID_B, summary: 'Done.' });
      assert.deepEqual(result.data!.payment, heldPayment, 'requires_capture / amount_minor / application_fee_minor become the one shape');
      assert.equal(result.data!.next_step, STEP.delivered, 'word for word the platform\'s text');
      assert.deepEqual(result.data!.review, sampleReview, 'approved_by: null is filled in');
    } finally {
      await old.close();
    }
  });
});

describe('mcp server: review tools (Setter side approve and raise_issue, Hunter side respond_to_issue)', () => {
  const setterView = (status: string) => ({
    json: { ...sampleOwnerTask, status, participant: { role: 'setter', applications: [], assignment: sampleAssignment } },
  });

  it('approve_delivery resolves the task\'s live assignment, approves it and passes the review (approved_by), the one payment shape and next_step through', async () => {
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: setterView('delivered'),
      [`POST /v1/assignments/${UUID_B}/approve`]: { json: { ...approvedReview, payment: capturedPayment, next_step: STEP.approved } },
    }) });
    try {
      const result = await s.call('approve_delivery', { task_id: UUID_A });
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), [`GET /v1/tasks/${UUID_A}`, `POST /v1/assignments/${UUID_B}/approve`],
        'the platform answers with the payment: no assignment round trip');
      assert.equal(s.calls[1]!.body, null, 'approve takes no body: no amount is chosen');
      assert.equal(s.calls[1]!.headers['idempotency-key'], 'idem');
      assert.deepEqual(result.data, {
        review: approvedReview, delivery: null, assignment: { id: UUID_B, status: 'completed' }, task: { id: UUID_A, status: 'approved' },
        payment: capturedPayment, next_step: STEP.approved,
      });
      assert.deepEqual(result.data!.review.approved_by, { user_id: 'u1', agent_id: 'a1', kind: 'ai_agent' });
      assert.equal(result.data!.payment.hunter_fee_minor, 375, 'the fee is the Hunter\'s; the Setter paid exactly captured_minor');
      assert.doesNotMatch(JSON.stringify(result.data), /application_fee_minor|amount_minor|capture_before_at/);
    } finally {
      await s.close();
    }
  });

  it('approve_delivery against an older deployment reads the payment back, folds it into the one shape and words next_step with the amount', async () => {
    const { approved_by: _by, ...legacyReview } = { ...sampleReview, status: 'approved', approved_at: '2026-10-06T00:00:00.000Z' };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: setterView('delivered'),
      [`POST /v1/assignments/${UUID_B}/approve`]: { json: legacyReview },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: { ...sampleAssignment, status: 'completed' }, task: sampleTask, deliveries: [sampleDelivery], review: legacyReview, payment: legacyCapturedPayment } },
    }) });
    try {
      const result = await s.call('approve_delivery', { task_id: UUID_A });
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), [
        `GET /v1/tasks/${UUID_A}`, `POST /v1/assignments/${UUID_B}/approve`, `GET /v1/assignments/${UUID_B}`,
      ]);
      assert.deepEqual(result.data, {
        review: { ...legacyReview, approved_by: null }, delivery: null, assignment: { id: UUID_B, status: 'completed' }, task: { id: UUID_A, status: 'approved' },
        payment: capturedPayment, next_step: STEP.approved,
      });
    } finally {
      await s.close();
    }
  });

  it('approve_delivery is a tool error (404 assignment_not_found) when the task has no live assignment for the owner', async () => {
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, participant: { role: 'setter', applications: [], assignment: null } } },
    }) });
    try {
      const result = await s.call('approve_delivery', { task_id: UUID_A });
      assert.equal(result.isError, true);
      assert.equal(result.data!.error.code, 'assignment_not_found');
      assert.equal(result.data!.error.status, 404);
      assert.equal(s.calls.length, 1, 'nothing is posted');
    } finally {
      await s.close();
    }
  });

  it('approve_delivery passes the platform\'s refusal through (for example live_charges_paused)', async () => {
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: setterView('delivered'),
      [`POST /v1/assignments/${UUID_B}/approve`]: { status: 409, json: { error: { code: 'live_charges_paused', message: 'Live charges are paused.', status: 409 } } },
    }) });
    try {
      const result = await s.call('approve_delivery', { task_id: UUID_A });
      assert.equal(result.isError, true);
      assert.deepEqual(result.data, { error: { code: 'live_charges_paused', message: 'Live charges are paused.', status: 409, retryable: false } });
    } finally {
      await s.close();
    }
  });

  it('raise_issue posts issue_type and the text as detail, and validates the enum and length first', async () => {
    const raised = { ...sampleReview, status: 'issue_raised', issue_type: 'quality_issue', issue_detail: 'The summary covers only two of the three papers.', issue_raised_at: '2026-10-06T00:00:00.000Z', hunter_response_deadline_at: '2026-10-07T00:00:00.000Z' };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: setterView('delivered'),
      [`POST /v1/assignments/${UUID_B}/issues`]: { status: 201, json: raised },
    }) });
    try {
      const result = await s.call('raise_issue', { task_id: UUID_A, issue_type: 'quality_issue', text: 'The summary covers only two of the three papers.' });
      assert.deepEqual(s.calls[1]!.body, { issue_type: 'quality_issue', detail: 'The summary covers only two of the three papers.' });
      assert.deepEqual(result.data, {
        review: raised,
        next_step: 'The Hunter has until hunter_response_deadline_at for their one response (completion.issue_response event). Any time: approve_delivery (captures the full amount, closes the issue), withdraw_issue (the review resumes with at least 24 hours left), or wait for the founder (completion.decided).',
      });
      const invalid = await s.refusal('raise_issue', { task_id: UUID_A, issue_type: 'meh', text: 'short' });
      assert.equal(invalid.code, 'invalid_input');
      assert.deepEqual(invalid.details.problems, [
        'arguments.issue_type: must be one of quality_issue, acceptance_mismatch, late_completion, malicious_non_completion, harassment_or_discrimination, credible_personal_threat',
        'arguments.text: must be at least 20 characters',
      ]);
      assert.equal(s.calls.length, 2, 'the invalid call made no request');
    } finally {
      await s.close();
    }
  });

  it('respond_to_issue posts the Hunter\'s text to the assignment named by the owner\'s hunter view', async () => {
    const answered = { ...sampleReview, status: 'issue_raised', hunter_response: 'All three papers are covered; see page 2.', hunter_response_at: '2026-10-06T12:00:00.000Z' };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'issue_raised', participant: { role: 'hunter', application: null, assignment: sampleAssignment } } },
      [`POST /v1/assignments/${UUID_B}/issue-response`]: { json: answered },
    }) });
    try {
      const result = await s.call('respond_to_issue', { task_id: UUID_A, text: 'All three papers are covered; see page 2.' });
      assert.deepEqual(s.calls[1]!.body, { text: 'All three papers are covered; see page 2.' });
      assert.deepEqual(result.data, {
        review: answered,
        next_step: 'Recorded (the one response). The Setter may approve (completion.approved), withdraw the issue (completion.issue_withdrawn) or leave it to the founder (completion.decided); any released amount (after the platform fee, before Stripe\'s own processing fee) settles to the owner\'s Stripe balance (available after Stripe\'s holding period).',
      });
    } finally {
      await s.close();
    }
  });

  it('withdraw_issue (2026-10-15.16) posts to the owner\'s live assignment and passes the resumed review, the statuses, the payment and next_step through', async () => {
    const withdrawn = {
      ...sampleReview, status: 'pending', issue_type: 'acceptance_mismatch', hunter_response: 'All three papers are covered; see page 2.',
      issue_withdrawn_at: '2026-10-06T13:00:00.000Z', issue_closed_as: 'withdrawn_after_response', review_deadline_at: '2026-10-07T13:00:00.000Z',
    };
    const payment = { status: 'held', authorised_minor: 2500, captured_minor: 0, refunded_minor: 0, hunter_fee_minor: 375, hunter_net_minor: 2125, currency: 'AUD' };
    const next_step = 'Issue withdrawn after the Hunter\'s response; the review is pending again until 2026-10-07T13:00:00.000Z (at least 24 hours from now). Approve with approve_delivery (captures exactly the A$25.00 authorised at acceptance) or raise_issue again before then; silence auto-confirms. Nothing is captured meanwhile.';
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'issue_raised', participant: { role: 'setter', applications: [], assignment: sampleAssignment } } },
      [`POST /v1/assignments/${UUID_B}/issues/withdraw`]: { json: { ...withdrawn, assignment: { id: UUID_B, status: 'delivered' }, task: { id: UUID_A, status: 'delivered' }, payment, next_step } },
    }) });
    try {
      const result = await s.call('withdraw_issue', { task_id: UUID_A });
      assert.equal(s.calls.length, 2, 'no read-back');
      assert.equal(s.calls[1]!.method, 'POST');
      assert.equal(s.calls[1]!.url.pathname, `/v1/assignments/${UUID_B}/issues/withdraw`);
      assert.deepEqual(result.data, {
        review: { ...withdrawn, approved_by: null },
        assignment: { id: UUID_B, status: 'delivered' },
        task: { id: UUID_A, status: 'delivered' },
        payment,
        next_step,
      });
      const invalid = await s.refusal('withdraw_issue', {});
      assert.equal(invalid.code, 'invalid_input');
    } finally {
      await s.close();
    }
  });

  it('an applicant (no assignment) cannot respond: assignment_not_found, nothing posted', async () => {
    const application = { id: UUID_C, task_id: UUID_A, status: 'pending' };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, participant: { role: 'applicant', application, assignment: null } } },
    }) });
    try {
      const result = await s.call('respond_to_issue', { task_id: UUID_A, text: 'hello' });
      assert.equal(result.isError, true);
      assert.equal(result.data!.error.code, 'assignment_not_found');
      assert.equal(s.calls.length, 1);
    } finally {
      await s.close();
    }
  });
});

describe('mcp server: slimming (2026-10-15.13: one result representation, me, resources, parity with the hosted endpoint)', () => {
  it('a result is the JSON text only; _meta { "bountymarket/structuredContent": true } adds structuredContent, for errors too', async () => {
    const s = await connect({ handler: routes({ [`GET /v1/tasks/${UUID_A}`]: { json: sampleTask }, [`GET /v1/tasks/${UUID_B}`]: { status: 404, json: { error: { code: 'task_not_found', message: 'No such task.', status: 404 } } } }) });
    try {
      const plain = await s.call('get_task', { task_id: UUID_A });
      assert.deepEqual(Object.keys(plain).filter((k) => k !== 'data'), ['content']);
      assert.equal(plain.content.length, 1);
      assert.equal(plain.data.task.id, UUID_A);
      const both = await s.call('get_task', { task_id: UUID_A }, { 'bountymarket/structuredContent': true });
      assert.deepEqual(both.structuredContent, both.data);
      const err = await s.call('get_task', { task_id: UUID_B }, { 'bountymarket/structuredContent': true });
      assert.equal(err.isError, true);
      assert.equal(err.structuredContent!.error.code, 'task_not_found');
      const errPlain = await s.call('get_task', { task_id: UUID_B });
      assert.equal(errPlain.structuredContent, undefined);
      assert.equal(errPlain.data.error.code, 'task_not_found');
    } finally {
      await s.close();
    }
  });

  it('tools/list is the hosted list byte for byte: 21 tools under 10,000 B, each with its title, only non-default annotations, no outputSchema', async () => {
    const s = await connect({ apiKey: 'bhk_x' });
    try {
      const { tools } = await s.client.listTools();
      assert.equal(tools.length, 21, '17 + withdraw_issue (2026-10-15.16) + request_limit (2026-10-19.2) + cancel_task, request_cancellation (2026-11-10)');
      const bytes = Buffer.byteLength(JSON.stringify({ tools }));
      // The hosted budget since 2026-11-10 (titles and one line per post_task field): 10,000 B, was 9,000.
      assert.ok(bytes <= 10000, `tools/list ${bytes} B`);
      for (const t of tools) {
        assert.equal(t.title, snapshot.tools.find((x) => x.name === t.name)!.title, t.name);
        assert.ok((t.title ?? '').length > 0, t.name);
        assert.equal(t.outputSchema, undefined, t.name);
        assert.ok((t.description ?? '').length <= 260, `${t.name}: ${t.description?.length} chars`);
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      assert.deepEqual(byName.me!.annotations, { readOnlyHint: true });
      assert.deepEqual(byName.disable_auto_accept!.annotations, { destructiveHint: false, idempotentHint: true });
      assert.deepEqual(byName.post_task!.annotations, { destructiveHint: false, openWorldHint: true });
      assert.deepEqual(tools.map((t) => t.name), snapshot.tools.map((t) => t.name));
    } finally {
      await s.close();
    }
  });

  it('me returns the GET /v1/me document unchanged (no secrets to strip: the platform never returns the key)', async () => {
    const me = {
      id: 'u1', display_name: 'Ada', status: 'active', is_admin: false, email_masked: 'a***@example.com',
      agent: { id: 'a1', display_name: 'Ada Bot', api_key_prefix: 'bhk_abcd', setter_mode: 'always', hunter_mode: 'deny', status: 'active', created_at: null, last_used_at: null },
      terms_current_version: 'v1', terms_current_accepted: true, hunter_account: null, payment_method_count: 1,
      hunter_max_active_assignments: 2, hunter_active_assignment_ids: [], setter_daily_cap_minor: 20000, setter_daily_used_minor: 0,
    };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({ 'GET /v1/me': { json: me } }) });
    try {
      const result = await s.call('me');
      assert.deepEqual(result.data, me);
      assert.equal(s.calls.at(-1)!.url.pathname, '/v1/me');
      assert.equal(s.calls.at(-1)!.headers.authorization, 'Bearer bhk_x');
      assert.doesNotMatch(result.content[0]!.text, /bhk_x/);
    } finally {
      await s.close();
    }
    const anon = await connect({});
    try {
      assert.equal((await anon.client.listTools()).tools.some((t) => t.name === 'me'), false, 'no key: no me tool');
    } finally {
      await anon.close();
    }
  });

  it('resources: the five guides are listed and readable, identical to the hosted snapshot; get_rules { guide } returns the same text; an unknown uri is -32002', async () => {
    const s = await connect({ handler: routes({ 'GET /.well-known/bountymarket-policy.json': { json: { policy_id: 'p', digest: 'd' } } }) });
    try {
      const { resources } = await s.client.listResources();
      assert.deepEqual(resources.map((r) => r.uri), snapshot.resources.map((r) => r.uri));
      assert.deepEqual(resources.map((r) => r.uri), ['bountymarket://guide/errors', 'bountymarket://guide/waiting', 'bountymarket://guide/issue-flow', 'bountymarket://guide/money', 'bountymarket://guide/files']);
      for (const r of resources) assert.equal(r.mimeType, 'text/markdown');
      const { resourceTemplates } = await s.client.listResourceTemplates();
      assert.deepEqual(resourceTemplates, []);
      for (const expected of snapshot.resources) {
        if (expected.uri.endsWith('/money')) continue;
        const read = await s.client.readResource({ uri: expected.uri });
        assert.equal(read.contents.length, 1);
        assert.equal((read.contents[0] as { text: string }).text, expected.text, expected.uri);
      }
      const viaTool = await s.call('get_rules', { guide: 'errors' });
      assert.equal(viaTool.data.guide.text, snapshot.resources[0]!.text);
      assert.equal(s.calls.length, 0, 'four guides come from the package, no request');
      // The money guide follows the deployment's fee schedule; this fake has no capabilities route, so it is the enforce ladder at launch values.
      const money = await s.client.readResource({ uri: 'bountymarket://guide/money' });
      assert.equal((money.contents[0] as { text: string }).text, guidesForCapabilities(null).find((g) => g.name === 'money')!.text);
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), ['GET /v1/capabilities']);
      s.calls.length = 0;
      const index = await s.call('get_rules');
      assert.deepEqual(index.data.agent_guides.map((g: { name: string }) => g.name), ['errors', 'waiting', 'issue-flow', 'money', 'files']);
      assert.equal(index.data.policy_id, 'p');
      let code: number | undefined;
      try {
        await s.client.readResource({ uri: 'bountymarket://guide/nope' });
      } catch (error) {
        code = (error as McpError).code;
      }
      assert.equal(code, RPC.RESOURCE_NOT_FOUND);
    } finally {
      await s.close();
    }
  });
});

describe('mcp server: limits (trust stage 1, platform 2026-10-19.2): post_task.min_hunter_tier and request_limit', () => {
  const REASON = 'A 40-page translation that will not split into A$50 pieces.';

  it('post_task passes min_hunter_tier through to POST /v1/tasks exactly as given, and omits it when absent', async () => {
    const posted = { ...sampleOwnerTask, status: 'open', min_hunter_tier: 'silver' };
    const s = await connect({ apiKey: 'bhk_x', handler: routes({ 'POST /v1/tasks': (call) => ({ status: 201, json: { ...posted, min_hunter_tier: (call.body as Record<string, unknown>).min_hunter_tier ?? null, next_step: STEP.setterOpen } }) }) });
    try {
      const gated = await s.call('post_task', { ...POST_ARGS, min_hunter_tier: 'silver' });
      assert.deepEqual(s.calls[0]!.body, { ...POST_ARGS, min_hunter_tier: 'silver' });
      assert.equal(gated.data!.task.min_hunter_tier, 'silver');
      await s.call('post_task', POST_ARGS);
      assert.equal('min_hunter_tier' in (s.calls[1]!.body as Record<string, unknown>), false, 'absent unless given: an older deployment never sees the key');
      // An enum of the six tiers since 2026-11-10: a wrong value is refused before any request.
      const notString = await s.refusal('post_task', { ...POST_ARGS, min_hunter_tier: 3 });
      assert.equal(notString.code, 'invalid_input');
      assert.ok(notString.details.problems.some((p: string) => p.includes('arguments.min_hunter_tier')), JSON.stringify(notString.details));
    } finally {
      await s.close();
    }
  });

  it('request_limit files the request for the owner (side, level, task_id, requested, reason as given) and returns { request, next_step }; the platform\'s wording wins, the client\'s fallback fills an older deployment', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      'POST /v1/me/limit-requests': (call) => {
        const body = call.body as Record<string, unknown>;
        return body.level === 2
          ? { status: 201, json: { request: { ...sampleLimitRequest, ...body, task_id: null } } }
          : { status: 201, json: { request: { ...sampleLimitRequest, ...body }, next_step: LIMIT_REQUEST_STEP } };
      },
    }) });
    try {
      const result = await s.call('request_limit', { side: 'setter', level: 1, task_id: UUID_A, requested: { per_task_cap_minor: 15000 }, reason: REASON });
      const post = s.calls[0]!;
      assert.equal(post.method, 'POST');
      assert.equal(post.url.pathname, '/v1/me/limit-requests');
      assert.equal(post.headers.authorization, 'Bearer bhk_x');
      assert.equal(post.headers['idempotency-key'], 'idem');
      assert.deepEqual(post.body, { side: 'setter', level: 1, task_id: UUID_A, requested: { per_task_cap_minor: 15000 }, reason: REASON });
      assert.deepEqual(Object.keys(result.data!), ['request', 'next_step']);
      assert.equal(result.data!.request.id, UUID_REQ);
      assert.equal(result.data!.request.requested.per_task_cap_minor, 15000);
      assert.equal(result.data!.next_step, LIMIT_REQUEST_STEP);
      assert.equal(result.isError, undefined);

      const hunter = await s.call('request_limit', { side: 'hunter', level: 2, requested: { slots: 5 }, reason: REASON });
      assert.deepEqual(s.calls[1]!.body, { side: 'hunter', level: 2, requested: { slots: 5 }, reason: REASON });
      assert.match(hunter.data!.next_step, /Filed for your owner\. The founder answers in the console, normally within 24 hours: watch get_events for limit_request\.approved \/ limit_request\.declined/, 'the fallback when the platform omits next_step');

      // Argument errors are caught before any request: level 4, a non-UUID task_id, requested not an object, a missing reason.
      const before = s.calls.length;
      for (const args of [
        { side: 'setter', level: 4, requested: { slots: 3 }, reason: REASON },
        { side: 'setter', level: 1, task_id: 'nope', requested: { slots: 3 }, reason: REASON },
        { side: 'setter', level: 1, requested: 'slots', reason: REASON },
        { side: 'setter', level: 1, requested: { slots: 3 } },
        { side: 'both', level: 1, requested: { slots: 3 }, reason: REASON },
      ]) {
        const error = await s.refusal('request_limit', args);
        assert.equal(error.code, 'invalid_input', JSON.stringify(args));
      }
      assert.equal(s.calls.length, before, 'no request for an argument error');
    } finally {
      await s.close();
    }
  });

  it('request_limit returns the platform\'s refusal as an error result (409 limit_request_open_exists with details and next_step)', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({ 'POST /v1/me/limit-requests': { status: 409, json: {
      error: { code: 'limit_request_open_exists', status: 409, message: 'You already have a limit request waiting.', details: { request_id: UUID_REQ, level: 1, side: 'setter' } },
      next_step: 'Wait for the decision or withdraw it.',
    } } }) });
    try {
      const result = await s.call('request_limit', { side: 'setter', level: 1, requested: { slots: 3 }, reason: REASON });
      assert.equal(result.isError, true);
      assert.equal(result.data!.error.code, 'limit_request_open_exists');
      assert.equal(result.data!.error.details.request_id, UUID_REQ);
      assert.equal(result.data!.next_step, 'Wait for the decision or withdraw it.');
    } finally {
      await s.close();
    }
  });
});

describe('mcp server: platform 2026-11-10: cancel_task, request_cancellation, pending_owner_action, titles and annotations', () => {
  const setterParticipant = (extra: Record<string, unknown> = {}) => ({
    role: 'setter', applications: [], assignment: sampleAssignment, deliveries: [], review: null, payment: heldPayment, next_step: 'x', confirm_hint: 'x',
    agent_authority: null, cancellation_requested_by: null, ...extra,
  });

  it('list_my_tasks names what only the owner can click per row, reading a task view only where a Hunter is on it', async () => {
    const rows = [
      { ...sampleOwnerTask, id: UUID_A, status: 'open', work: { pending_applications: 2, hunter: null, review_deadline_at: null } },
      { ...sampleOwnerTask, id: UUID_B, status: 'open', auto_accept: { enabled: true, allow_agents: true, min_settled: 0, active: false, confirmed_at: null }, work: { pending_applications: 0, hunter: null, review_deadline_at: null } },
      { ...sampleOwnerTask, id: UUID_C, status: 'assigned', work: { pending_applications: 0, hunter: null, review_deadline_at: null } },
      { ...sampleOwnerTask, id: UUID_D, status: 'approved', work: { pending_applications: 0, hunter: null, review_deadline_at: null } },
    ];
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      'GET /v1/me/tasks': { json: { tasks: rows } },
      [`GET /v1/tasks/${UUID_C}`]: { json: { ...rows[2], participant: setterParticipant({ cancellation_requested_by: 'hunter' }) } },
    }) });
    try {
      const result = await s.call('list_my_tasks');
      const byId = Object.fromEntries((result.data.tasks as Array<Record<string, any>>).map((t) => [t.id, t]));
      assert.deepEqual(byId[UUID_A]!.pending_owner_action, { kind: 'accept_applicant', confirm_url: `https://web.test/task/${UUID_A}` });
      assert.equal(byId[UUID_A]!.next_step, '2 pending applications: the owner accepts one by hand at confirm_url (never a tool).');
      assert.deepEqual(byId[UUID_B]!.pending_owner_action, { kind: 'confirm_auto_accept', confirm_url: `https://web.test/task/${UUID_B}?confirm=auto_accept` });
      assert.equal(byId[UUID_B]!.next_step, 'The owner confirms the requested auto-accept with one click at confirm_url; until then nothing is automatic.');
      assert.deepEqual(byId[UUID_C]!.pending_owner_action, { kind: 'confirm_cancellation', confirm_url: `https://web.test/task/${UUID_C}` });
      assert.equal(byId[UUID_C]!.next_step, 'The Hunter asked for a mutual cancellation: only the owner can confirm it, at confirm_url; until then the contract stands.');
      assert.equal(byId[UUID_D]!.pending_owner_action, null);
      assert.equal('next_step' in byId[UUID_D]!, false);
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), ['GET /v1/me/tasks', `GET /v1/tasks/${UUID_C}`], 'only the assigned row needs its view');
    } finally {
      await s.close();
    }
  });

  it('list_my_assignments shows the Setter\'s cancellation request as the owner\'s click; ended assignments read nothing', async () => {
    const active = { ...sampleAssignment, task: { id: UUID_A, title: sampleTask.title, status: 'assigned', category_code: 'data_research' } };
    const done = { ...sampleAssignment, id: UUID_D, status: 'completed', task: { id: UUID_A, title: sampleTask.title, status: 'approved', category_code: 'data_research' } };
    const s = await connect({ apiKey: 'bhk_x', webUrl: 'https://web.test', handler: routes({
      'GET /v1/me/assignments': { json: { assignments: [active, done] } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'assigned', participant: { role: 'hunter', my_application: null, assignment: sampleAssignment, cancellation_requested_by: 'setter' } } },
    }) });
    try {
      const result = await s.call('list_my_assignments');
      const [first, second] = result.data.assignments as Array<Record<string, any>>;
      assert.deepEqual(first!.pending_owner_action, { kind: 'confirm_cancellation', confirm_url: WEBSITE_URL_A });
      assert.equal(first!.next_step, 'The Setter asked for a mutual cancellation: only the owner can confirm it, at confirm_url; until then the contract stands.');
      assert.equal(second!.pending_owner_action, null);
      assert.equal(s.calls.filter((c) => c.url.pathname === `/v1/tasks/${UUID_A}`).length, 1);
    } finally {
      await s.close();
    }
  });

  it('cancel_task cancels over POST /v1/tasks/{id}/cancel and answers { task, already_cancelled, next_step }; a repeat is already_cancelled true', async () => {
    const DONE = 'Cancelled: the task is off the board, pending applications are closed and no money moved. Posting a new task is post_task / POST /v1/tasks.';
    const REPEAT = 'Already cancelled by you: nothing changed (this route is idempotent). Posting a new task is post_task / POST /v1/tasks.';
    let cancelled = false;
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/tasks/${UUID_A}/cancel`]: () => {
        const repeat = cancelled;
        cancelled = true;
        return { json: { ...sampleOwnerTask, status: 'cancelled', already_cancelled: repeat, next_step: repeat ? REPEAT : DONE } };
      },
    }) });
    try {
      const first = await s.call('cancel_task', { task_id: UUID_A });
      assert.equal(s.calls[0]!.method, 'POST');
      assert.equal(s.calls[0]!.headers.authorization, 'Bearer bhk_x');
      assert.deepEqual(first.data, { task: { ...sampleOwnerTask, status: 'cancelled' }, already_cancelled: false, next_step: DONE });
      const again = await s.call('cancel_task', { task_id: UUID_A });
      assert.deepEqual(again.data, { task: { ...sampleOwnerTask, status: 'cancelled' }, already_cancelled: true, next_step: REPEAT });
      const bad = await s.refusal('cancel_task', { task_id: 'nope' });
      assert.deepEqual(bad.details, { field: 'task_id', problems: ['arguments.task_id: must be a UUID'] });
      assert.equal(s.calls.length, 2);
    } finally {
      await s.close();
    }
  });

  it('cancel_task on an older deployment: a 409 repeat on the owner\'s cancelled task is already_cancelled true; a task with a Hunter points at request_cancellation', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/tasks/${UUID_A}/cancel`]: { status: 409, json: { error: { code: 'task_not_open', message: 'Not open.', status: 409, details: { task_status: 'cancelled' } } } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'cancelled', participant: setterParticipant({ assignment: null, payment: noPayment }) } },
      [`POST /v1/tasks/${UUID_B}/cancel`]: { status: 409, json: { error: { code: 'task_not_open', message: 'Not open.', status: 409, details: { task_status: 'assigned' } } } },
    }) });
    try {
      const repeat = await s.call('cancel_task', { task_id: UUID_A });
      assert.equal(repeat.isError, undefined);
      assert.equal(repeat.data.already_cancelled, true);
      assert.equal(repeat.data.task.status, 'cancelled');
      assert.equal('participant' in repeat.data.task, false);
      const assigned = await s.refusal('cancel_task', { task_id: UUID_B });
      assert.equal(assigned.code, 'task_not_open');
      assert.match(assigned.next_step ?? '', /With a Hunter on it, ask for a mutual cancellation \(request_cancellation/);
    } finally {
      await s.close();
    }
  });

  it('request_cancellation by task_id or assignment_id asks over REST and says the other owner confirms on the website; neither id is invalid_input; refusals pass through', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'assigned', participant: setterParticipant() } },
      [`POST /v1/assignments/${UUID_B}/cancellation/request`]: { json: { ok: true } },
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [], review: null, payment: heldPayment } },
    }) });
    try {
      const byTask = await s.call('request_cancellation', { task_id: UUID_A });
      assert.deepEqual(byTask.data, {
        ok: true, assignment: { id: UUID_B, status: 'active' }, task_id: UUID_A, requested_by: 'setter',
        next_step: 'Requested (cancellation.requested event). Nothing changes until the Hunter\'s owner confirms on the website, a human click (assignment.cancelled follows): '
          + 'then the card hold is released, or a captured charge refunded in full. Until then the contract stands and its deadlines run.',
      });
      assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url.pathname}`), [`GET /v1/tasks/${UUID_A}`, `POST /v1/assignments/${UUID_B}/cancellation/request`],
        'the side comes from the task read before the write; nothing is read after it');
      const byAssignment = await s.call('request_cancellation', { assignment_id: UUID_B });
      assert.equal(byAssignment.data.task_id, UUID_A);
      assert.equal(byAssignment.data.requested_by, 'setter');
      assert.deepEqual(s.calls.slice(-3).map((c) => `${c.method} ${c.url.pathname}`),
        [`GET /v1/assignments/${UUID_B}`, `GET /v1/tasks/${UUID_A}`, `POST /v1/assignments/${UUID_B}/cancellation/request`]);
      const before = s.calls.length;
      const neither = await s.refusal('request_cancellation', {});
      assert.deepEqual(neither.details, { field: null, problems: ['arguments: assignment_id or task_id is required'] });
      assert.equal(s.calls.length, before);
    } finally {
      await s.close();
    }
    const refused = await connect({ apiKey: 'bhk_x', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'delivered', participant: setterParticipant({ assignment: { ...sampleAssignment, status: 'delivered' } }) } },
      [`POST /v1/assignments/${UUID_B}/cancellation/request`]: { status: 409, json: { error: { code: 'delivery_already_submitted', message: 'Delivered.', status: 409, details: { review_deadline_at: '2026-10-08T02:00:00.000Z' } } } },
    }) });
    try {
      const result = await refused.refusal('request_cancellation', { task_id: UUID_A });
      assert.equal(result.code, 'delivery_already_submitted');
      assert.equal(result.details.review_deadline_at, '2026-10-08T02:00:00.000Z');
    } finally {
      await refused.close();
    }
  });

  it('request_cancellation works out the side before the write: a read that fails after it cannot turn a done request into an error; a failed read before it writes nothing', async () => {
    // The Hunter side: the participant block says hunter. Every later task read fails, which no longer matters.
    let taskReads = 0;
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`GET /v1/tasks/${UUID_A}`]: () => {
        taskReads += 1;
        return taskReads === 1
          ? { json: { ...sampleTask, status: 'assigned', participant: { role: 'hunter', my_application: null, assignment: sampleAssignment, cancellation_requested_by: null } } }
          : { status: 404, json: { error: { code: 'task_not_found', message: 'Gone.', status: 404 } } };
      },
      [`POST /v1/assignments/${UUID_B}/cancellation/request`]: { json: { ok: true } },
    }) });
    try {
      const result = await s.call('request_cancellation', { task_id: UUID_A });
      assert.equal(result.isError, undefined);
      assert.equal(result.data.requested_by, 'hunter');
      assert.match(result.data.next_step, /until the Setter's owner confirms on the website/);
      assert.equal(taskReads, 1);
    } finally {
      await s.close();
    }
    // A failed read before the write: the error comes back and no request is sent.
    const down = await connect({ apiKey: 'bhk_x', handler: routes({
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [], review: null, payment: heldPayment } },
      [`GET /v1/tasks/${UUID_A}`]: { status: 404, json: { error: { code: 'task_not_found', message: 'Gone.', status: 404 } } },
      [`POST /v1/assignments/${UUID_B}/cancellation/request`]: { json: { ok: true } },
    }) });
    try {
      const refused = await down.refusal('request_cancellation', { assignment_id: UUID_B });
      assert.equal(refused.code, 'task_not_found');
      assert.equal(down.calls.some((c) => c.method === 'POST'), false, 'no write after a failed side read');
    } finally {
      await down.close();
    }
    // A deployment without the participant block: the side comes from GET /v1/me (the Hunter is hunter_user_id).
    const older = await connect({ apiKey: 'bhk_x', handler: routes({
      [`GET /v1/assignments/${UUID_B}`]: { json: { assignment: sampleAssignment, task: sampleTask, deliveries: [], review: null, payment: heldPayment } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleTask, status: 'assigned' } },
      'GET /v1/me': { json: { id: sampleAssignment.hunter_user_id, display_name: 'Owner', agent: null } },
      [`POST /v1/assignments/${UUID_B}/cancellation/request`]: { json: { ok: true } },
    }) });
    try {
      const result = await older.call('request_cancellation', { assignment_id: UUID_B });
      assert.equal(result.data.requested_by, 'hunter');
      assert.equal(older.calls.at(-1)!.method, 'POST');
    } finally {
      await older.close();
    }
  });

  it('cancel_task on an older deployment: a task cancelled by mutual cancellation (it had an assignment) stays the 409 refusal, not already_cancelled', async () => {
    const s = await connect({ apiKey: 'bhk_x', handler: routes({
      [`POST /v1/tasks/${UUID_A}/cancel`]: { status: 409, json: { error: { code: 'task_not_open', message: 'Not open.', status: 409, details: { task_status: 'cancelled' } } } },
      [`GET /v1/tasks/${UUID_A}`]: { json: { ...sampleOwnerTask, status: 'cancelled', participant: setterParticipant({ assignment: { ...sampleAssignment, status: 'cancelled' } }) } },
    }) });
    try {
      const result = await s.refusal('cancel_task', { task_id: UUID_A });
      assert.equal(result.code, 'task_not_open');
      assert.equal(result.details.task_status, 'cancelled');
    } finally {
      await s.close();
    }
  });

  it('tools/list carries the hosted titles and annotations: approve_delivery is destructive and open-world, cancel_task destructive and idempotent; no confirm tool', async () => {
    const s = await connect({ apiKey: 'bhk_x' });
    try {
      const { tools } = await s.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      assert.deepEqual(byName.approve_delivery!.annotations, { destructiveHint: true, openWorldHint: true });
      assert.deepEqual(byName.cancel_task!.annotations, { destructiveHint: true, idempotentHint: true });
      assert.deepEqual(byName.request_cancellation!.annotations, { destructiveHint: false });
      assert.deepEqual(byName.raise_issue!.annotations, { destructiveHint: false, openWorldHint: true });
      assert.equal(byName.cancel_task!.title, 'Cancel task');
      assert.equal(byName.request_cancellation!.title, 'Ask to cancel');
      for (const t of tools) assert.doesNotMatch(t.name, /confirm|accept_application/, 'confirming and accepting stay human clicks');
    } finally {
      await s.close();
    }
  });
});

describe('mcp server: the money guide follows the deployment it talks to', () => {
  const ladder = (thresholds: number[], gates: number[]) => ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'obsidian'].map((code, i) => ({
    code, rank: i + 1, fee_bps: [2000, 1500, 1300, 1000, 800, 500][i]!, fee_percent: [20, 15, 13, 10, 8, 5][i]!,
    minimum_earned_minor: thresholds[i]!, time_gate_days: gates[i]!, minimum_settled_tasks: null,
  }));
  const legacy = [
    { code: 'bronze', rank: 1, fee_bps: 1500, fee_percent: 15, minimum_settled_tasks: 0 }, { code: 'silver', rank: 2, fee_bps: 1400, fee_percent: 14, minimum_settled_tasks: 5 },
    { code: 'gold', rank: 3, fee_bps: 1250, fee_percent: 12.5, minimum_settled_tasks: 20 }, { code: 'diamond', rank: 4, fee_bps: 1000, fee_percent: 10, minimum_settled_tasks: 50 },
  ];
  const sandboxLadder = ladder([0, 2500, 10000, 50000, 150000, 300000], [0, 1, 3, 3, 9, 18]);
  const withFees = (feeSchedule: 'fee_tiers' | 'legacy_fee_tiers') => ({
    ...capabilities,
    money: { ...capabilities.money, fee_schedule: feeSchedule, fee_tiers: sandboxLadder, legacy_fee_tiers: legacy, fee_tier_window_days: 180 },
  });

  it('enforce mode: resources/read and get_rules { guide: "money" } quote the deployment\'s ladder and tier-row caps, never the launch-default shadow text', async () => {
    const s = await connect({ handler: routes({ 'GET /v1/capabilities': { json: withFees('fee_tiers') } }) });
    try {
      const read = await s.client.readResource({ uri: 'bountymarket://guide/money' });
      const text = (read.contents[0] as { text: string }).text;
      assert.match(text, /Bronze 20%, Silver 15% from A\$25 seasoned net earnings, account 1\+ days old, Gold 13% from A\$100 seasoned net earnings/);
      assert.match(text, /Caps \(trust\.mode enforce\)/);
      assert.doesNotMatch(text, /legacy count tiers are charged|Caps \(trust\.mode shadow\)|Bronze 15%/);
      assert.notEqual(text, GUIDES.find((g) => g.name === 'money')!.text);
      const viaTool = await s.call('get_rules', { guide: 'money' });
      assert.equal(viaTool.data.guide.text, text);
      assert.equal(s.calls.length, 1, 'capabilities read once and reused');
    } finally {
      await s.close();
    }
  });

  it('shadow mode: the money guide is the launch-default text, identical to the hosted snapshot', async () => {
    const s = await connect({ handler: routes({ 'GET /v1/capabilities': { json: withFees('legacy_fee_tiers') } }) });
    try {
      const read = await s.client.readResource({ uri: 'bountymarket://guide/money' });
      assert.equal((read.contents[0] as { text: string }).text, snapshot.resources.find((r) => r.uri.endsWith('/money'))!.text);
    } finally {
      await s.close();
    }
  });

  it('createGuideSource: four guides need no request; unreadable capabilities fall back to the enforce ladder and are tried again; good facts are reused for the TTL', async () => {
    let reads = 0;
    let fail = true;
    let clock = 0;
    const source = createGuideSource(async () => {
      reads += 1;
      if (fail) throw new Error('unreachable');
      return withFees('legacy_fee_tiers');
    }, () => clock);
    assert.equal((await source('errors'))!.text, GUIDES.find((g) => g.name === 'errors')!.text);
    assert.equal(await source('nope'), undefined);
    assert.equal(reads, 0);
    assert.equal((await source('money'))!.text, guidesForCapabilities(null).find((g) => g.name === 'money')!.text);
    assert.equal(reads, 1);
    fail = false;
    assert.equal((await source('money'))!.text, GUIDES.find((g) => g.name === 'money')!.text, 'tried again after a failure');
    assert.equal(reads, 2);
    await source('money');
    assert.equal(reads, 2, 'reused within the TTL');
    clock += GUIDE_FACTS_TTL_MS;
    await source('money');
    assert.equal(reads, 3, 'read again after the TTL');
  });

  it('createGuideSource: capabilities that never answer give the fallback money guide within the bound, uncached, and the next read tries again', async () => {
    assert.equal(GUIDE_FACTS_TIMEOUT_MS, 5_000);
    let reads = 0;
    let hang = true;
    const source = createGuideSource(() => {
      reads += 1;
      return hang ? new Promise<unknown>(() => {}) : Promise.resolve(withFees('legacy_fee_tiers'));
    }, () => 0, 50);
    const started = Date.now();
    assert.equal((await source('money'))!.text, guidesForCapabilities(null).find((g) => g.name === 'money')!.text);
    assert.ok(Date.now() - started < 2_000, 'answered within the bound, not at the HTTP timeout');
    assert.equal(reads, 1);
    hang = false;
    assert.equal((await source('money'))!.text, GUIDES.find((g) => g.name === 'money')!.text, 'the fallback was not cached');
    assert.equal(reads, 2);
  });
});
