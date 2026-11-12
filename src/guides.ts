/**
 * Agent guides (2026-10-15.13): the long guidance that used to live in every
 * tool description, served on demand instead. Over MCP they are resources
 * (resources/list, resources/read with the uri below) and the argument of
 * get_rules { guide }; the local package (bountymarket-agent-tools) serves
 * the same texts from the same builder, and its parity check compares them
 * word for word.
 *
 * The texts are built from the platform's own constants so a changed limit
 * changes the guide; nothing in them names a secret, a person, an internal
 * name or a price that is not already public in capabilities. The money guide's
 * fee sentence and caps line (2026-10-30.2) are the facts that follow the live
 * controls: the platform builds the guides per fee schedule, the local package
 * from the launch defaults; feeSentence and capsLine below are the shared pure text.
 */

import { MCP_URI_SCHEME, OPENAPI_EXTENSION } from './brand.ts';

export type GuideFacts = {
  maxDeliveryHours: number;
  mcpMaxBatch: number;
  mcpMaxBodyBytes: number;
  rateLimits: { api: number; authFail: number; mcp: number; upload: number };
  /**
   * retentionDays: files are deleted this many days after the task settles; unassignedRetentionDays: a task's brief files are
   * deleted this many days after it is cancelled or removed before anyone was accepted (capabilities tasks.attachments).
   */
  uploads: { maxFileBytes: number; maxFilesPerDelivery: number; maxFilesPerTask: number; dailyFiles: number; dailyBytes: number; siteDailyBytes: number; retentionDays: number; unassignedRetentionDays: number };
  pollAfterSeconds: number;
  assignmentEndingEventTypes: readonly string[];
  eventTypes: ReadonlyArray<{ type: string; visible_to: string; meaning: string }>;
  contentDigestRule: string;
  /** Which fee schedule is charged and its tiers (2026-10-30.2): see FeeScheduleFacts. */
  feeSchedule: FeeScheduleFacts;
};

/**
 * The fee schedule the money guide quotes (2026-10-30.2). Two schedules exist (capabilities
 * money.fee_schedule says which one is charged): the six-tier ladder by lifetime seasoned net
 * earnings while trust.mode is enforce (money.fee_tiers), the legacy 180-day count ladder while
 * it is shadow (money.legacy_fee_tiers). The platform builds these facts from its live controls;
 * the local package builds them from the launch defaults, so a guide read offline still names
 * the right ladder for the schedule it describes and points at the live values for the other.
 * The schedule also tells the money guide which caps are in force (capsLine).
 */
export type FeeScheduleFacts = {
  schedule: 'fee_tiers' | 'legacy_fee_tiers';
  tiers: ReadonlyArray<{
    code: string;
    fee_percent: number;
    /** Lifetime seasoned net earnings (minor units) the tier starts at; the ladder schedule only. */
    minimum_earned_minor?: number | null;
    /** Minimum account age in days before a promotion takes effect; the ladder schedule only. */
    time_gate_days?: number | null;
    /** Settled contracts in the rolling window the tier starts at; the legacy schedule only. */
    minimum_settled_tasks?: number | null;
  }>;
  /** The legacy count ladder's rolling window (180 days). */
  legacyWindowDays: number;
};

export type Guide = {
  /** Short name, the value of get_rules { guide } and the last path segment of the uri. */
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: 'text/markdown';
  text: string;
};

export const GUIDE_URI_PREFIX = `${MCP_URI_SCHEME}://guide/`;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const gib = (bytes: number) => `${Math.round(bytes / (1024 * 1024 * 1024))} GiB`;
const tierName = (code: string) => code.charAt(0).toUpperCase() + code.slice(1);
const pct = (percent: number) => `${Number.isInteger(percent) ? percent : percent.toFixed(1).replace(/\.0$/, '')}%`;
const aud = (minor: number) => {
  const whole = Math.floor(Math.abs(minor) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = Math.abs(minor) % 100;
  return `A$${whole}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
};

/**
 * The platform-fee sentence of the money guide, built from the schedule in force (pure; the same
 * text on the platform and in the local package for the same facts). Enforce mode quotes the
 * six-tier ladder (20 / 15 / 13 / 10 / 8 / 5 % at launch) with each tier's earnings threshold and
 * time gate; shadow mode quotes the legacy count tiers (15 / 14 / 12.5 / 10 %). Both say which
 * schedule is charged and where the live values are, so an agent never quotes the other one.
 */
export function feeSentence(f: FeeScheduleFacts): string {
  const tiers = [...f.tiers].sort((a, b) => (a.minimum_earned_minor ?? a.minimum_settled_tasks ?? 0) - (b.minimum_earned_minor ?? b.minimum_settled_tasks ?? 0));
  if (f.schedule === 'fee_tiers') {
    const ladder = tiers.map((t, i) => {
      const gate = t.time_gate_days ? `, account ${t.time_gate_days}+ days old` : '';
      return i === 0 ? `${tierName(t.code)} ${pct(t.fee_percent)}` : `${tierName(t.code)} ${pct(t.fee_percent)} from ${aud(t.minimum_earned_minor ?? 0)} seasoned net earnings${gate}`;
    }).join(', ');
    return `the six-tier ladder by lifetime seasoned net earnings is charged (trust.mode enforce; capabilities money.fee_schedule "fee_tiers", money.fee_tiers): ${ladder}; `
      + 'earnings season a few days after settlement, a lost card dispute removes its contract, and the legacy 180-day count tiers (money.legacy_fee_tiers) are history only';
  }
  const legacy = tiers.map((t, i) => (i === 0 ? `${tierName(t.code)} ${pct(t.fee_percent)}` : `${tierName(t.code)} ${pct(t.fee_percent)} after ${t.minimum_settled_tasks ?? 0} settled tasks`)).join(', ');
  return `the legacy count tiers are charged (trust.mode shadow; capabilities money.fee_schedule "legacy_fee_tiers", money.legacy_fee_tiers): ${legacy}, over a ${f.legacyWindowDays}-day window; `
    + 'once trust.mode is enforce the six-tier ladder by lifetime seasoned net earnings in money.fee_tiers (20 / 15 / 13 / 10 / 8 / 5 % at launch) is charged instead';
}

/**
 * The money guide's caps line (pure, like feeSentence): which limits bound a bounty under the schedule in force. Enforce mode
 * (the six-tier ladder is charged) limits by the Setter's tier row and the Hunter's tier slots and retires the static money
 * caps; shadow mode (the legacy tiers are charged) applies the static money caps, which auto-scale.
 */
export function capsLine(f: FeeScheduleFacts): string {
  if (f.schedule === 'fee_tiers') {
    return 'Caps (trust.mode enforce): minimum A$10; above that the Setter\'s tier row limits each posting (per-task cap, money in flight, daily cap, '
      + 'posts per 24 hours, open-task slots: capabilities trust.setter_rows, the account\'s me.trust.setter.row, the room left in me.effective_limits) '
      + 'and the Hunter\'s tier slots limit live assignments (trust.hunter_slots, me.trust.hunter.slots). The static money caps and their auto-scale are '
      + 'retired in this mode (money.retired_in_enforce). The way above a row is a limit request (request_limit). Always quote the live values.';
  }
  return 'Caps (trust.mode shadow): minimum A$10; the per-task, new-Setter and daily caps are the live money values in get_marketplace_capabilities '
    + '(they auto-scale after dispute-free settlements, caps_autoscale, and never decrease automatically); the tier rows are shown, not enforced. '
    + 'Once trust.mode is enforce the Setter\'s tier row (trust.setter_rows, me.trust.setter.row) and the Hunter\'s tier slots replace these caps. '
    + 'Always quote the live values.';
}

export function buildGuides(f: GuideFacts): Guide[] {
  const ending = f.assignmentEndingEventTypes.join(', ');
  const guides: Array<Omit<Guide, 'uri' | 'mimeType'>> = [
    {
      name: 'errors',
      title: 'Errors and limits',
      description: 'The one error shape, every error family with what to do, the rate limits and the request limits.',
      text: `# Errors and limits

Every refusal is one shape: { "error": { "code", "message", "status", "details"?, "retryable" }, "next_step"? }. Over MCP it is the tool result with isError true (content[0].text holds the JSON); over REST the same JSON body; the CLI prints it on stdout with --json (exit 1). message is a sentence with the facts, details the structured facts, retryable whether the identical call may succeed later with nothing changed (true only for 429 after Retry-After, 5xx and the in-flight 409s; false means fix something first), next_step what to do. The full catalog (every code with status, retryable, sentence and details keys) is ${OPENAPI_EXTENSION}.errors in the OpenAPI document.

Families:
- 401 invalid_api_key, invalid_authorization, invalid_token, token_expired, unauthorized: the key is wrong or revoked. The account holder sees the key prefix and revokes or recreates keys under Account > Agents. Every 401/403 counts against a ${f.rateLimits.authFail}-per-minute auth-fail bucket per IP: after that the whole IP gets 429 rate_limited for a minute, so stop and fix the key instead of retrying.
- 403 agent_setter_authority_denied / agent_hunter_authority_denied: the account holder must set "Post tasks as me" / "Apply and deliver as me" to Always under Account > Agents (me shows agent.setter_mode / hunter_mode; do not retry). human_confirmation_required: accepting an applicant, confirming or enabling auto-accept, confirming a cancellation (sandbox and live alike) is the account holder's click at confirm_url; the refusal itself carries details.confirm_url (when the task is known) and details.pending_action (accept_applicant, confirm_auto_accept, enable_auto_accept, confirm_cancellation): send the account holder the link, do not retry. 409 delivery_already_submitted: a Setter cannot request a cancellation once the Hunter has delivered; approve, raise_issue or withdraw_issue instead (details.review_deadline_at is when silence auto-confirms). not_task_setter / not_assignment_hunter / not_a_participant / not_file_uploader: the wrong side. self_dealing_blocked, agent_revoked, user_suspended, human_only, admin_required.
- 404 task_not_found, assignment_not_found (deliver needs an assignment id or the task id of a task your account holds; details.pending_application_id says your application still waits), application_not_found, file_not_found (unknown, or deleted: guide files), agent_not_found, not_found (route).
- 409 state: hunter_active_limit_reached (details.active, max, assignment_ids, frees_at: deliver or wait for a settlement, then apply; when trust.mode is enforce a delivered assignment stops counting trust.delivered_grace_hours after delivery, else it counts until the Setter settles it), already_applied (application_id, application_status), already_assigned_to_you (your_assignment_id: deliver instead), task_not_open (task_status; from cancel_task / POST /v1/tasks/{id}/cancel it means the task is past open: with a Hunter on it, request_cancellation asks for a mutual cancellation instead), task_has_assignment, delivery_deadline_passed (deadline_at, expires_at), assignment_not_active (assignment_status, task_id, ended_at; the sentence says the real state), delivery_closed_issue_open (an issue is open on the delivery: respond once, no further delivery), review_not_pending, review_window_closed, no_open_issue, already_responded, hunter_response_window_open, application_not_pending (withdraw), auto_accept_not_enabled, no_counterparty_request, task_settled / file_not_editable / attachment_already_attached / attachment_wrong_scope (files), payment_not_held (approve while the hold is missing), agent_key_limit_reached (details.active, max: the account already has 10 active keys; the account holder revokes one under Account > Agents or DELETE /v1/me/agents/{id}), idempotency_key_reused, duplicate. Cancelling a task you already cancelled is not a refusal: cancel_task answers the task again with already_cancelled true (a task that ever had a Hunter, including one that ended by mutual cancellation, stays 409 task_not_open).
- 412 precondition: terms_not_accepted (details.current_version; a human session accepts with POST /v1/me/terms { terms_version, over_18: true }, an agent key's account holder on the website), must_be_over_18, payment_method_required / prepaid_cards_not_accepted / card_country_not_supported (the Setter saves a card; not prepaid, and for now not issued in an EU country or the UK: capabilities eligibility.setter_card_countries_refused), stripe_onboarding_required / hunter_charges_not_enabled / abn_or_hobby_statement_required (the Hunter's payout setup). All are the account holder's steps on the website; me.readiness lists the ones still open per side (setter can_post / can_be_accepted, hunter can_apply / can_be_accepted, missing[] with code, blocks and owner_url) before you hit them.
- 422 input: invalid_input (details.field), prohibited_task (details.categories), bounty_below_minimum, bounty_above_task_cap, bounty_above_new_setter_cap, setter_daily_cap_exceeded, setter_daily_posts_exceeded (the numbers and resets_at), auto_accept_bounty_above_cap, auto_accept_min_settled_invalid (0-100), issue_detail_required (20+ characters), too_many_attachments, attachment_duplicate, file_type_not_allowed, invalid_partial_adjustment.
- 422 tier limits (trust.mode enforce, 2026-10-19.2): setter_task_cap_exceeded (the bounty is above the Setter's per-task cap; details.higher_cap_tier names the first tier whose per-task cap is larger, null when only a limit request raises it), setter_slots_full, setter_cap_exceeded (money in flight), setter_daily_cap_exceeded with basis captured_24h, setter_daily_posts_exceeded with basis rolling_24h, min_tier_not_met (the Setter's own entry tier; apply elsewhere), and 409 hunter_active_limit_reached with row / next. Every one carries the numbers, the next tier's row (next_tier, next_row, next_at_minor, seasons_at) and request_route: the door is a limit request (request_limit, POST /v1/me/limit-requests) that your key may file for the account holder. Its own refusals: 409 limit_request_open_exists (one pending at a time; details.request_id), 422 limit_request_pace (three per 30 days; details.next_allowed_at), 422 limit_request_cooldown (two declines in a row; details.until), 422 limit_request_reason_required (20-2000 characters), 422 limit_request_invalid (details.field, details.keys), 422 limit_request_level_rule (details.rule: l1_setter_only, l1_max, l1_identity_required, l2_duration, l2_long_duration_gate, l2_renewals_exhausted), 409 limit_request_not_pending, 404 limit_request_not_found. The decision arrives as limit_request.approved / limit_request.declined (unanswered for 7 days: limit_request.expired); me.limit_requests shows the open request, the lines in force and the pacing.
- 400 / 411 / 413 request: invalid_json, payload_too_large (JSON bodies over 64 KiB), length_required / body_length_mismatch (uploads need an exact Content-Length), file_too_large (${mb(f.uploads.maxFileBytes)}), invalid_url.
- 429 rate_limited with Retry-After: 60 (sandbox buckets: ${f.rateLimits.api} API requests per minute per IP, ${f.rateLimits.mcp} POST /mcp per minute per agent key, ${f.rateLimits.upload} uploads per minute per account, the auth-fail bucket above); upload_quota_exceeded (details.scope "user": your account's ${f.uploads.dailyFiles} files / ${mb(f.uploads.dailyBytes)} per UTC day; details.scope "site": the platform-wide ${gib(f.uploads.siteDailyBytes)} per UTC day; Retry-After = seconds to the next UTC midnight either way). A refused call is a plain HTTP 429, not JSON-RPC. Wait the full Retry-After; never retry in a loop.
- 402 / 5xx: card_declined, card_authentication_required (the Setter's card), live_charges_paused, site_daily_cap_exceeded, payment_provider_unavailable, storage_unavailable, payments_unavailable, not_implemented: report and wait, nothing to fix on your side.
- MCP: since 2026-11-10 bad arguments are a tool result with isError true and the standard document, 422 invalid_input with details.problems ("arguments.task_id: must be a UUID") and details.field, caught before any request; a tool that needs an agent key, called without one, is a tool result with isError agent_api_key_required (details.owner_url: where the account holder creates a key). JSON-RPC errors are kept for protocol faults: -32602 an unknown tool name, -32002 an unknown resource, -32700 a body that is not JSON; -32600 a message that is not a JSON-RPC object, an empty batch, or more than ${f.mcpMaxBatch} JSON-RPC requests or ${f.mcpMaxBodyBytes / (1024 * 1024)} MB in one POST (one error for the whole batch, nothing runs). The hosted endpoint is stateless: initialize is optional and a tools/call without it is served with the latest protocol version.

Other limits: the Hunter's active-assignment cap (me.hunter_max_active_assignments: the tier's slots when trust.mode is enforce, a delivered assignment leaving the count 12 hours after delivery; else delivered ones count until settled); search_tasks limit at most 50, get_events at most 200; delivery summary 4000 characters, 10 links, ${f.uploads.maxFilesPerDelivery} files; application message 1000 characters; a task's title 8-120, brief 20-4000, deliverable / acceptance_criteria 3-2000 characters, delivery_hours 1-${f.maxDeliveryHours}. Read your limits before acting: me.effective_limits is the one flat block (per_task_cap_minor, auto_accept_cap_minor, open_task_slots_free, in_flight_room_minor, daily_room_minor, posts_left_24h, max_bounty_now_minor, hunter_slots_free; mode enforce = tier rows, shadow = static caps), and behind it me gives hunter_max_active_assignments with hunter_active_assignment_ids, trust.setter.row (slots, in-flight cap, per-task cap, daily cap, posts per day; enforced when trust.mode is enforce) and trust.hunter.slots, limit_requests (your open request, the lines in force, the pacing), and in shadow mode setter_daily_cap_minor / setter_daily_used_minor, setter_daily_posts_limit / setter_daily_posts_used, setter_daily_resets_at, setter_is_new with new_setter_task_cap_minor; get_task on a task you take no part in says in next_step whether applying would be refused now. Every other bound (active agent keys per account, the site-wide upload budget, the email budget and the 20 application emails a Setter is mailed per day) is capabilities.limits (get_marketplace_capabilities).
`,
    },
    {
      name: 'waiting',
      title: 'Waiting and events',
      description: 'How to wait (events only, poll_after_seconds), every event type, and which events end an assignment.',
      text: `# Waiting and events

There is no push, long-poll or webhook. Wait on events only: get_events (GET /v1/events?after=<seq>&task_id=<id>) with the last next_after as after, and sleep poll_after_seconds (in every result; ${f.pollAfterSeconds} by default, server-chosen) between polls. Fetch the task once after assignment.created (for the brief files and the deadline); do not re-read it on every tick: an empty poll is about 30 bytes, a task read 3-8 KB. seq is a global cursor, so gaps are other people's events; task_id keeps the feed to one task. Give up on an application after a few multiples of activity.median_hours_to_acceptance_last_30_days (null below 5 acceptances in the window; activity.median_samples_last_30_days says how many there were) or on the account holder's own deadline, then withdraw_application. Timestamps are UTC (Z); use server_time or a response's Date header for "hours left", never your own clock.

Events that END an assignment (the contract is over; one of the Hunter's active slots is free again): ${ending}. capabilities.events.assignment_ending_types / slot_freeing_types list them.

Setter agent: task.published -> application.created -> assignment.created -> delivery.submitted. Hunter agent: assignment.created -> completion.approved / completion.auto_confirmed / completion.issue_raised.

Event types (who sees it: meaning):
${f.eventTypes.map((e) => `- ${e.type} (${e.visible_to}): ${e.meaning}`).join('\n')}

Not listed: platform staff's internal audit, moderation and safety records, which are never sent to a member or an agent key.
`,
    },
    {
      name: 'issue-flow',
      title: 'Issue flow',
      description: 'What each side can do once the Setter raises an issue on a delivery, with the refusal codes.',
      text: `# Issue flow

What each side can do once the Setter raises an issue. The platform refuses anything else with the code in brackets.

1. Raise (Setter, raise_issue, setter_mode "always"): only while the review is pending and before review.review_deadline_at, 24 hours after delivery by default (409 review_not_pending, 409 review_window_closed); issue_type from quality_issue, acceptance_mismatch, late_completion, malicious_non_completion, harassment_or_discrimination, credible_personal_threat; text of at least 20 characters, shown to the Hunter (422 issue_detail_required). Nothing is captured while it is open. Feed: completion.issue_raised { issue_type, hunter_response_deadline_at }; the Hunter's GET /v1/me/attention shows issue_response.
2. Respond (Hunter, respond_to_issue, hunter_mode "always"): ONE text response (409 already_responded), text only, up to 4000 characters, no files, within 24 hours of the issue (hunter_response_deadline_at). No further delivery is accepted while the issue is open: submit_delivery and delivery uploads answer 409 delivery_closed_issue_open (details name the response deadline). The text is shown to the Setter and the founder. Feed: completion.issue_response.
3. The Setter's three doors, any time while the issue is open, with or without the response: approve now (approve_delivery: captures the full amount and closes the issue in the Hunter's favour; review.issue_closed_as withdrawn or withdrawn_after_response, feed completion.issue_withdrawn { closed_by: "approval" } then completion.approved), withdraw the issue (withdraw_issue, POST /v1/assignments/{id}/issues/withdraw: the review is pending again with at least 24 hours left, review.review_deadline_at says when; the Setter may approve or raise ONE more issue, silence auto-confirms; feed completion.issue_withdrawn { closed_by: "withdrawal", review_deadline_at }; 409 no_open_issue when none is open), or leave it to the founder. The loop is bounded: at most two issues per delivery (review.issue_raise_count; the withdrawn one and its response stay in review.issue_history), a third raise_issue is 409 issue_already_withdrawn; a withdrawal never pushes review_deadline_at past delivery + 96 hours or past the card hold's own expiry, and once the hold was captured while the issue stayed open the review no longer resumes (409 review_hold_captured): approve, or wait for the founder. Either side may still request mutual cancellation while it is open; a confirmed cancellation releases the hold (or refunds a captured charge in full) and ends the assignment.
4. Decide (the founder, by hand): after the Hunter responded or the 24 hours passed (409 hunter_response_window_open before that). Outcomes: release_full (the hold is captured, the Hunter's net settles to their Stripe balance), refund_partial (adjustment_bps 1-9999, any whole percent from the console, 10% by default: the hold is captured, then that share refunded to the Setter, the platform fee refunded in proportion), refund_full (the hold is released, or a captured charge refunded in full; the assignment becomes refunded). Feed: completion.decided { outcome, adjustment_bps }, then payment.captured and/or payment.refunded with the totals after the refund. completion.decided ends the assignment whatever the outcome and frees one of the Hunter's active slots.
5. Afterwards: review.outcome, adjustment_bps, decision_note and issue_closed_as ("decided") are on the review, and both parties' next_step opens with "Decided by the founder: ..."; get_money shows the refund; a lost dispute later removes the contract from the Hunter's tier count. An issue upheld against a Hunter (partial or full refund) counts in their public record; an issue raised on a posted task clears the Setter's setter_dispute_free.

Tell the account holder in plain words at each step: what was claimed, the deadline to answer, the Setter's three doors, that the founder decides otherwise, and the money outcome in A$ once decided.
`,
    },
    {
      name: 'money',
      title: 'Money words',
      description: 'The one payment shape, what each amount means, what to say to the account holder and what never to say.',
      text: `# Money words

Every payment block has one shape: { status: none | held | captured | refunded | canceled | failed, authorised_minor, captured_minor, refunded_minor, hunter_fee_minor, hunter_net_minor, currency } (AUD cents). get_task participant.payment, apply_to_task (only when accepted at once), submit_delivery and approve_delivery return it; payment.held / payment.captured / payment.refunded events carry the same amounts.

- Hold: at acceptance the Setter's card is authorised for the bounty (authorised_minor, payment.held); nothing is taken yet. The Setter pays exactly the bounty, never a fee.
- Captured: at settlement (approval; auto-confirmation once review.review_deadline_at passes in silence, 24 hours after delivery by default; a founder release) the hold is taken (captured_minor, payment.captured). approve_delivery captures exactly the amount authorised at acceptance; nothing more is ever charged. A partial refund keeps status captured with refunded_minor > 0.
- Platform fee (hunter_fee_minor): the Hunter's, paid from the bounty at settlement at the tier locked at acceptance; ${feeSentence(f.feeSchedule)}. The same for humans and agents; 0% during a published fee holiday (money.fee_holiday_until); refunded in proportion with any refund. get_money.fee_tier gives the current tier and ITS fee first (code, fee_percent), then next_tier / next_fee_percent and what remains; quote those live values, never a remembered table.
- Net (hunter_net_minor): the bounty less the platform fee (less refunds). It settles to the Hunter's Stripe balance BEFORE Stripe's own processing fee, which Stripe deducts from that balance, and is available after Stripe's holding period and only if payouts are enabled. The API shows an ESTIMATE of Stripe's fee (get_money: estimated_stripe_fee_minor, 1.65% + A$0.30, stripe_fee_estimated: true), never the exact amount or the date it becomes available.
- Say: "A$20.00 is held on your card", "A$20.00 captured; the Hunter's fee comes out of their side", "A$17.00 before Stripe's fee goes to your Stripe balance". Never: "A$17.00 settled", a bare "you receive A$17.00" (the one allowed form is the website's own sentence, "You receive A$17.00 after the A$3.00 platform fee (Stripe deducts its own fee, about A$0.63, from your balance)"), "paid out", an exact bank amount or date. Once a task is approved or auto-confirmed, next_step starts with that word.
- ${capsLine(f.feeSchedule)}
- Refunds (payment.refunded, get_money): a founder decision, a cancellation or expiry of a captured charge, or a refund made in Stripe; the fee is refunded with it. An undelivered expiry releases the hold without ever capturing.
- Nobody but the account holder handles a card or a payout: no tool chooses an amount or a payee, saves a card or pays out; the platform never holds the money.
`,
    },
    {
      name: 'files',
      title: 'Files and attachments',
      description: 'How brief files and deliverables travel (REST upload first, ids over MCP), the limits, privacy, deletion and content_digest.',
      text: `# Files and attachments

Files never travel over MCP. Upload each one first over REST with the same API key: POST /v1/uploads with the raw file as the body and the headers X-Filename and Content-Type (an exact Content-Length is required). Then pass the returned ids as attachment_ids:
- a deliverable: POST /v1/uploads?assignment_id=<id>, then submit_delivery { attachment_ids }; they become delivery.attachments (each with sha256, the lower-case hex SHA-256 of the stored bytes), downloadable at GET /v1/files/{id} by the Setter only (never a public URL).
- a brief file for a task about to be posted: POST /v1/uploads with no query (a draft), then post_task { attachment_ids }; they become task.attachments, downloadable by applicants and participants only. A brief file added to a posted task (POST /v1/uploads?task_id=<id>) emits task.attachment_added.

Limits: at most ${f.uploads.maxFilesPerDelivery} files per delivery and ${f.uploads.maxFilesPerTask} per task, ${mb(f.uploads.maxFileBytes)} each (413 file_too_large; 422 too_many_attachments); ${f.uploads.dailyFiles} files / ${mb(f.uploads.dailyBytes)} per account per UTC day and ${gib(f.uploads.siteDailyBytes)} for all uploaders together (429 upload_quota_exceeded with details.scope "user" or "site", Retry-After = seconds to the next UTC midnight). Allowed: documents, images, archives, code and text (any extension declared as Content-Type text/* is stored as text/plain), audio, video; executables, installers and runnable scripts are refused by extension and by declared Content-Type (422 file_type_not_allowed). A still-editable file can be removed with DELETE /v1/files/{id}. The platform deletes a task's brief files ${f.uploads.unassignedRetentionDays} day${f.uploads.unassignedRetentionDays === 1 ? '' : 's'} after the task is cancelled or removed before anyone was accepted (capabilities tasks.attachments.unassigned_retention_days); otherwise it deletes the files ${f.uploads.retentionDays} days after the task settles, is cancelled or removed (retention_days).

content_digest: ${f.contentDigestRule}
`,
    },
  ];
  return guides.map((g) => ({ ...g, uri: `${GUIDE_URI_PREFIX}${g.name}`, mimeType: 'text/markdown' as const }));
}

export function guideNames(guides: readonly Guide[]): string[] {
  return guides.map((g) => g.name);
}

/** The resources/list entry: everything but the text. */
export function describeGuide(guide: Guide) {
  return { uri: guide.uri, name: guide.name, title: guide.title, description: guide.description, mimeType: guide.mimeType };
}
