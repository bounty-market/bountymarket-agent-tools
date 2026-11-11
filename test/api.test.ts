import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApiClientError, DEFAULT_API_URL, configFromEnv, createApiClient, formatAud,
} from '../src/api.ts';
import { USER_AGENT } from '../src/version.ts';
import {
  LIMIT_REQUEST_STEP, UUID_A, UUID_B, UUID_FILE, UUID_FILE_2, UUID_REQ, fakeFetch, routes, sampleAttachment, sampleLimitRequest, sampleLimitSummary, sampleTask,
} from './fake-fetch.ts';

describe('api client: requests', () => {
  it('builds URLs with a query string, sends accept and user-agent, no auth header without credentials', async () => {
    const fake = fakeFetch(routes({ 'GET /v1/tasks': { json: { tasks: [sampleTask], next_before: null } } }));
    const client = createApiClient({ baseUrl: 'https://api.test/', fetch: fake.fetch });
    const result = await client.listTasks({ status: 'assigned', category: 'other', limit: 5 });
    assert.equal(result.tasks.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.url.href, 'https://api.test/v1/tasks?status=assigned&category=other&limit=5');
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.accept, 'application/json');
    assert.equal(call.headers['user-agent'], USER_AGENT);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers['idempotency-key'], undefined);
  });

  it('sends the agent key as a Bearer token, JSON bodies and an Idempotency-Key on writes', async () => {
    const fake = fakeFetch(routes({ 'POST /v1/tasks': { status: 201, json: { ...sampleTask, status: 'pending_review' } } }));
    const client = createApiClient({
      baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_abc_secret' }, fetch: fake.fetch,
      idempotencyKey: () => 'idem-1',
    });
    const task = await client.createTask({
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable,
      acceptance_criteria: sampleTask.acceptance_criteria, category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24,
    });
    assert.equal(task.status, 'pending_review');
    const call = fake.calls[0]!;
    assert.equal(call.headers.authorization, 'Bearer bhk_abc_secret');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['idempotency-key'], 'idem-1');
    assert.deepEqual(call.body, {
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable,
      acceptance_criteria: sampleTask.acceptance_criteria, category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24,
    });
  });

  it('encodes path parameters and sends {} when apply has no message; apply carries assignment, auto_accept_outcome and next_step', async () => {
    const fake = fakeFetch(routes({
      [`POST /v1/tasks/${UUID_A}/applications`]: { status: 201, json: { id: 'app-1', status: 'accepted', auto_accept_skipped_reason: null, assignment: { id: 'asg-1', status: 'active' }, auto_accept_outcome: 'accepted', next_step: 'Accepted automatically.' } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const applied = await client.apply(UUID_A);
    assert.deepEqual(fake.calls[0]!.body, {});
    assert.equal(applied.assignment?.id, 'asg-1');
    assert.equal(applied.auto_accept_outcome, 'accepted');
    assert.equal(applied.auto_accept_skipped_reason, null);
    assert.equal(applied.next_step, 'Accepted automatically.');
    await client.apply(UUID_A, 'hello');
    assert.deepEqual(fake.calls[1]!.body, { message: 'hello' });
  });

  it('deliver posts to /v1/assignments/{assignment or task id}/deliveries and the review names the assignment', async () => {
    const fake = fakeFetch(routes({
      [`POST /v1/assignments/${UUID_A}/deliveries`]: { status: 201, json: { id: 'rev-1', assignment_id: 'asg-1', delivery_id: 'd-1', status: 'pending' } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const review = await client.deliver(UUID_A, 'Done.');
    assert.equal(fake.calls[0]!.url.pathname, `/v1/assignments/${UUID_A}/deliveries`);
    assert.deepEqual(fake.calls[0]!.body, { summary: 'Done.', links: [] });
    assert.equal(review.assignment_id, 'asg-1');
  });

  it('createTask passes auto_accept through and types the pending confirmation; the auto-accept routes are plain POSTs', async () => {
    const confirmUrl = `https://web.test/task/${UUID_A}?confirm=auto_accept`;
    const fake = fakeFetch(routes({
      'POST /v1/tasks': { status: 201, json: { ...sampleTask, auto_accept: { enabled: true, allow_agents: true, min_settled: 0, active: false, confirmed_at: null }, auto_accept_status: 'pending_owner_confirmation', confirm_url: confirmUrl } },
      [`POST /v1/tasks/${UUID_A}/auto-accept/disable`]: { json: { ...sampleTask, auto_accept: { enabled: false, allow_agents: true, min_settled: 0, active: false, confirmed_at: null } } },
      [`POST /v1/tasks/${UUID_A}/auto-accept/confirm`]: { status: 403, json: { error: { code: 'human_confirmation_required', message: 'Auto-accept is confirmed by the account owner on the website, not by an agent.', status: 403 } } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const created = await client.createTask({
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable, acceptance_criteria: sampleTask.acceptance_criteria,
      category_code: 'data_research', bounty_minor: 1300, delivery_hours: 12, auto_accept: { enabled: true },
    });
    assert.deepEqual((fake.calls[0]!.body as Record<string, unknown>).auto_accept, { enabled: true });
    assert.equal(created.auto_accept_status, 'pending_owner_confirmation');
    assert.equal(created.confirm_url, confirmUrl);
    assert.equal(created.auto_accept.active, false);
    const disabled = await client.disableAutoAccept(UUID_A);
    assert.equal(fake.calls[1]!.url.pathname, `/v1/tasks/${UUID_A}/auto-accept/disable`);
    assert.equal(disabled.auto_accept.enabled, false);
    const refused = await client.confirmAutoAccept(UUID_A).then(() => null, (e: unknown) => e);
    assert.ok(refused instanceof ApiClientError);
    assert.equal(refused.code, 'human_confirmation_required');
  });

  it('capabilities passes the document through, typed: mode, live_charges, timezone, activity (both medians), review (first listing: target and median), fee holiday, caps auto-scale, links note, events', async () => {
    const doc = {
      name: 'BountyMarket', status: 'public_sandbox', mode: 'sandbox', live_charges: false, timezone: 'UTC', server_time: '2026-11-02T00:00:00.000Z',
      money: {
        minimum_bounty_minor: 1000, setter_daily_cap_minor: 20000, new_setter_review_count: 1, live_charges: false,
        fee_holiday_until: '2026-12-31T00:00:00.000Z',
        fee_holiday: 'Platform fee is 0% for every Hunter, human or AI agent alike, for tasks accepted before fee_holiday_until; after that the tiers apply.',
      },
      activity: {
        open_tasks: 2, settled_last_30_days: 1, active_hunters_last_30_days: 1,
        median_hours_to_first_application_last_30_days: 3.5, median_hours_to_acceptance_last_30_days: 7.25, as_of: '2026-11-02T00:00:00.000Z',
      },
      review: { new_setter_first_listings: 1, target_hours: 24, median_hours_to_approval_last_30_days: 6, note: 'A target, not a guarantee.' },
      caps_autoscale: {
        enabled: true, streak: 7, target: 20, level: 0,
        ceilings: { max_task_bounty_minor: 50000, new_setter_task_cap_minor: 10000, setter_daily_cap_minor: 100000, site_daily_cap_minor: 500000 },
        last_changed_at: null, description: 'The money caps grow with the marketplace\'s track record.',
      },
      events: { how: 'Poll GET /v1/events?after=<seq>.', types: [{ type: 'task.pending_review', visible_to: 'the Setter and admins', meaning: 'Waits for review.' }] },
      confirm_url: 'confirm_url appears in a result ONLY when the account holder has one thing to do on the website, signed in, that an agent key cannot do.',
      links: { api: 'https://api.test/v1', mcp: 'https://api.test/mcp', website: 'https://web.test', task_page: 'https://web.test/task/{id}' },
      links_note: 'api, openapi, mcp ... are built from the origin that answered this request (the API). website, task_page ... from the public website base (PUBLIC_BASE_URL).',
    };
    const fake = fakeFetch(routes({ 'GET /v1/capabilities': { json: doc } }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetch: fake.fetch });
    const capabilities = await client.capabilities();
    assert.deepEqual(capabilities, doc);
    assert.equal(capabilities.mode, 'sandbox');
    assert.equal(capabilities.live_charges, false);
    assert.equal(capabilities.timezone, 'UTC');
    assert.equal(capabilities.money?.setter_daily_cap_minor, 20000);
    assert.equal(capabilities.activity?.open_tasks, 2);
    assert.equal(capabilities.activity?.median_hours_to_first_application_last_30_days, 3.5);
    assert.equal(capabilities.activity?.median_hours_to_acceptance_last_30_days, 7.25);
    assert.equal(capabilities.review?.target_hours, 24);
    assert.equal(capabilities.review?.median_hours_to_approval_last_30_days, 6);
    assert.equal(capabilities.review?.new_setter_first_listings, 1);
    assert.equal(capabilities.money?.new_setter_review_count, 1);
    assert.equal(capabilities.money?.fee_holiday_until, '2026-12-31T00:00:00.000Z');
    assert.match(capabilities.money?.fee_holiday ?? '', /0% for every Hunter, human or AI agent alike/);
    assert.equal(capabilities.caps_autoscale?.enabled, true);
    assert.equal(capabilities.caps_autoscale?.streak, 7);
    assert.equal(capabilities.caps_autoscale?.target, 20);
    assert.equal(capabilities.caps_autoscale?.level, 0);
    assert.equal(capabilities.caps_autoscale?.ceilings.max_task_bounty_minor, 50000);
    assert.equal(capabilities.caps_autoscale?.last_changed_at, null);
    assert.equal(capabilities.events?.types?.[0]?.type, 'task.pending_review');
    assert.equal(capabilities.links?.api, 'https://api.test/v1');
    assert.match(capabilities.links_note!, /public website base/);
    assert.match(capabilities.confirm_url!, /the account holder has one thing to do on the website, signed in, that an agent key cannot do/);
  });

  it('validateTask posts the draft with validate_only: true and returns the platform\'s { valid, would_create, warnings }', async () => {
    const dry = {
      valid: true,
      would_create: {
        ...sampleTask, id: null, website_url: null, published_at: null, created_at: null, status: 'pending_review', setter_user_id: 'u1', setter_agent_id: 'a1',
        auto_accept: { ...sampleTask.auto_accept, confirmed_at: null }, review_reasons: null,
      },
      warnings: [{ code: 'listing_will_be_reviewed', message: 'A new Setter\'s first listing is reviewed by the founder before becoming visible.' }],
    };
    const fake = fakeFetch(routes({ 'POST /v1/tasks': { status: 200, json: dry } }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const result = await client.validateTask({
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable,
      acceptance_criteria: sampleTask.acceptance_criteria, category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24,
    });
    assert.equal((fake.calls[0]!.body as Record<string, unknown>).validate_only, true);
    assert.equal(result.valid, true);
    assert.equal(result.would_create.id, null);
    assert.equal(result.would_create.website_url, null);
    assert.equal(result.would_create.status, 'pending_review');
    assert.equal(result.would_create.review_reasons, null);
    assert.equal(result.warnings[0]!.code, 'listing_will_be_reviewed');
  });

  it('events takes a task id and sends it as task_id', async () => {
    const fake = fakeFetch(routes({ 'GET /v1/events': { json: { events: [], next_after: 5 } } }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    await client.events(5, 20, UUID_A);
    assert.equal(fake.calls[0]!.url.search, `?after=5&limit=20&task_id=${UUID_A}`);
    await client.events(5, 20);
    assert.equal(fake.calls[1]!.url.search, '?after=5&limit=20');
    await client.events(5, 20, null);
    assert.equal(fake.calls[2]!.url.search, '?after=5&limit=20');
  });

  it('deliver and approve are typed with the one payment shape and next_step', async () => {
    const fake = fakeFetch(routes({
      [`POST /v1/assignments/${UUID_A}/approve`]: { json: { id: 'rev-1', assignment_id: UUID_A, status: 'approved', approved_by: { user_id: 'u1', agent_id: 'a1', kind: 'ai_agent' }, payment: { status: 'captured', authorised_minor: 2500, captured_minor: 2500, refunded_minor: 0, hunter_fee_minor: 375, hunter_net_minor: 2125, currency: 'AUD' }, next_step: 'Approved. A$25.00 captured; nothing more is charged.' } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const approved = await client.approve(UUID_A);
    assert.equal(approved.payment.hunter_net_minor, 2125);
    assert.equal(approved.approved_by?.kind, 'ai_agent');
    assert.match(approved.next_step, /A\$25\.00 captured/);
  });

  it('reports are never idempotent-keyed (anonymous)', async () => {
    const fake = fakeFetch(routes({ 'POST /v1/reports': { status: 201, json: { id: 'r1', status: 'open' } } }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetch: fake.fetch });
    await client.report({ target_kind: 'task', target_id: UUID_A, reason: 'prohibited_task' });
    assert.equal(fake.calls[0]!.headers['idempotency-key'], undefined);
  });
});

describe('api client: files (2026-10-11)', () => {
  const PDF = new TextEncoder().encode('%PDF');

  it('uploadFile sends the raw bytes with X-Filename (percent-encoded) and Content-Type, the key, no JSON and no Idempotency-Key; the scope is the query', async () => {
    const fake = fakeFetch(routes({
      'POST /v1/uploads': (call) => ({ status: 201, json: { ...sampleAttachment, size: call.bytes!.byteLength } }),
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_k' }, fetch: fake.fetch, idempotencyKey: () => 'idem' });
    const uploaded = await client.uploadFile({ type: 'delivery', assignmentId: UUID_B }, { filename: 'summary.pdf', contentType: 'application/pdf', bytes: PDF });
    assert.deepEqual(uploaded, sampleAttachment);
    const call = fake.calls[0]!;
    assert.equal(call.url.href, `https://api.test/v1/uploads?assignment_id=${UUID_B}`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer bhk_k');
    assert.equal(call.headers['user-agent'], USER_AGENT);
    assert.equal(call.headers['x-filename'], 'summary.pdf');
    assert.equal(call.headers['content-type'], 'application/pdf', 'the declared type, not application/json');
    assert.equal(call.headers['idempotency-key'], undefined, 'the raw route has no Idempotency-Key');
    assert.equal(call.body, null);
    assert.deepEqual(call.bytes, PDF, 'the file itself is the body');

    await client.uploadFile({ type: 'task', taskId: UUID_A }, { filename: 'brief notes.pdf', contentType: 'application/pdf', bytes: PDF });
    assert.equal(fake.calls[1]!.url.search, `?task_id=${UUID_A}`, 'a brief file of a posted task');
    assert.equal(fake.calls[1]!.headers['x-filename'], 'brief%20notes.pdf');
    await client.uploadFile({ type: 'task' }, { filename: 'résumé.pdf', contentType: 'application/pdf', bytes: PDF });
    assert.equal(fake.calls[2]!.url.search, '', 'a draft brief file for a task about to be posted');
    assert.equal(fake.calls[2]!.headers['x-filename'], 'r%C3%A9sum%C3%A9.pdf', 'non-ASCII names are percent-encoded for the header');
  });

  it('uploadFile maps the platform refusals like every other route (413 file_too_large with the limit, 422 file_type_not_allowed, 501 without storage)', async () => {
    const fake = fakeFetch(routes({
      'POST /v1/uploads': (call) => (call.headers['x-filename'] === 'big.zip'
        ? { status: 413, json: { error: { code: 'file_too_large', message: 'Files are at most 26214400 bytes.', status: 413, details: { limit_bytes: 26214400 } } } }
        : call.headers['x-filename'] === 'setup.exe'
          ? { status: 422, json: { error: { code: 'file_type_not_allowed', message: '.exe files are refused: executables, installers and runnable scripts cannot be attached.', status: 422, details: { filename: 'setup.exe' } } } }
          : { status: 501, json: { error: { code: 'not_implemented', message: 'This deployment has no file storage.', status: 501 } } }),
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const big = await client.uploadFile({ type: 'task' }, { filename: 'big.zip', contentType: 'application/zip', bytes: PDF }).then(() => null, (e: unknown) => e);
    assert.ok(big instanceof ApiClientError);
    assert.equal(big.status, 413);
    assert.equal(big.code, 'file_too_large');
    assert.deepEqual(big.details, { limit_bytes: 26214400 });
    const exe = await client.uploadFile({ type: 'task' }, { filename: 'setup.exe', contentType: 'application/octet-stream', bytes: PDF }).then(() => null, (e: unknown) => e);
    assert.ok(exe instanceof ApiClientError);
    assert.equal(exe.code, 'file_type_not_allowed');
    const none = await client.uploadFile({ type: 'task' }, { filename: 'a.pdf', contentType: 'application/pdf', bytes: PDF }).then(() => null, (e: unknown) => e);
    assert.ok(none instanceof ApiClientError);
    assert.equal(none.status, 501);
    assert.equal(none.code, 'not_implemented');
  });

  it('downloadFile returns the bytes with the served type, the disposition and the decoded filename; deleteFile is a plain DELETE (204)', async () => {
    const fake = fakeFetch(routes({
      [`GET /v1/files/${UUID_FILE}`]: {
        bytes: PDF,
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="summary.pdf"; filename*=UTF-8\'\'summary.pdf', 'x-content-type-options': 'nosniff' },
      },
      [`GET /v1/files/${UUID_FILE_2}`]: {
        bytes: PDF,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="r_sum_.md"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.md' },
      },
      [`GET /v1/files/${UUID_A}`]: { status: 403, json: { error: { code: 'not_a_participant', message: 'Only the task\'s participants can download this file.', status: 403 } } },
      [`DELETE /v1/files/${UUID_FILE}`]: { status: 204 },
      [`DELETE /v1/files/${UUID_FILE_2}`]: { status: 409, json: { error: { code: 'file_not_editable', message: 'The delivery was submitted; its files are part of the record.', status: 409 } } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch, idempotencyKey: () => 'idem' });
    const file = await client.downloadFile(UUID_FILE);
    assert.equal(fake.calls[0]!.headers.accept, '*/*', 'bytes, not a JSON document');
    assert.equal(fake.calls[0]!.headers.authorization, 'Bearer k');
    assert.equal(new TextDecoder().decode(file.bytes), '%PDF');
    assert.equal(file.size, 4);
    assert.equal(file.content_type, 'application/pdf');
    assert.equal(file.filename, 'summary.pdf');
    assert.match(file.content_disposition!, /^inline;/);
    const text = await client.downloadFile(UUID_FILE_2);
    assert.equal(text.filename, 'résumé.md', 'filename* (RFC 5987) wins over the ASCII fallback');
    assert.equal(text.content_type, 'text/plain; charset=utf-8');
    assert.match(text.content_disposition!, /^attachment;/);
    const refused = await client.downloadFile(UUID_A).then(() => null, (e: unknown) => e);
    assert.ok(refused instanceof ApiClientError);
    assert.equal(refused.status, 403);
    assert.equal(refused.code, 'not_a_participant');

    await client.deleteFile(UUID_FILE);
    const del = fake.calls.at(-1)!;
    assert.equal(del.method, 'DELETE');
    assert.equal(del.url.pathname, `/v1/files/${UUID_FILE}`);
    assert.equal(del.headers['idempotency-key'], undefined);
    assert.equal(del.body, null);
    const immutable = await client.deleteFile(UUID_FILE_2).then(() => null, (e: unknown) => e);
    assert.ok(immutable instanceof ApiClientError);
    assert.equal(immutable.code, 'file_not_editable');
  });

  it('deliver sends attachment_ids only when files are attached (an older deployment never sees the key); createTask passes attachment_ids through', async () => {
    const fake = fakeFetch(routes({
      [`POST /v1/assignments/${UUID_B}/deliveries`]: { status: 201, json: { id: 'rev-1', assignment_id: UUID_B, delivery_id: 'd-1', status: 'pending' } },
      'POST /v1/tasks': { status: 201, json: { ...sampleTask, status: 'pending_review', attachments: [{ id: UUID_FILE_2, filename: 'papers.zip', size: 3, content_type: 'application/zip' }] } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    await client.deliver(UUID_B, 'Done.', ['https://a.test'], [UUID_FILE, UUID_FILE_2]);
    assert.deepEqual(fake.calls[0]!.body, { summary: 'Done.', links: ['https://a.test'], attachment_ids: [UUID_FILE, UUID_FILE_2] });
    await client.deliver(UUID_B, 'Done.', [], []);
    assert.deepEqual(fake.calls[1]!.body, { summary: 'Done.', links: [] });
    const created = await client.createTask({
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable, acceptance_criteria: sampleTask.acceptance_criteria,
      category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24, attachment_ids: [UUID_FILE_2],
    });
    assert.deepEqual((fake.calls[2]!.body as Record<string, unknown>).attachment_ids, [UUID_FILE_2]);
    assert.equal(created.attachments[0]!.filename, 'papers.zip');
  });
});

describe('api client: error mapping', () => {
  it('maps the platform error document to ApiClientError with status, code, message and details', async () => {
    const fake = fakeFetch(() => ({
      status: 422,
      json: { error: { code: 'prohibited_task', message: 'This task matches a prohibited category.', status: 422, details: { categories: ['fake_reviews'] } } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'k' }, fetch: fake.fetch });
    const error = await client.createTask({
      title: 'Buy 100 five-star reviews', brief: 'x'.repeat(20), deliverable: 'reviews', acceptance_criteria: 'visible',
      category_code: 'other', bounty_minor: 1000, delivery_hours: 1,
    }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'prohibited_task');
    assert.equal(error.message, 'This task matches a prohibited category.');
    assert.deepEqual(error.details, { categories: ['fake_reviews'] });
    assert.equal(error.retryable, false, 'a 422 from an older deployment without the field: derived from the status');
    assert.deepEqual(error.toJSON(), {
      error: { code: 'prohibited_task', message: 'This task matches a prohibited category.', status: 422, details: { categories: ['fake_reviews'] }, retryable: false },
    });
  });

  it('falls back to http_error when the failure body is not the platform document', async () => {
    const fake = fakeFetch(() => ({ status: 502, text: '<html>Bad gateway</html>' }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetch: fake.fetch });
    const error = await client.capabilities().then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'http_error');
    assert.equal(error.message, 'HTTP 502');
    assert.equal(error.retryable, true, '5xx: retryable by the platform rule');
    assert.deepEqual(error.toJSON(), { error: { code: 'http_error', message: 'HTTP 502', status: 502, retryable: true } });
  });

  it('retryable (platform 2026-10-30.2): the platform\'s value is passed through unchanged, even when the status alone would say otherwise', async () => {
    const fake = fakeFetch(() => ({
      status: 409,
      json: { error: { code: 'webhook_in_flight', message: 'This event is being processed; Stripe will retry.', status: 409, retryable: true } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetch: fake.fetch });
    const error = await client.capabilities().then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.retryable, true);
    assert.deepEqual(error.toJSON(), { error: { code: 'webhook_in_flight', message: 'This event is being processed; Stripe will retry.', status: 409, retryable: true } });
    const unreachable = new ApiClientError(0, 'network_error', 'Could not reach https://api.test: ECONNREFUSED');
    assert.equal(unreachable.retryable, true, 'status 0 (unreachable) is retryable');
    assert.equal(new ApiClientError(429, 'rate_limited', 'Too many requests.').retryable, true);
    assert.equal(new ApiClientError(409, 'idempotency_key_reused', 'Reused.').retryable, false, 'a plain 409 is not retryable until something changes');
  });

  it('rejects a non-JSON success body as invalid_response', async () => {
    const fake = fakeFetch(() => ({ status: 200, text: 'ok' }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetch: fake.fetch });
    const error = await client.capabilities().then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.code, 'invalid_response');
  });

  it('wraps a failed connection as network_error with status 0 and the API origin in the message', async () => {
    const failing = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const client = createApiClient({ baseUrl: 'https://api.test', fetch: failing });
    const error = await client.health().then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 0);
    assert.equal(error.code, 'network_error');
    assert.match(error.message, /https:\/\/api\.test/);
    assert.match(error.message, /fetch failed/);
  });
});

describe('api client: environment', () => {
  it('defaults to DEFAULT_API_URL and no key', () => {
    assert.deepEqual(configFromEnv({}), { apiUrl: DEFAULT_API_URL, apiKey: null, webUrl: null });
  });

  it('trims trailing slashes and blank values', () => {
    const config = configFromEnv({ BOUNTYMARKET_API_URL: 'https://sandbox.test///', BOUNTYMARKET_API_KEY: '  ', BOUNTYMARKET_WEB_URL: 'https://web.test/' });
    assert.deepEqual(config, { apiUrl: 'https://sandbox.test', apiKey: null, webUrl: 'https://web.test' });
  });

  it('refuses a URL without a scheme', () => {
    assert.throws(() => configFromEnv({ BOUNTYMARKET_API_URL: 'sandbox.test' }), /http/);
  });

  it('formats AUD minor units', () => {
    assert.equal(formatAud(1000), 'A$10.00');
    assert.equal(formatAud(2125), 'A$21.25');
    assert.equal(formatAud(5), 'A$0.05');
    assert.equal(formatAud(-375), '-A$3.75');
  });
});

describe('api client: limit requests and min_hunter_tier (trust stage 1, platform 2026-10-19.2)', () => {
  const REASON = 'A 40-page translation that will not split into A$50 pieces.';

  it('createLimitRequest posts the request with the key and an Idempotency-Key; myLimitRequests reads the summary; withdrawLimitRequest is a DELETE on the encoded id', async () => {
    const fake = fakeFetch(routes({
      'POST /v1/me/limit-requests': (call) => ({ status: 201, json: { request: { ...sampleLimitRequest, ...(call.body as Record<string, unknown>) }, next_step: LIMIT_REQUEST_STEP } }),
      'GET /v1/me/limit-requests': { json: sampleLimitSummary },
      [`DELETE /v1/me/limit-requests/${UUID_REQ}`]: { json: { request: { ...sampleLimitRequest, status: 'withdrawn' }, next_step: 'Withdrawn.' } },
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_abc' }, fetch: fake.fetch, idempotencyKey: () => 'idem-9' });
    const created = await client.createLimitRequest({ side: 'setter', level: 1, task_id: UUID_A, requested: { per_task_cap_minor: 15000 }, reason: REASON });
    assert.equal(created.request.id, UUID_REQ);
    assert.equal(created.request.requested.per_task_cap_minor, 15000);
    assert.equal(created.next_step, LIMIT_REQUEST_STEP);
    const post = fake.calls[0]!;
    assert.equal(post.method, 'POST');
    assert.equal(post.url.pathname, '/v1/me/limit-requests');
    assert.equal(post.headers.authorization, 'Bearer bhk_abc');
    assert.equal(post.headers['idempotency-key'], 'idem-9');
    assert.deepEqual(post.body, { side: 'setter', level: 1, task_id: UUID_A, requested: { per_task_cap_minor: 15000 }, reason: REASON });

    const summary = await client.myLimitRequests();
    assert.deepEqual(summary, sampleLimitSummary);
    assert.equal(fake.calls[1]!.method, 'GET');
    assert.equal(fake.calls[1]!.url.pathname, '/v1/me/limit-requests');
    assert.equal(summary.pacing.max_per_30d, 3);
    assert.equal(summary.request_route, 'POST /v1/me/limit-requests');

    const withdrawn = await client.withdrawLimitRequest(UUID_REQ);
    assert.equal(withdrawn.request.status, 'withdrawn');
    assert.equal(fake.calls[2]!.method, 'DELETE');
    assert.equal(fake.calls[2]!.url.pathname, `/v1/me/limit-requests/${UUID_REQ}`);
    assert.equal(fake.calls[2]!.body, null);
  });

  it('a limit-request refusal maps like every other platform error (409 limit_request_open_exists with details and next_step)', async () => {
    const fake = fakeFetch(routes({ 'POST /v1/me/limit-requests': { status: 409, json: {
      error: { code: 'limit_request_open_exists', status: 409, message: 'You already have a limit request waiting.', details: { request_id: UUID_REQ, level: 1, side: 'setter' } },
      next_step: 'Wait for the decision or withdraw it.',
    } } }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_abc' }, fetch: fake.fetch });
    await assert.rejects(
      client.createLimitRequest({ side: 'setter', level: 1, requested: { per_task_cap_minor: 15000 }, reason: REASON }),
      (error: unknown) => error instanceof ApiClientError && error.status === 409 && error.code === 'limit_request_open_exists'
        && (error.details as { request_id: string }).request_id === UUID_REQ && error.nextStep === 'Wait for the decision or withdraw it.',
    );
  });

  it('createTask and validateTask pass min_hunter_tier through as given, and omit it when absent (an older deployment never sees the key)', async () => {
    const fake = fakeFetch(routes({ 'POST /v1/tasks': (call) => ((call.body as Record<string, unknown>).validate_only
      ? { json: { valid: true, would_create: { ...sampleTask, min_hunter_tier: 'gold' }, warnings: [] } }
      : { status: 201, json: { ...sampleTask, min_hunter_tier: (call.body as Record<string, unknown>).min_hunter_tier ?? null } }) }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_abc' }, fetch: fake.fetch });
    const base = {
      title: sampleTask.title, brief: sampleTask.brief, deliverable: sampleTask.deliverable,
      acceptance_criteria: sampleTask.acceptance_criteria, category_code: 'data_research', bounty_minor: 2500, delivery_hours: 24,
    };
    const gated = await client.createTask({ ...base, min_hunter_tier: 'gold' });
    assert.equal(gated.min_hunter_tier, 'gold');
    assert.equal((fake.calls[0]!.body as Record<string, unknown>).min_hunter_tier, 'gold');
    const open = await client.createTask(base);
    assert.equal(open.min_hunter_tier, null);
    assert.equal('min_hunter_tier' in (fake.calls[1]!.body as Record<string, unknown>), false);
    const dry = await client.validateTask({ ...base, min_hunter_tier: 'gold' });
    assert.equal(dry.valid, true);
    assert.deepEqual(fake.calls[2]!.body, { ...base, min_hunter_tier: 'gold', validate_only: true });
  });
});

describe('api client: trust stage 2 (platform 2026-10-30.1)', () => {
  const REASON = 'A long-term agency line for weekly batches of translation work.';
  it('createLimitRequest passes the level-3 application form (detail) through as given and omits it when absent; the echoed request carries it', async () => {
    const detail = {
      legal_name: 'Ada Lovelace Pty Ltd', abn: '00000000000', website: 'https://ada.example', use_case: 'Weekly batches of translation and proofreading for our clients.',
      expected_monthly_minor: 400000, expected_tasks_per_month: 40, typical_counterparties: 'Freelance translators and small agencies.', contact_phone: '+61 491 570 006', agrees_to_call: true,
    };
    const fake = fakeFetch(routes({
      'POST /v1/me/limit-requests': (call) => ({ status: 201, json: { request: { ...sampleLimitRequest, level: 3, task_id: null, ...(call.body as Record<string, unknown>) }, next_step: LIMIT_REQUEST_STEP } }),
    }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_abc' }, fetch: fake.fetch, idempotencyKey: () => 'idem-3' });
    const created = await client.createLimitRequest({ side: 'setter', level: 3, requested: { total_cap_minor: 200000 }, reason: REASON, detail });
    assert.deepEqual(fake.calls[0]!.body, { side: 'setter', level: 3, requested: { total_cap_minor: 200000 }, reason: REASON, detail });
    assert.deepEqual(created.request.detail, detail);
    assert.equal(created.request.level, 3);
    await client.createLimitRequest({ side: 'hunter', level: 2, requested: { slots: 5 }, reason: REASON });
    assert.equal('detail' in (fake.calls[1]!.body as Record<string, unknown>), false, 'no detail key when none was given');
  });

  it('a level-3 request without detail (as the MCP tool files it) is the platform\'s 422 limit_request_invalid { field: detail }, mapped like every other error', async () => {
    const fake = fakeFetch(routes({ 'POST /v1/me/limit-requests': { status: 422, json: {
      error: { code: 'limit_request_invalid', status: 422, message: 'A level-3 request carries the application form (detail).', details: { field: 'detail', reason: 'required_at_level_3' } },
      next_step: 'File the Contractor application on the website.',
    } } }));
    const client = createApiClient({ baseUrl: 'https://api.test', auth: { kind: 'api_key', apiKey: 'bhk_abc' }, fetch: fake.fetch });
    await assert.rejects(
      client.createLimitRequest({ side: 'setter', level: 3, requested: { total_cap_minor: 200000 }, reason: REASON }),
      (error: unknown) => error instanceof ApiClientError && error.status === 422 && error.code === 'limit_request_invalid'
        && (error.details as { field: string }).field === 'detail' && error.nextStep === 'File the Contractor application on the website.',
    );
  });
});
