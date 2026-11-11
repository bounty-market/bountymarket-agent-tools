/**
 * A `fetch` double for tests: no network. Each call is recorded; the handler
 * decides the response from the parsed URL, method, headers and JSON body.
 */
export type RecordedCall = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** The parsed JSON body; null for no body or a raw (binary) body. */
  body: unknown;
  /** The raw body when the request sent bytes (POST /v1/uploads); null otherwise. */
  bytes: Uint8Array | null;
};

export type FakeResponse = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };

export type FakeHandler = (call: RecordedCall) => FakeResponse | Promise<FakeResponse>;

export function fakeFetch(handler: FakeHandler) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const bytes = init?.body instanceof Uint8Array ? init.body : null;
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body: rawBody ? JSON.parse(rawBody) : null, bytes };
    calls.push(call);
    const out = await handler(call);
    const status = out.status ?? 200;
    if (out.bytes) {
      return new Response(out.bytes, { status, headers: { 'content-type': 'application/octet-stream', ...(out.headers ?? {}) } });
    }
    const body = out.text ?? (out.json === undefined ? '' : JSON.stringify(out.json));
    // A 204 (DELETE /v1/files/:id) has no body by definition; the Response constructor refuses one.
    return new Response(status === 204 || status === 205 || status === 304 ? null : body, {
      status,
      headers: { 'content-type': out.text === undefined ? 'application/json' : 'text/plain', ...(out.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** A handler that routes by `METHOD /path` (query string ignored); unknown routes 404. */
export function routes(table: Record<string, FakeResponse | ((call: RecordedCall) => FakeResponse)>): FakeHandler {
  return (call) => {
    const key = `${call.method} ${call.url.pathname}`;
    const entry = table[key];
    if (!entry) return { status: 404, json: { error: { code: 'not_found', message: `No route for ${key}`, status: 404 } } };
    return typeof entry === 'function' ? entry(call) : entry;
  };
}

export const UUID_A = '11111111-1111-4111-8111-111111111111';
export const UUID_B = '22222222-2222-4222-8222-222222222222';
export const UUID_C = '33333333-3333-4333-8333-333333333333';
export const UUID_D = '44444444-4444-4444-8444-444444444444';

/** The task page on the website: every task document carries it as website_url. */
export const WEBSITE_URL_A = `https://web.test/task/${UUID_A}`;

export const sampleTask = {
  id: UUID_A,
  website_url: WEBSITE_URL_A,
  title: 'Summarise three research papers',
  brief: 'Read three linked PDF papers on battery chemistry and write a two-page plain-language summary.',
  deliverable: 'A Google Doc link with the summary.',
  acceptance_criteria: 'Covers all three papers; no more than two pages; sources cited.',
  category_code: 'data_research',
  bounty_minor: 2500,
  currency: 'AUD' as const,
  delivery_hours: 24,
  status: 'open',
  is_platform_posted: false,
  published_at: '2026-10-05T01:00:00.000Z',
  version: 1,
  setter_display_name: 'Ada',
  setter_is_ai_agent: true,
  setter_agent_display_name: 'Ada Bot',
  auto_accept: { enabled: false, allow_agents: true, min_settled: 0, active: false },
  attachments: [] as Array<{ id: string; filename: string; size: number; content_type: string }>,
};

export const UUID_FILE = '55555555-5555-4555-8555-555555555555';
export const UUID_FILE_2 = '66666666-6666-4666-8666-666666666666';

/** An attachment as the platform returns it (attachmentDto, 2026-10-11): metadata only, the bytes are at GET /v1/files/{id}. */
export const sampleAttachment = { id: UUID_FILE, filename: 'summary.pdf', size: 4, content_type: 'application/pdf' };
export const sampleBriefFile = { id: UUID_FILE_2, filename: 'papers.zip', size: 3, content_type: 'application/zip' };

/** The owner's view adds confirmed_at (null while an agent-requested opt-in waits for the owner) and review_reasons (2026-10-08; null unless the screen held the listing). */
export const sampleOwnerTask = {
  ...sampleTask,
  setter_user_id: 'u1',
  setter_agent_id: 'a1',
  created_at: '2026-10-05T00:00:00.000Z',
  auto_accept: { enabled: false, allow_agents: true, min_settled: 0, active: false, confirmed_at: null },
  review_reasons: null as string[] | null,
};

/** The owner's view of a listing the screen held for an online-only check: pending_review whatever the Setter's history, review_reasons set. */
export const heldOwnerTask = {
  ...sampleOwnerTask,
  title: 'Deliver to my office and scan the signed forms',
  status: 'pending_review',
  published_at: null,
  review_reasons: ['offline_task'],
};

/** The same documents as an older deployment returned them: no website_url. */
export function withoutWebsiteUrl<T extends { website_url: string }>(task: T): Omit<T, 'website_url'> {
  const { website_url: _w, ...rest } = task;
  return rest;
}

export const sampleAssignment = {
  id: UUID_B,
  task_id: UUID_A,
  application_id: UUID_C,
  hunter_user_id: 'hunter-1',
  hunter_agent_id: null,
  hunter_is_ai_agent: false,
  accepted_at: '2026-10-05T02:00:00.000Z',
  deadline_at: '2026-10-06T02:00:00.000Z',
  bounty_minor: 2500,
  currency: 'AUD' as const,
  fee_bps: 1500,
  fee_minor: 375,
  net_minor: 2125,
  tier_code: 'bronze',
  tier_rank: 1,
  tier_eligible_count: 0,
  policy_version: 2,
  tier_evaluated_at: '2026-10-05T02:00:00.000Z',
  fee_holiday: false,
  status: 'active',
  completed_at: null,
};

/** The same contract accepted during a published fee holiday (2026-10-08): 0% fee for the Hunter, tier still recorded, net = bounty. */
export const holidayAssignment = { ...sampleAssignment, fee_bps: 0, fee_minor: 0, net_minor: 2500, fee_holiday: true };

/** A pending review as the platform returns it (approved_by is null until approved). */
export const sampleReview = {
  id: UUID_D,
  assignment_id: UUID_B,
  delivery_id: 'delivery-1',
  status: 'pending',
  review_deadline_at: '2026-10-08T02:00:00.000Z',
  approved_at: null,
  approved_by: null,
  issue_type: null,
  issue_detail: null,
  issue_raised_at: null,
  hunter_response: null,
  hunter_response_at: null,
  hunter_response_deadline_at: null,
  decided_at: null,
  outcome: null,
  adjustment_bps: null,
  decision_note: null,
};

/** The review after the Setter's agent approved it: approved_by names the agent. */
export const approvedReview = {
  ...sampleReview,
  status: 'approved',
  approved_at: '2026-10-06T00:00:00.000Z',
  approved_by: { user_id: 'u1', agent_id: 'a1', kind: 'ai_agent' },
};

export const sampleDelivery = {
  id: 'delivery-1',
  assignment_id: UUID_B,
  attempt: 1,
  summary: 'Done: summary attached.',
  links: ['https://docs.example/summary'],
  attachments: [] as Array<{ id: string; filename: string; size: number; content_type: string }>,
  content_digest: 'sha256:abc',
  submitted_at: '2026-10-05T20:00:00.000Z',
};

/**
 * The one payment shape every surface returns: before acceptance, while the
 * card hold is in place (the fee and net are the Hunter's side), and after capture.
 */
export const noPayment = { status: 'none' as const, authorised_minor: 0, captured_minor: 0, refunded_minor: 0, hunter_fee_minor: 0, hunter_net_minor: 0, currency: 'AUD' as const };
export const heldPayment = { status: 'held' as const, authorised_minor: 2500, captured_minor: 0, refunded_minor: 0, hunter_fee_minor: 375, hunter_net_minor: 2125, currency: 'AUD' as const };
export const capturedPayment = { ...heldPayment, status: 'captured' as const, captured_minor: 2500 };
/** Alias kept for the assignment-detail fixtures. */
export const samplePayment = heldPayment;

/** The former assignment-detail payment block (an older deployment): folded into the one shape by the local tools. */
export const legacyHeldPayment = {
  status: 'requires_capture', amount_minor: 2500, application_fee_minor: 375, captured_minor: 0, refunded_minor: 0,
  capture_before_at: '2026-10-11T02:00:00.000Z', currency: 'AUD' as const,
};
export const legacyCapturedPayment = { ...legacyHeldPayment, status: 'captured', captured_minor: 2500 };

/** An application as the platform returns it (applicationDto), pending and not auto-accepted. */
export const sampleApplication = {
  id: UUID_C,
  task_id: UUID_A,
  hunter_user_id: 'hunter-1',
  hunter_agent_id: 'agent-1',
  hunter_display_name: 'Bob',
  hunter_is_ai_agent: true,
  message: 'I am an AI agent acting for Bob.',
  status: 'pending',
  auto_accept_skipped_reason: null,
  created_at: '2026-10-05T01:30:00.000Z',
  decided_at: null,
};

/** The fields every participant view carries before anyone is accepted (null / [] when empty; agent_authority null for a human session or an older deployment). */
export const emptyParticipant = { assignment: null, deliveries: [], review: null, payment: noPayment, agent_authority: null };

const REVIEW_TAIL = 'It becomes "open" when approved (task.published event; task.pending_review is in your event feed now). Hunters can only apply once it is '
  + 'open, and the 24-hour delivery clock starts at acceptance, not at posting, so no wall-clock completion time can be promised yet.';

/** 2026-10-08: the founder reviews a new Setter's FIRST listing only (was "new Setters' first listings"). */
const REVIEW_SENTENCE = 'This listing awaits founder review: the founder is reviewing a new Setter\'s first listing by hand (target 24 hours, a target, not a '
  + `guarantee; capabilities.review.median_hours_to_approval_last_30_days gives the recent median) and it is not public yet. ${REVIEW_TAIL}`;

/** The screening hold (2026-10-08): in-person wording holds the listing for a founder check instead of refusing it. */
export const HELD_SENTENCE = 'Your listing is held for a founder check because it looks like it may need in-person work (BountyMarket is online-only at launch). '
  + 'If it is online, no action is needed; the founder will release it.';

const WATCH = 'Watch get_events (or GET /v1/events?task_id=<id>): assignment.created means you were accepted and the delivery clock started; '
  + 'capabilities.activity.median_hours_to_acceptance_last_30_days gives a typical wait.';

/**
 * The platform's next_step texts (src/participant.ts of the platform) used by the
 * fixtures. The local tools pass them through; the fallback texts in src/tools.ts
 * must reproduce them word for word (test/parity.test.ts checks).
 */
export const STEP = {
  /**
   * Setter, open, no auto-accept, no applications: no confirm_url yet. Also post_task's next_step for such a task.
   * (Mid-sentence the platform lowers only the first letter: "accept is not available over MCP".)
   */
  setterOpen: 'Open and waiting for applications (application.created events). When one arrives the account holder accepts it on the website (confirm_url is '
    + 'returned then); accept is not available over MCP or to agent keys. Accepting places a hold of A$25.00 on the saved card. The 24-hour delivery '
    + 'clock starts at acceptance.',
  /** Setter, open, one pending application, no auto-accept: confirm_url is the task page. */
  setterPending: '1 pending application. The account holder accepts one on the website at confirm_url; accept is not available over MCP or to agent keys. '
    + 'Accepting places a hold of A$25.00 on the saved card.',
  setterSkipped: '1 pending application did not qualify for auto-accept (agents_not_eligible); accept manually at confirm_url on the website or wait for a '
    + 'qualifying applicant. Accepting places a hold of A$25.00 on the saved card. Accept is not available over MCP or to agent keys. Disable auto-accept '
    + 'with disable_auto_accept (POST /v1/tasks/{id}/auto-accept/disable) if needed.',
  /** Setter, open, agent-requested auto-accept not yet confirmed, no applications: confirm_url is ?confirm=auto_accept. */
  setterOpenAwaiting: 'Confirm auto-accept at confirm_url (one click; auto_accept_status is pending_owner_confirmation and nothing is automatic until then). '
    + 'Until then the account holder accepts applications by hand on the website (confirm_url is returned when one arrives). Accepting places a hold of A$25.00 on '
    + 'the saved card. Accept is not available over MCP or to agent keys.',
  /** Platform 2026-11-12.1: the review window is set per delivery (24 hours by default), so the text points at review.review_deadline_at. */
  setterAssigned: 'The Hunter is working. The delivery will appear here (delivery.submitted event); then approve with approve_delivery (captures the A$25.00 '
    + 'authorised at acceptance) or raise_issue before the review deadline (review.review_deadline_at, set at delivery).',
  setterDelivered: 'Delivered. Approve with approve_delivery (captures exactly the A$25.00 authorised at acceptance; nothing more is charged) or raise_issue '
    + 'before 2026-10-08T02:00:00.000Z; silence auto-confirms.',
  /** Settled (platform 2026-10-11.6): the task status word first; the net is before Stripe's own fee and lands in the Stripe balance, never "settled". */
  setterSettled: 'Approved: A$25.00 captured from the saved card; nothing more is charged. The Hunter\'s net (A$21.25, after their A$3.75 platform fee, '
    + 'before Stripe\'s own processing fee) settles to the Hunter\'s Stripe balance (available after Stripe\'s holding period). Nothing to do.',
  applicantNotEligible: 'Your application is pending. This task\'s auto-accept does not include AI agents (auto_accept.allow_agents is false), so the platform '
    + `did not accept it; the Setter decides by hand on the website. ${WATCH} For an immediate start, prefer tasks with auto_accept.active true and allow_agents true.`,
  hunterAssigned: `Deliver with submit_delivery (task_id ${UUID_A} or assignment_id ${UUID_B}) before 2026-10-06T02:00:00.000Z; an undelivered contract expires 2 hours after the deadline without payment.`,
  hunterSettled: 'Approved: A$21.25 (bounty A$25.00 less the A$3.75 platform fee, before Stripe\'s own processing fee) settles to the account\'s Stripe balance '
    + '(available after Stripe\'s holding period). Nothing to do.',
  /** Hunter while the Setter asked to cancel: the one Hunter-side human action, so confirm_url is the task page. */
  hunterCancellation: 'The Setter asked to cancel by mutual agreement: the account holder confirms at confirm_url (a human click in every mode; the A$25.00 hold is '
    + `released, no penalty), or ignores it and the contract continues. Deliver with submit_delivery (task_id ${UUID_A} or assignment_id ${UUID_B}) before `
    + '2026-10-06T02:00:00.000Z; an undelivered contract expires 2 hours after the deadline without payment.',
  /** post_task for a new Setter: the review hold, then "follow it at website_url" (no confirm_url). */
  postedPendingReview: `${REVIEW_SENTENCE} Nothing to do yet; follow it at website_url.`,
  /** post_task / get_task for a listing the screen held for an online-only check (review_reasons offline_task): the hold sentence first, no confirm_url. */
  postedHeldForOnlineCheck: `${HELD_SENTENCE} It is not public yet (review_reasons: offline_task; target 24 hours, a target, not a guarantee). ${REVIEW_TAIL} `
    + 'Nothing to do yet; follow it at website_url.',
  /** post_task for a new Setter with an agent-requested auto-accept: the one click first, then the review hold. */
  postedPendingReviewAwaiting: `Confirm auto-accept at confirm_url (one click; it takes effect when the task opens). ${REVIEW_SENTENCE} Until the account holder `
    + 'confirms, auto_accept_status is pending_owner_confirmation and nothing is automatic; once confirmed, the first qualifying applicant is accepted '
    + 'automatically when the task is open (assignment.created with auto_accept: true).',
  /** submit_delivery / POST deliveries next_step: what settles to the Hunter. */
  delivered: 'Delivered. The Setter has until 2026-10-08T02:00:00.000Z to approve or raise an issue; silence auto-confirms. A$21.25 (the A$25.00 held at '
    + 'acceptance less your A$3.75 platform fee, before Stripe\'s own processing fee) then settles to the account\'s Stripe balance (available after Stripe\'s holding period).',
  /** approve_delivery / POST approve next_step: the status word first, the amount captured, nothing more charged, the net before Stripe's fee. */
  approved: 'Approved: A$25.00 captured; nothing more is charged. The Hunter\'s net (A$21.25, after their A$3.75 platform fee, before Stripe\'s own processing fee) '
    + 'settles to the Hunter\'s Stripe balance (available after Stripe\'s holding period). Nothing to do.',
};

/** GET /v1/me/money as the platform sends it (2026-10-15.11): a Bronze Hunter with one capture and one hold; a Setter with one hold. */
export const sampleMoney = {
  as_hunter: {
    rows: [
      {
        assignment_id: UUID_B, task_id: UUID_A, task_title: 'Tidy a 300-row customer list', task_status: 'approved', assignment_status: 'completed',
        state: 'approved_captured', bounty_minor: 4000, fee_bps: 1500, fee_holiday: false, tier_code: 'bronze', platform_fee_minor: 600, hunter_net_minor: 3400,
        captured_minor: 4000, refunded_minor: 0, estimated_stripe_fee_minor: 100, stripe_fee_estimated: true, currency: 'AUD',
        accepted_at: '2026-10-14T00:00:00.000Z', deadline_at: '2026-10-15T00:00:00.000Z', review_until: null, captured_at: '2026-10-15T05:00:00.000Z', ended_at: null, issue_open: false,
      },
    ],
    totals: {
      earned_net_minor: 3400, earned_count: 1, held_now_minor: 0, held_count: 0, awaiting_review_minor: 0, awaiting_review_count: 0,
      captured_last_30d_minor: 3400, captured_last_30d_count: 1, estimated_stripe_fees_minor: 100, currency: 'AUD',
    },
    stripe: { account_id: 'acct_x', charges_enabled: true, payouts_enabled: true, details_submitted: true, dashboard_url: 'https://connect.stripe.com/express_login', dashboard_hint: 'Sign in to your Stripe Express dashboard.' },
    earliest_payout_hint: 'Stripe releases funds to your balance after capture; payouts follow your Stripe schedule.',
    stripe_fee_estimate: { rate_bps: 165, fixed_minor: 30, note: 'An estimate.' },
  },
  as_setter: {
    rows: [
      {
        task_id: UUID_C, task_title: 'Proofread a pitch deck', task_status: 'assigned', assignment_id: UUID_D, hunter_display_name: 'Grace',
        state: 'held', bounty_minor: 2500, held_minor: 2500, captured_minor: 0, refunded_minor: 0, charged_minor: 0, currency: 'AUD',
        published_at: '2026-10-15T00:00:00.000Z', charged_at: null,
      },
    ],
    totals: { held_now_minor: 2500, held_count: 1, charged_this_month_minor: 0, charged_this_month_count: 0, charged_lifetime_minor: 0, charged_count: 0, refunded_minor: 0, currency: 'AUD' },
  },
  fee_tier: { code: 'bronze', fee_bps: 1500, fee_percent: 15, settled_count: 1, window_days: 180, next_tier: 'silver', next_fee_bps: 1400, next_fee_percent: 14, needed: 5, remaining: 4 },
  currency: 'AUD',
  server_time: '2026-10-15T06:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Limit requests (trust stage 1, platform 2026-10-19.2)
// ---------------------------------------------------------------------------

export const UUID_REQ = '55555555-5555-4555-8555-555555555555';
export const UUID_LINE = '66666666-6666-4666-8666-666666666666';

/** One limit request as the platform sends it: a level-1 Setter request on UUID_A filed by an agent key, pending. */
export const sampleLimitRequest = {
  id: UUID_REQ, user_id: 'u1', side: 'setter', level: 1, task_id: UUID_A, requested: { per_task_cap_minor: 15000 },
  reason: 'A 40-page translation that will not split into A$50 pieces.', status: 'pending', created_by_agent_id: 'a1', filed_by: 'ai_agent',
  decided: false, decided_at: null, decision_note: null, identity_confirmed: false, approved_values: null, duration_days: null, valid_from: null, valid_until: null,
  created_at: '2026-10-19T10:00:00.000Z', updated_at: '2026-10-19T10:00:00.000Z', override: null,
};

/** An approved level-1 line bound to UUID_A: the task's per-task cap raised to A$150, with the in-flight and daily room it lends. */
export const sampleLimitOverride = {
  id: UUID_LINE, request_id: UUID_REQ, user_id: 'u1', side: 'setter', scope: 'task', task_id: UUID_A,
  values: { per_task_cap_minor: 15000, total_cap_minor: 25000, daily_cap_minor: 25000 },
  valid_from: '2026-10-19T12:00:00.000Z', valid_until: '2026-10-26T12:00:00.000Z', revoked_at: null, revoked_reason: null, active: true,
};

/** GET /v1/me/limit-requests (= me.limit_requests): one pending request, no line yet, one of three filings used. */
export const sampleLimitSummary = {
  open: sampleLimitRequest, requests: [sampleLimitRequest], active_overrides: [], effective: { setter: null, hunter: null },
  pacing: { used_30d: 1, max_per_30d: 3, next_allowed_at: null, cooldown_until: null, can_request_now: false, pending_expiry_days: 7 },
  rules: { l1_multiplier: 3, l1_floor_minor: 60000, l1_days: 7, l2_durations_days: [1, 7, 30], l2_default_days: 1, max_per_30d: 3, pending_expiry_days: 7 },
  request_route: 'POST /v1/me/limit-requests',
};

/** The next_step the platform sends with a 201 on POST /v1/me/limit-requests (a fixture; the client has its own fallback). */
export const LIMIT_REQUEST_STEP = 'Filed. The founder answers in the console, normally within 24 hours; watch limit_request.approved / limit_request.declined.';

/** The live Setter rows (capabilities trust.setter_rows, platform 2026-10-19.2). */
export const setterRows = {
  bronze: { slots: 2, total_cap_minor: 10000, per_task_cap_minor: 5000, daily_cap_minor: 10000, posts_per_day: 20, cooling_days: 0 },
  silver: { slots: 3, total_cap_minor: 10000, per_task_cap_minor: 5000, daily_cap_minor: 20000, posts_per_day: 40, cooling_days: 0 },
  gold: { slots: 4, total_cap_minor: 20000, per_task_cap_minor: 10000, daily_cap_minor: 40000, posts_per_day: 80, cooling_days: 0 },
  platinum: { slots: 5, total_cap_minor: 50000, per_task_cap_minor: 20000, daily_cap_minor: 75000, posts_per_day: 150, cooling_days: 0 },
  diamond: { slots: 8, total_cap_minor: 150000, per_task_cap_minor: 30000, daily_cap_minor: 100000, posts_per_day: 300, cooling_days: 0 },
  obsidian: { slots: null, total_cap_minor: 300000, per_task_cap_minor: 50000, daily_cap_minor: 150000, posts_per_day: null, cooling_days: 0 },
};

/** The six-tier fee ladder by lifetime seasoned net earnings (money.fee_tiers, platform 2026-10-19.2). */
export const ladderFeeTiers = [
  { code: 'bronze', rank: 1, fee_bps: 2000, fee_percent: 20, minimum_earned_minor: 0, time_gate_days: 0, minimum_settled_tasks: null },
  { code: 'silver', rank: 2, fee_bps: 1500, fee_percent: 15, minimum_earned_minor: 25000, time_gate_days: 7, minimum_settled_tasks: null },
  { code: 'gold', rank: 3, fee_bps: 1300, fee_percent: 13, minimum_earned_minor: 100000, time_gate_days: 30, minimum_settled_tasks: null },
  { code: 'platinum', rank: 4, fee_bps: 1000, fee_percent: 10, minimum_earned_minor: 500000, time_gate_days: 30, minimum_settled_tasks: null },
  { code: 'diamond', rank: 5, fee_bps: 800, fee_percent: 8, minimum_earned_minor: 1500000, time_gate_days: 90, minimum_settled_tasks: null },
  { code: 'obsidian', rank: 6, fee_bps: 500, fee_percent: 5, minimum_earned_minor: 3000000, time_gate_days: 180, minimum_settled_tasks: null },
];

/** The legacy 180-day count ladder (money.legacy_fee_tiers; charged while trust.mode is shadow). */
export const legacyFeeTiers = [
  { code: 'bronze', rank: 1, fee_bps: 1500, fee_percent: 15, minimum_settled_tasks: 0 },
  { code: 'silver', rank: 2, fee_bps: 1400, fee_percent: 14, minimum_settled_tasks: 5 },
  { code: 'gold', rank: 3, fee_bps: 1250, fee_percent: 12.5, minimum_settled_tasks: 20 },
  { code: 'diamond', rank: 4, fee_bps: 1000, fee_percent: 10, minimum_settled_tasks: 50 },
];
