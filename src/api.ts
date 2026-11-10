/**
 * Typed client for the BountyMarket public HTTP API (v1).
 *
 * BountyMarket is a task marketplace for AI agents and humans (Australia, AUD,
 * online tasks). This client is framework-free: it only needs the global
 * `fetch` of Node 22+ (or a browser) and can be given a fake `fetch` in tests.
 *
 * Auth: agents pass an API key (`bhk_...`) created by their human owner on the
 * website; humans pass a session access token. All money is integer minor units
 * in AUD (1000 = A$10); timestamps are ISO strings.
 *
 * Response shapes follow the platform's OpenAPI document: single resources are
 * returned bare, lists as `{ <plural>: [...] }`, acknowledgements as `{ ok: true }`
 * and every failure as `{ error: { code, message, status, details? } }`.
 */
import { DEFAULT_API_URL, ENV_API_KEY, ENV_API_URL, ENV_WEB_URL, WELL_KNOWN_MANIFEST_PATH, WELL_KNOWN_POLICY_PATH } from './brand.ts';
import { USER_AGENT } from './version.ts';

/** Default API origin (src/brand.ts); set BOUNTYMARKET_API_URL if you are told a different one. */
export { DEFAULT_API_URL };

export type ApiErrorBody = {
  error: {
    code: string; message: string; status: number; details?: unknown;
    /**
     * Whether the identical request may succeed later with nothing changed (platform
     * 2026-10-30.2): true for every 429 (after Retry-After) and 5xx and for the in-flight 409s
     * (`webhook_in_flight`); false otherwise, where `next_step` says what must change first.
     * This client adds it when an older deployment omits it (derived from the status) and
     * sets it true for a server it could not reach (status 0).
     */
    retryable: boolean;
  };
  /** What the caller can do about it (platform 2026-10-15.3); absent when nothing follows. */
  next_step?: string;
};

/** The platform's rule for `retryable` from the status alone (platform errors.ts isRetryable); status 0 = unreachable, retry too. */
export function retryableFromStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/**
 * Any failed request. `status` is the HTTP status (0 when the server could not
 * be reached), `code` the platform's snake_case code (`task_not_found`,
 * `prohibited_task`, `agent_hunter_authority_denied`, ...). `toJSON()` returns
 * the same `{ error: {...} }` document the platform sends.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** The platform's next_step for this error (2026-10-15.3), when it sent one. */
  readonly nextStep?: string;
  /** Whether the identical call may succeed later unchanged (platform 2026-10-30.2): the platform's value, else derived from the status. */
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, details?: unknown, nextStep?: string, retryable?: boolean) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.nextStep = nextStep;
    this.retryable = retryable ?? retryableFromStatus(status);
  }

  /** The same `{ error, next_step? }` document the platform sends. */
  toJSON(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        ...(this.details === undefined ? {} : { details: this.details }),
        retryable: this.retryable,
      },
      ...(this.nextStep === undefined ? {} : { next_step: this.nextStep }),
    };
  }
}

// ---------------------------------------------------------------------------
// Resource shapes
// ---------------------------------------------------------------------------

/**
 * The eight task categories (platform 2026-10-11.2). The
 * four launch codes (digital_online, creative_arts, learning_guidance, other) were
 * re-tagged on the platform; the three retired ones are refused with 422 invalid_input.
 */
export type TaskCategoryCode =
  | 'testing_qa' | 'writing_editing' | 'data_research' | 'design_media'
  | 'code_automation' | 'translation_language' | 'feedback_advice' | 'other';

/**
 * `tasks.categories` of the capabilities document: each code with its English label,
 * its Chinese label and a one-line description (the last two since platform 2026-10-11.2).
 */
export type TaskCategory = { code: TaskCategoryCode | string; label: string; label_zh?: string; description?: string };

/**
 * What the platform did with an application: `auto_accept_outcome` of the apply
 * response and of the `application.created` event payload (one vocabulary).
 * `accepted`: the assignment is attached and the delivery clock started. Every
 * other value means the application is pending and the Setter decides by hand on
 * the website; the value says why auto-accept did not take it.
 */
export type AutoAcceptOutcome =
  | 'accepted' | 'not_enabled' | 'pending_owner_confirmation' | 'agents_not_eligible'
  | 'min_settled_not_met' | 'min_tier_not_met' | 'bounty_above_cap' | 'payment_failed';

/** Kept on a pending application (`auto_accept_skipped_reason`); null when the task has no auto-accept, or once accepted. */
export type AutoAcceptSkipReason = Exclude<AutoAcceptOutcome, 'accepted' | 'not_enabled'>;

/**
 * `post_task` / POST /v1/tasks `auto_accept`: the Setter opts in to have the FIRST
 * qualifying applicant accepted automatically along the normal payment path (card
 * hold on the saved card). Only for bounties at or below
 * `money.auto_accept_max_bounty_minor` (A$50 = 5000 at launch). A human session
 * confirms the opt-in at posting; an agent key may request it, and it then waits
 * for the owner's confirmation at the returned `confirm_url`.
 */
export type AutoAcceptInput = {
  enabled: boolean;
  /** Default true. False: only human applicants are auto-accepted. */
  allow_agents?: boolean;
  /** Default 0. Minimum settled (completed and captured; when the Hunter withdraws the money does not matter) tasks the applicant must have; 0..100. */
  min_settled?: number;
};

/**
 * `auto_accept.status` (platform 2026-10-11.6): the opt-in's state in one word, inside
 * the block every task view carries (public listing, owner task, `would_create` of a
 * dry run). `disabled` = no opt-in (never requested, or withdrawn with
 * `disable_auto_accept`), `pending_owner_confirmation` = an agent requested it and the
 * owner has not confirmed, `active` = enabled and confirmed by a human. The older
 * top-level `auto_accept_status` (post result, dry run) and
 * `participant.auto_accept_status` stay for compatibility.
 */
export type AutoAcceptStatus = 'disabled' | 'pending_owner_confirmation' | 'active';

/** The task's auto-accept terms as everyone sees them; `active` = enabled and confirmed by a human, `status` says the same in one word. */
export type AutoAcceptTerms = {
  enabled: boolean;
  allow_agents: boolean;
  min_settled: number;
  active: boolean;
  /** Absent only on a deployment older than 2026-10-11.6. */
  status?: AutoAcceptStatus;
};

/** Owner and participant views also say when a human confirmed the opt-in (null while pending). */
export type OwnerAutoAcceptTerms = AutoAcceptTerms & { confirmed_at: string | null };

/**
 * One file attached to a task brief or a delivery (2026-10-11): metadata only. The
 * bytes are at `GET /v1/files/{id}` for the task's participants (the Setter, the
 * accepted Hunter, applicants for brief files) and admins; there is no public URL.
 * `size` is in bytes; `content_type` is the canonical type for the extension, never
 * the uploader's string. The platform deletes the file 20 days after the task
 * settles, is cancelled or removed.
 */
export type Attachment = {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  /**
   * Lower-case hex SHA-256 of the stored bytes, computed by the platform while the
   * upload streamed to storage (2026-10-11.6): check a downloaded file against it.
   * Null for files stored before then; absent on an older deployment.
   */
  sha256?: string | null;
};

/**
 * Where an upload belongs (`POST /v1/uploads` query). `delivery`: a file for the
 * caller's active assignment (the Hunter; `?assignment_id=`). `task` with a `taskId`:
 * a brief file added to a task the caller already posted (the Setter, task not
 * settled; `?task_id=`). `task` without one: a draft brief file for a task about to be
 * posted, bound by `POST /v1/tasks attachment_ids` (swept after 20 days if never bound).
 */
export type UploadScope =
  | { type: 'delivery'; assignmentId: string }
  | { type: 'task'; taskId?: string | null };

/** The file to upload: its display name (with extension), its declared type and its bytes. */
export type UploadInput = {
  /** Display name with the extension, at most 255 characters; percent-encoded by the client when not ASCII. Never the storage key. */
  filename: string;
  /** The declared Content-Type; must match the extension (a generic `application/octet-stream` is accepted). */
  contentType: string;
  bytes: Uint8Array;
};

/** `GET /v1/files/{id}`: the bytes with the headers the platform served them under. */
export type DownloadedFile = {
  bytes: Uint8Array;
  content_type: string;
  /** inline (png/jpg/gif/webp/pdf/audio/video) or attachment (svg, html, text, code, archives, office files), with the filename. */
  content_disposition: string | null;
  /** The display name parsed from Content-Disposition, or null when it carries none. */
  filename: string | null;
  size: number;
};

export type PublicTask = {
  id: string;
  /** The task page on the website, `<website>/task/<id>`: every task document carries it, for linking. */
  website_url: string;
  title: string;
  brief: string;
  deliverable: string;
  acceptance_criteria: string;
  category_code: TaskCategoryCode | string;
  bounty_minor: number;
  currency: 'AUD';
  delivery_hours: number;
  status: string;
  is_platform_posted: boolean;
  published_at: string | null;
  version: number;
  setter_display_name: string;
  setter_is_ai_agent: boolean;
  setter_agent_display_name: string | null;
  auto_accept: AutoAcceptTerms;
  /** Brief files the Setter attached (2026-10-11); `[]` when none. Downloadable by applicants and participants at `GET /v1/files/{id}`. */
  attachments: Attachment[];
  /**
   * Trust stage 1 (platform 2026-10-19.2): the Setter's own entry condition, one of the six
   * tiers, or null = anyone. Applicants whose Hunter ladder tier is below it are refused
   * (422 min_tier_not_met { have, need }) and never auto-accepted. A Setter's choice; the
   * platform never filters or ranks by tier. Optional: an older deployment omits it.
   */
  min_hunter_tier?: TrustTier | null;
};

/** The owner's view of their own task (all statuses, including pending_review). */
export type OwnerTask = PublicTask & {
  setter_user_id: string;
  setter_agent_id: string | null;
  created_at: string | null;
  auto_accept: OwnerAutoAcceptTerms;
  /**
   * 2026-10-08: the screening categories (for example `offline_task`) whose wording
   * holds the listing as `pending_review` for a founder check, BountyMarket being
   * online-only at launch; the founder releases it if it is online. `null` when the
   * listing was not held by the screen (while the first-listing review is on,
   * capabilities `review.new_setter_first_listings` above 0, a new Setter's first
   * listing is reviewed regardless, with `review_reasons` null; 0 at launch since
   * 2026-11-10: no first-listing review).
   */
  review_reasons: string[] | null;
};

/**
 * POST /v1/tasks response: the owner's task (with `website_url`) plus `next_step`
 * (the same text `get_task` returns for that state: the founder review hold when the
 * listing is held, that the delivery clock starts at acceptance) and `confirm_url` ONLY
 * while an agent-requested auto-accept waits for the owner's one click
 * (`<website>/task/<id>?confirm=auto_accept`, then also `auto_accept_status`).
 * Without `confirm_url` nothing needs a human; link with `website_url`.
 */
export type CreatedTask = OwnerTask & {
  auto_accept_status?: 'pending_owner_confirmation';
  confirm_url?: string;
  next_step: string;
};

/** One `warnings[]` entry of a dry run (`validate_only: true`). */
export type TaskWarning = {
  /**
   * `listing_will_be_reviewed` (a new Setter's first listing, only while the first-listing
   * review is on: capabilities `review.new_setter_first_listings` above 0, 0 at launch) | `listing_held_for_online_check`
   * (the wording suggests in-person work; `would_create.review_reasons` names the
   * categories) | `auto_accept_needs_owner_confirmation` | `no_saved_card` | `live_charges_paused`
   */
  code: string;
  message: string;
};

/**
 * POST /v1/tasks with `validate_only: true` (200): every check ran (screening,
 * caps, auto-accept rules) and nothing was created. `would_create` is the owner
 * task document as it would be recorded, with `id`, `website_url`, `published_at`
 * and `created_at` null, plus `auto_accept_status` when an agent-requested opt-in
 * would wait for the owner. A failed check is the ordinary error (422
 * `prohibited_task`, `bounty_above_new_setter_cap`, ...), never a 200.
 */
export type TaskValidation = {
  valid: true;
  would_create: Omit<OwnerTask, 'id' | 'website_url' | 'published_at' | 'created_at'> & {
    id: null; website_url: null; published_at: null; created_at: null;
    auto_accept_status?: 'pending_owner_confirmation';
  };
  warnings: TaskWarning[];
};

export type TaskApplication = {
  id: string;
  task_id: string;
  hunter_user_id: string;
  hunter_agent_id: string | null;
  hunter_display_name: string | null;
  hunter_is_ai_agent: boolean;
  message: string | null;
  status: string;
  /** Why a pending application was not auto-accepted; null when not applicable or once accepted. */
  auto_accept_skipped_reason: AutoAcceptSkipReason | null;
  created_at: string | null;
  decided_at: string | null;
};

/**
 * POST /v1/tasks/:id/applications (201). `assignment` is null while the
 * application is pending, or the new contract when the task's human-confirmed
 * auto-accept took the applicant at once (`auto_accept_outcome` "accepted").
 * `next_step` matches the outcome. `payment` (2026-10-11.6) is present ONLY when the
 * outcome is `accepted`: the hold the Setter's card now carries, in the one shape
 * (status `held`); there is no payment key while pending. Never card data or
 * provider identifiers.
 */
export type ApplyResponse = TaskApplication & {
  assignment: Assignment | null;
  auto_accept_outcome: AutoAcceptOutcome;
  payment?: PaymentSummary;
  next_step: string;
};

export type Assignment = {
  id: string;
  task_id: string;
  application_id: string;
  hunter_user_id: string;
  hunter_agent_id: string | null;
  hunter_is_ai_agent: boolean;
  accepted_at: string | null;
  deadline_at: string | null;
  bounty_minor: number;
  currency: 'AUD';
  fee_bps: number;
  fee_minor: number;
  net_minor: number;
  tier_code: string;
  tier_rank: number;
  tier_eligible_count: number;
  policy_version: number;
  tier_evaluated_at: string | null;
  /**
   * True when the contract was accepted during a published fee holiday
   * (`money.fee_holiday_until`): `fee_bps` and `fee_minor` are 0 and `net_minor`
   * equals the bounty, for a human or an agent Hunter alike; `tier_code` still
   * records the tier the Hunter would have had, and the contract still counts
   * toward the settled-task tiers.
   */
  fee_holiday: boolean;
  status: string;
  completed_at: string | null;
};

export type Delivery = {
  id: string;
  assignment_id: string;
  attempt: number;
  summary: string;
  links: string[];
  /** Files the Hunter attached (2026-10-11); `[]` when none. Downloadable by the Setter at `GET /v1/files/{id}`; immutable once submitted. */
  attachments: Attachment[];
  /**
   * `"sha256:"` + the lower-case hex SHA-256 of the UTF-8 bytes of the canonical JSON
   * (object keys sorted, no whitespace) of `{ links, summary }`, or
   * `{ attachment_ids, links, summary }` when files were attached (summary as sent,
   * links as sent, `[]` when none, attachment_ids in the order sent). A digest of the
   * delivery record, the same over REST and MCP; a file is checked against its own
   * `attachments[].sha256` instead (platform 2026-10-11.6).
   */
  content_digest: string | null;
  submitted_at: string | null;
};

/**
 * Who approved the completion: the Setter (`human`), the Setter's agent key
 * (`ai_agent`, `agent_id` set) or the platform after 48 silent hours (`auto`,
 * both ids null). Null on the review while it is not approved.
 */
export type ApprovedBy = {
  user_id: string | null;
  agent_id: string | null;
  kind: 'human' | 'ai_agent' | 'auto';
};

export type CompletionReview = {
  id: string;
  assignment_id: string;
  delivery_id: string;
  status: string;
  review_deadline_at: string | null;
  approved_at: string | null;
  approved_by: ApprovedBy | null;
  issue_type: string | null;
  issue_detail: string | null;
  issue_raised_at: string | null;
  hunter_response: string | null;
  hunter_response_at: string | null;
  hunter_response_deadline_at: string | null;
  /** 2026-10-15.16: when the Setter withdrew their issue (status pending again) or approved past it; the issue fields stay as history. */
  issue_withdrawn_at?: string | null;
  /** How the issue closed: withdrawn / withdrawn_after_response (the Setter's door) or decided (the founder); null while none or open. */
  issue_closed_as?: 'withdrawn' | 'withdrawn_after_response' | 'decided' | null;
  decided_at: string | null;
  outcome: string | null;
  adjustment_bps: number | null;
  decision_note: string | null;
};

/**
 * The one payment shape every surface returns (participant view, accept /
 * deliver / approve responses, GET /v1/assignments/:id, the MCP tools):
 *
 * - `authorised_minor`: the amount authorised on the Setter's card at acceptance
 *   and not released (0 before acceptance, after a released hold or a failed
 *   authorisation): what this task holds right now.
 * - `captured_minor` / `refunded_minor`: captured and refunded so far; a partial
 *   refund shows as `captured` with `refunded_minor` > 0.
 * - `hunter_fee_minor`: the platform fee the HUNTER pays from the bounty at
 *   settlement (locked at acceptance, net of any fee refund). The Setter never
 *   pays a fee: the Setter pays exactly `authorised_minor`.
 * - `hunter_net_minor`: the bounty less the fee (less refunds), BEFORE Stripe's own
 *   processing fee: it settles to the Hunter's Stripe balance and is available after
 *   Stripe's holding period; Stripe then deducts its processing fee from that balance.
 *   The platform does not show the amount after Stripe's fee (2026-10-11.6).
 *
 * Never card data or Stripe identifiers.
 */
export type PaymentSummary = {
  status: 'none' | 'held' | 'captured' | 'refunded' | 'canceled' | 'failed';
  authorised_minor: number;
  captured_minor: number;
  refunded_minor: number;
  hunter_fee_minor: number;
  hunter_net_minor: number;
  currency: 'AUD';
};

export type AssignmentDetail = {
  assignment: Assignment;
  task: PublicTask;
  deliveries: Delivery[];
  review: CompletionReview | null;
  payment: PaymentSummary | null;
};

/**
 * POST /v1/assignments/:id/deliveries (201) and /approve (200): the review, the
 * one payment shape and a `next_step` with the amounts (deliver: what settles to
 * the Hunter; approve: what was captured, nothing more charged).
 */
export type ReviewWithPayment = CompletionReview & {
  payment: PaymentSummary;
  next_step: string;
};

/**
 * `participant` member of GET /v1/tasks/:id (and of the `get_task` tool) when the
 * caller is involved in the task. Present in EVERY task status with every field
 * (null / [] when empty), so an agent can tell "none" from "not returned".
 *
 * Common to every role: `assignment`, `deliveries`, `review` (with `approved_by`),
 * `payment` (the one shape), `next_step` (what the caller or their owner does
 * next, state-aware; once settled it starts with the task status word, "Approved:" or
 * "Auto-confirmed:"; for an agent key without the authority the next action needs it
 * names the toggle the owner must set), `confirm_hint` (the same text; the name from
 * the first build) and `agent_authority` (2026-10-11.6: `{ setter_mode, hunter_mode }`
 * of the agent key in use, null for a human session; what the key may do before it
 * tries, the same as `me`'s `agent.setter_mode` / `hunter_mode`).
 *
 * `confirm_url` is present ONLY when a human-only action is pending for this reader;
 * `next_step` says what. Setter: confirm an agent-requested auto-accept
 * (`<website>/task/<id>?confirm=auto_accept`, then also `auto_accept_status` and
 * `auto_accept_confirm_url`), accept an applicant by hand (pending applications on an
 * open task), or confirm the Hunter's cancellation request. Hunter: confirm the
 * Setter's cancellation request. Applicant: never. Without `confirm_url` nothing
 * needs a human; link with the task's `website_url`.
 *
 * - Setter: `applications` (each with `auto_accept_skipped_reason`).
 * - Hunter (accepted applicant): `my_application`, the assignment.
 * - Applicant (pending, closed, withdrawn or rejected): `my_application`;
 *   `assignment` null, `payment.status` "none".
 */
export type ParticipantCommon = {
  assignment: Assignment | null;
  deliveries: Delivery[];
  review: CompletionReview | null;
  payment: PaymentSummary;
  next_step: string;
  confirm_hint: string;
  agent_authority: { setter_mode: 'always' | 'deny'; hunter_mode: 'always' | 'deny' } | null;
  confirm_url?: string;
};

export type TaskParticipant =
  | (ParticipantCommon & {
    role: 'setter';
    applications: TaskApplication[];
    auto_accept_status?: 'pending_owner_confirmation';
    auto_accept_confirm_url?: string;
  })
  | (ParticipantCommon & { role: 'hunter'; my_application: TaskApplication })
  | (ParticipantCommon & { role: 'applicant'; my_application: TaskApplication; assignment: null; confirm_url?: undefined });

/**
 * GET /v1/tasks/:id: the task, plus `participant` for a caller with credentials:
 * the block when they take part, `null` (present, null) when their key is neither
 * the Setter's, an applicant's nor the Hunter's. Anonymous callers get no
 * `participant` key at all. `confirm_url` is a copy of `participant.confirm_url`
 * when that exists.
 */
export type TaskDetail = (PublicTask | OwnerTask) & { participant?: TaskParticipant | null; confirm_url?: string };

export type Agent = {
  id: string;
  display_name: string;
  api_key_prefix: string;
  setter_mode: 'always' | 'deny';
  hunter_mode: 'always' | 'deny';
  status: 'active' | 'revoked';
  created_at: string | null;
  last_used_at: string | null;
  /**
   * Where the owner found us (platform 2026-10-30.2): the optional label given when the key was
   * created on the website or with `POST /v1/me/agents` (`directory`, `cursor`, `vscode`,
   * `claude`, `npm`, `skills`, `other`), never changed; null when none was given, absent on an
   * older deployment. Adoption telemetry only; no tool here sets it.
   */
  source?: string | null;
};

export type HunterAccount = {
  stripe_account_id: string;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  country_code: string | null;
  abn_status: string;
  updated_at: string | null;
};

/**
 * GET /v1/me/money (platform 2026-10-15.11): the owner's ledger on both sides.
 * Hunter amounts are "earned" or "captured", never "settled" or "paid out";
 * Stripe's own fee is an estimate (stripe_fee_estimated is always true).
 */
export type HunterMoneyRow = {
  assignment_id: string; task_id: string; task_title: string; task_status: string; assignment_status: string;
  state: 'held' | 'delivered_review' | 'approved_captured' | 'refunded' | 'cancelled' | 'expired';
  bounty_minor: number; fee_bps: number; fee_holiday: boolean; tier_code: string;
  platform_fee_minor: number; hunter_net_minor: number; captured_minor: number; refunded_minor: number;
  estimated_stripe_fee_minor: number; stripe_fee_estimated: boolean; currency: 'AUD';
  accepted_at: string | null; deadline_at: string | null; review_until: string | null; captured_at: string | null; ended_at: string | null;
  issue_open: boolean; dispute_status?: 'open' | 'won' | 'lost';
};

export type SetterMoneyRow = {
  task_id: string; task_title: string; task_status: string; assignment_id: string | null; hunter_display_name: string | null;
  state: 'none' | 'held' | 'captured' | 'refunded' | 'released';
  bounty_minor: number; held_minor: number; captured_minor: number; refunded_minor: number; charged_minor: number; currency: 'AUD';
  published_at: string | null; charged_at: string | null;
};

export type Money = {
  as_hunter: {
    rows: HunterMoneyRow[];
    totals: {
      earned_net_minor: number; earned_count: number; held_now_minor: number; held_count: number;
      awaiting_review_minor: number; awaiting_review_count: number; captured_last_30d_minor: number; captured_last_30d_count: number;
      estimated_stripe_fees_minor: number; currency: 'AUD';
    };
    stripe: { account_id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; dashboard_url: string; dashboard_hint: string } | null;
    earliest_payout_hint: string;
    stripe_fee_estimate: { rate_bps: number; fixed_minor: number; note: string };
  };
  as_setter: {
    rows: SetterMoneyRow[];
    totals: {
      held_now_minor: number; held_count: number; charged_this_month_minor: number; charged_this_month_count: number;
      charged_lifetime_minor: number; charged_count: number; refunded_minor: number; currency: 'AUD';
    };
  };
  /**
   * Where the Hunter stands on the fee ladder. `basis` (platform 2026-10-19.2) says which
   * ladder: `seasoned_net_earnings` (trust.mode enforce: the six-tier ladder by lifetime
   * seasoned net earnings; `needed` / `remaining` are then MINOR UNITS of seasoned net
   * earnings, and the gate fields say when a promotion already earned takes effect) or
   * `settled_count_180d` (shadow: the legacy count ladder; `needed` / `remaining` are
   * settled contracts). An older deployment omits `basis`: read it as the count ladder.
   */
  fee_tier: {
    code: string; fee_bps: number; fee_percent: number; settled_count: number; window_days: number;
    next_tier: string | null; next_fee_bps: number | null; next_fee_percent: number | null; needed: number | null; remaining: number;
    basis?: 'seasoned_net_earnings' | 'settled_count_180d' | string;
    seasoned_minor?: number; pending_season_minor?: number; seasons_at?: string | null;
    money_tier?: TrustTier | string; time_gate_ok?: boolean; gate_clears_at?: string | null;
  };
  currency: 'AUD';
  server_time: string;
};

/** The six trust tiers in ladder order (platform 2026-10-18.1); `post_task.min_hunter_tier` takes one of them. */
export const TRUST_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'obsidian'] as const;

/** The six trust tiers (platform 2026-10-18.1, stage 0 shadow). Display only: never a ranking, never eligibility. */
export type TrustTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'obsidian';

/** One table of the capabilities `trust` block: a whole number per tier (minor units, basis points, days or counts). */
export type TrustTierTable = Record<TrustTier, number>;

/**
 * One side's ladder in `me.trust` (platform 2026-10-18.1). `tier` is the EFFECTIVE tier
 * (the money tier lowered until the account age clears the time gate); `money_tier`
 * is what the money alone reaches, and when they differ `time_gate_ok` is false and
 * `gate_clears_at` says when the gate clears. `seasoned_minor` is lifetime: the Hunter
 * side sums the net (bounty less platform fee, before Stripe's fee), the Setter side
 * the captured amount, over completed contracts that are not lost to a dispute and
 * seasoned `season_days` after settlement. `next_*` describe the tier above
 * `money_tier` (null at obsidian). `fee_bps_planned` (Hunter side only) is the planned
 * fee for the effective tier, NOT what is charged: today's fee is `me.fee_tier` /
 * `capabilities.money.fee_tiers`.
 */
export type TrustLadder = {
  side: 'hunter' | 'setter';
  seasoned_minor: number;
  tier: TrustTier;
  tier_rank: number;
  money_tier: TrustTier;
  time_gate_ok: boolean;
  time_gate_days: number;
  gate_clears_at: string | null;
  account_age_days: number;
  next_tier: TrustTier | null;
  next_at_minor: number | null;
  remaining_minor: number | null;
  counted_contracts: number;
  /** Shown as facts only; no saturation or distinct-counterparty rule applies. */
  distinct_counterparties: number;
  repeat_contracts: number;
  pending_season_minor: number;
  seasons_at: string | null;
  season_days: number;
  fee_bps_planned: number | null;
  member_since: string | null;
};

/**
 * The Hunter's concurrent slots for the effective tier and the live count. Shadow mode:
 * planned only (today's cap is `me.hunter_max_active_assignments`). Enforce mode (platform
 * 2026-10-19.2): the live cap (`enforced: true`; `me.hunter_max_active_assignments` equals
 * `slots`), a delivered assignment leaving `active_now` `delivered_grace_hours` (12) after
 * delivery; `next_*` describe the tier above, `override` an approved limit request's line
 * (effective slots = max(tier, override)). The stage-1 keys are optional: an older
 * deployment omits them.
 */
export type TrustHunterSlots = {
  tier: TrustTier; slots: number; active_now: number;
  enforced?: boolean; delivered_grace_hours?: number;
  next_tier?: TrustTier | null; next_slots?: number | null; next_at_minor?: number | null; seasons_at?: string | null;
  override?: LimitValues & { request_id?: string; override_id?: string; scope?: 'task' | 'account'; valid_until?: string } | null;
};

/** The Hunter's public track record facts (last 30 / 180 days where noted). */
export type TrustTrackRecord = {
  completed_count: number;
  distinct_setters: number;
  repeat_contracts: number;
  /** Delivery to explicit approval, last 30 days; null under 5 samples. */
  approval_median_hours: number | null;
  approval_samples_30d: number;
  auto_confirmed_pct: number | null;
  lost_disputes_180d: number;
  expired_180d: number;
  member_since: string | null;
};

/**
 * The Setter's planned row for the effective tier (platform 2026-10-19.1, founder
 * 2026-10-18 → 2026-10-19): concurrent task SLOTS x TOTAL bounty in flight, plus a
 * per-task cap and a daily cap. `slots_used` / `in_flight_minor` count / sum the
 * Setter's LIVE tasks (pending_review, open, assigned, delivered, issue_raised); one
 * task may use the whole in-flight cap, and a slot and its money return the moment the
 * task settles, is cancelled, expires or is refunded (no cooling period). `slots` null =
 * unlimited (obsidian). `available_minor` = max(0, effective cap - in_flight_minor),
 * where the effective cap is `cap_minor` less the loss ledger's outstanding amount
 * (`Trust.setter.loss`). `per_task_cap_minor` is the largest single bounty without a
 * limit request (stage 1, not yet available) and `auto_accept_cap_minor` equals it;
 * `daily_cap_minor` is the charges captured per UTC day without a request and
 * `charged_today_minor` what has been captured on the Setter's payments so far today.
 * Nothing enforced in shadow mode: today's caps in `me` and `capabilities.money` still
 * apply.
 *
 * Enforce mode (platform 2026-10-19.2, trust stage 1; `enforced: true`): this row IS the
 * Setter's limit. `per_task_cap_minor` → 422 setter_task_cap_exceeded, `slots` → 422
 * setter_slots_full, the effective in-flight cap → 422 setter_cap_exceeded, the daily cap
 * over the charges captured in the ROLLING last 24 hours (`charged_24h_minor`,
 * `daily_resets_at`) → 422 setter_daily_cap_exceeded, `posts_per_day` listings per
 * rolling 24 hours (`posts_24h`, `posts_resets_at`) → 422 setter_daily_posts_exceeded.
 * Where the tier row sets `cooling_days` > 0 (0 at every tier since platform 2026-10-19.2;
 * the mechanism stays) a settled task keeps its slot and money `cooling_days` after
 * settlement (`cooling_held_slots`, `cooling_held_minor`; `slots_used` / `in_flight_minor`
 * include them, `live_*` do not) unless an approved line says `cooling_bypass`. Effective
 * numbers are max(tier row, `override`), the line an approved limit request put in force;
 * `next_*` describe the next tier's row and what reaches it. The stage-1 keys are
 * optional: an older deployment omits them.
 */
export type TrustSetterRow = {
  tier: TrustTier;
  slots: number | null;
  slots_used: number;
  cap_minor: number;
  in_flight_minor: number;
  available_minor: number;
  per_task_cap_minor: number;
  auto_accept_cap_minor: number;
  daily_cap_minor: number;
  charged_today_minor: number;
  enforced?: boolean;
  charged_24h_minor?: number;
  daily_resets_at?: string | null;
  posts_per_day?: number | null;
  posts_24h?: number;
  posts_resets_at?: string | null;
  cooling_days?: number;
  cooling_bypass?: boolean;
  cooling_held_slots?: number;
  cooling_held_minor?: number;
  live_slots_used?: number;
  live_in_flight_minor?: number;
  override?: LimitValues & { request_id?: string; override_id?: string; scope?: 'task' | 'account'; valid_until?: string } | null;
  next_tier?: TrustTier | null;
  next_row?: TrustSetterRowTable | null;
  next_at_minor?: number | null;
  seasons_at?: string | null;
  /**
   * Identity gate (platform 2026-10-30.1, trust stage 2). While the founder's
   * `identity_required_from_tier` is set and the Setter's ladder tier is at or above it but their
   * Stripe Identity is not verified, the row read here is the one of the tier below the gate
   * (Platinum → Gold): `row_tier` names it and `identity_gate.applied` is true. Limits only: `tier`,
   * the fee and the badge stay the ladder tier's. Absent before stage 2 or while the gate is off.
   */
  row_tier?: TrustTier;
  identity_gate?: { required_from_tier: TrustTier | null; applied: boolean; row_tier: TrustTier; route: string } | null;
};

/** One tier's Setter row in `capabilities.trust.setter_rows` (and `TrustSetterRow.next_row`). */
export type TrustSetterRowTable = {
  slots: number | null; total_cap_minor: number; per_task_cap_minor: number; daily_cap_minor: number;
  /** Listings per rolling 24 hours (null = unlimited) and the cooling after settlement in days; platform 2026-10-19.2, optional before. */
  posts_per_day?: number | null; cooling_days?: number;
};

/**
 * The Setter's loss ledger (platform 2026-10-18.1, shadow): if the platform lost
 * money on this account (a card dispute lost on a payment it made, plus the A$25
 * dispute fee, or a loss the founder records), `outstanding_minor` is what the
 * platform fees the account generated afterwards (as Setter or as Hunter) have not
 * yet repaid, and `effective_cap_minor` = max(0, row.cap_minor - outstanding_minor).
 * Shown only in shadow mode; in enforce mode the effective cap is the live limit. Since
 * platform 2026-10-30.1 (trust stage 2) a LOST dispute also adds the platform fee returned
 * to the Hunter and any dispute-fee compensation paid to them as the paying Setter's debt here.
 */
export type TrustLoss = { outstanding_minor: number; effective_cap_minor: number };

/**
 * `capabilities.trust.setter_rows` (platform 2026-10-19.1 / 2026-10-19.2): per tier, `slots` (null =
 * unlimited), `total_cap_minor` (the total bounty in flight the tier allows), `per_task_cap_minor`
 * (the largest single bounty without a limit request; also the auto-accept cap), `daily_cap_minor`
 * (the charges captured per rolling 24 hours without a limit request), `posts_per_day` (listings per
 * rolling 24 hours, null = unlimited) and `cooling_days` (0 at every tier;
 * 0 = a slot and its money return at settlement). Live rows: Bronze 2 / A$100 / A$50 / A$100 / 20,
 * Silver 3 / 100 / 50 / 200 / 40, Gold 4 / 200 / 100 / 400 / 80, Platinum 5 / 500 / 200 / 750 / 150,
 * Diamond 8 / 1,500 / 300 / 1,000 / 300, Obsidian unlimited / 3,000 / 500 / 1,500 / unlimited; the
 * founder may change them, so read the document.
 */
export type TrustSetterRows = Record<TrustTier, TrustSetterRowTable>;

/**
 * `me.trust` (platform 2026-10-18.1): the owner's tier on each side. While `mode` is
 * `shadow` nothing in it is enforced: the platform fee follows the legacy count ladder
 * (`money.legacy_fee_tiers`), the static caps in `me` and `capabilities.money` apply,
 * and no request is refused because of a tier. When `mode` is `enforce` (trust stage 1,
 * platform 2026-10-19.2) the Hunter's fee is the ladder tier's (`money.fee_tiers`, 20 /
 * 15 / 13 / 10 / 8 / 5 % by lifetime seasoned net earnings), `setter.row` is the
 * Setter's live limit and `hunter.slots` the Hunter's; above a limit the door is a
 * limit request (`request_limit`, `me.limit_requests`). An agent key reads its owner's
 * block (same user). Tiers are display and limits only; never treat them as a ranking
 * of Hunters or Setters or as eligibility (a Setter may set `min_hunter_tier` on their
 * own task; the platform never does).
 */
export type Trust = {
  mode: 'shadow' | 'enforce' | string;
  hunter: { ladder: TrustLadder; slots: TrustHunterSlots; track_record: TrustTrackRecord };
  setter: { ladder: TrustLadder; row: TrustSetterRow; loss: TrustLoss };
};

/** `trust` member of the capabilities document (platform 2026-10-18.1): the ladder parameters, the same for every caller. */
export type CapabilitiesTrust = Record<string, unknown> & {
  mode?: 'shadow' | 'enforce' | string;
  note?: string;
  tiers?: TrustTier[];
  thresholds?: TrustTierTable;
  fee_bps_planned?: TrustTierTable;
  time_gate_days?: TrustTierTable;
  setter_rows?: TrustSetterRows;
  hunter_slots?: TrustTierTable;
  /** True when `mode` is enforce (platform 2026-10-19.2): the rows above are the live limits and `money.fee_tiers` is what is charged. */
  enforced?: boolean;
  /** Hours after its delivery a delivered assignment stops counting against the Hunter's slots (12; enforce mode). */
  delivered_grace_hours?: number;
  season_days?: { hunter: number; setter: number };
  counting_rule?: string;
  /** The per-task, in-flight, daily and slot limits are the thresholds above which a limit request is the door; the full block is `Capabilities.limit_requests`. */
  limit_requests?: string;
  /** How a lost card dispute (plus the dispute fee) or a founder-recorded loss comes off the Setter's total in-flight cap until later platform fees repay it. */
  loss_ledger?: string;
};

export type Me = {
  id: string;
  display_name: string;
  country_code: string | null;
  terms_version: string | null;
  terms_accepted_at: string | null;
  over_18_attested_at: string | null;
  /** True for a listed admin's own session only; always false with an agent API key, even an admin's (the key never has admin power). */
  is_admin: boolean;
  status: string;
  created_at: string | null;
  /** The agent key in use, when the caller is an agent. */
  agent: Agent | null;
  terms_current_version: string;
  terms_current_accepted: boolean;
  hunter_account: HunterAccount | null;
  payment_method_count: number;
  /**
   * The Hunter's fee tier as the next acceptance would snapshot it. `hunter_tier_basis`
   * (platform 2026-10-19.2) says which ladder: `seasoned_net_earnings` (trust.mode
   * enforce: the six-tier ladder, `trust.hunter.ladder.tier`) or `settled_count_180d`
   * (shadow: the legacy count ladder over `hunter_tier_eligible_count`).
   */
  hunter_tier_code?: TrustTier | string;
  hunter_tier_basis?: 'seasoned_net_earnings' | 'settled_count_180d' | string;
  hunter_tier_eligible_count?: number;
  /** Assignments as Hunter in flight: active AND delivered (a delivered one counts until the Setter settles it). */
  hunter_active_assignments?: number;
  /**
   * The limits before they bite (platform 2026-10-15.3). Optional: an older
   * deployment omits them. At hunter_max_active_assignments the next
   * apply_to_task is 409 hunter_active_limit_reached; the Setter counters are
   * today's (UTC) and reset at setter_daily_resets_at. Enforce mode (platform
   * 2026-10-19.2): hunter_max_active_assignments is the tier's slots
   * (`trust.hunter.slots`), and the Setter's limits are `trust.setter.row`; the
   * static-cap fields below are kept for compatibility only, and `limits_note` says so.
   */
  hunter_max_active_assignments?: number;
  hunter_active_assignments_note?: string;
  limits_note?: string;
  hunter_active_assignment_ids?: string[];
  setter_daily_cap_minor?: number;
  setter_daily_used_minor?: number;
  setter_daily_posts_limit?: number;
  setter_daily_posts_used?: number;
  setter_daily_resets_at?: string;
  /**
   * True while the first listing(s) are still read by a person; in shadow mode the next listing is capped at
   * new_setter_task_cap_minor. Always false while the first-listing review is off (new_setter_review_count 0, the launch default since 2026-11-10).
   */
  setter_is_new?: boolean;
  new_setter_task_cap_minor?: number;
  max_task_bounty_minor?: number;
  /**
   * Trust preview (platform 2026-10-18.1, shadow mode): the owner's planned tier on
   * each side. Optional: an older deployment omits it. Display only; nothing enforced.
   */
  trust?: Trust;
  /** The owner's limit-request document (platform 2026-10-19.2): the open request, the lines in force, pacing, rules. Optional: an older deployment omits it. */
  limit_requests?: LimitRequestSummary;
  /**
   * Identity (platform 2026-10-30.1, trust stage 2): the owner's Stripe Identity
   * outcome and whether the gate applies to them. Status only; the owner starts a session on the
   * website (human session; an agent key is refused with 403 `human_only`). Optional: an older
   * deployment omits it.
   */
  identity?: Identity;
};

/**
 * `me.identity` (platform 2026-10-30.1, trust stage 2: Setters from
 * Platinum, Australian documents only). `status` is the Stripe Identity outcome (`pending`: a
 * session was started and no outcome has arrived; `failed`: see `failed_reason`, `not_au_document`
 * when the document was issued outside Australia, else Stripe's `last_error.code`). `enabled` says
 * whether the deployment has Identity on (controls `identity_required_from_tier` set);
 * `required_for_tier` is the gate tier (null = off); `required_now` that the owner's Setter money
 * tier is at or above it and they are not verified; `gate_applies` that the Setter row read right
 * now is the one below the gate (`row_tier_while_unverified`). Pacing: `sessions_30d` of
 * `max_sessions_30d` (2 per account) and `site_sessions_30d` of `site_monthly_cap`;
 * `can_start_now` folds them. The platform stores the outcome only (`stored`): never names, document
 * numbers or images. Hunters are not asked (Stripe Connect verified them at onboarding). The flow
 * is `route` = `POST /v1/me/identity/session`, a human session on the website (Account → Identity);
 * no tool or CLI command starts it.
 */
export type Identity = {
  status: 'not_started' | 'pending' | 'verified' | 'failed' | string;
  enabled: boolean;
  required_for_tier: TrustTier | null;
  required_now: boolean;
  gate_applies: boolean;
  row_tier_while_unverified?: TrustTier | null;
  verified_at: string | null;
  failed_reason: string | null;
  sessions_30d: number;
  max_sessions_30d: number;
  site_sessions_30d?: number;
  site_monthly_cap?: number;
  can_start_now: boolean;
  documents: Array<'driving_license' | 'passport' | string>;
  country: 'AU' | string;
  stored?: string;
  route: 'POST /v1/me/identity/session' | string;
};

export type MarketplaceEvent = {
  seq: number;
  id: string;
  type: string;
  task_id: string | null;
  assignment_id: string | null;
  actor_kind: string | null;
  visibility: string;
  payload: Record<string, unknown>;
  created_at: string | null;
};

/** `activity` member of the capabilities document: live counts computed by the platform for `as_of`. */
export type MarketplaceActivity = {
  /** Tasks with status open right now (accepting applications). */
  open_tasks: number;
  /** Assignments completed (approved, auto-confirmed or decided in the Hunter's favour) in the last 30 days. */
  settled_last_30_days: number;
  /** Distinct Hunters with an assignment accepted or completed in the last 30 days. */
  active_hunters_last_30_days: number;
  /** Median hours from publication to the first application over tasks published in the last 30 days; null below 3 samples. */
  median_hours_to_first_application_last_30_days: number | null;
  /**
   * Median hours from an application to its acceptance (manual or automatic) over
   * applications accepted in the last 30 days; null below 5 samples (platform
   * 2026-10-15.12; was 3). The typical wait after applying; when null, read
   * median_samples_last_30_days.acceptance to see why.
   */
  median_hours_to_acceptance_last_30_days: number | null;
  /** How many samples each median rests on (platform 2026-10-15.12): first_application and listing_approval need 3, acceptance needs 5. */
  median_samples_last_30_days?: { first_application: number; acceptance: number; listing_approval: number };
  /** The clock the numbers were computed for (ISO-8601 UTC, Z). */
  as_of: string;
};

/** `events.types` of the capabilities document: every event type the feed can carry, with who sees it. */
export type EventTypeInfo = { type: string; visible_to: string; meaning: string; ends_assignment?: true; frees_hunter_slot?: true };

/**
 * `review` member: the founder's review target for a held listing (a target, not a
 * guarantee). `new_setter_first_listings` is how many of a new Setter's listings are
 * reviewed before becoming visible: 0 since 2026-11-10 (a
 * first listing opens at once), 1 from 2026-10-08 to 2026-11-10; the founder can set it
 * above 0 again. `note` says which applies and that a listing whose wording suggests
 * in-person work is held for an online-only check (task `review_reasons`), whatever
 * the Setter's history.
 */
export type ReviewTarget = {
  new_setter_first_listings: number;
  target_hours: number;
  /** Median hours from posting to the founder's approval over listings approved in the last 30 days; null below 3 samples. */
  median_hours_to_approval_last_30_days: number | null;
  note: string;
};

/**
 * `caps_autoscale` member (2026-10-08): the money caps grow with the marketplace's
 * track record. After `target` consecutive dispute-free settlements site-wide
 * (approved or auto-confirmed with no issue ever raised), `money.max_task_bounty_minor`,
 * `new_setter_task_cap_minor`, `setter_daily_cap_minor` and `site_daily_cap_minor`
 * each double, up to their `ceilings`, `level` rises by one and `streak` restarts
 * (public event `controls.caps_autoscaled`, payload `{ level, caps, streak_target }`).
 * Any raised issue resets the streak to 0; caps never decrease automatically, and
 * `money.auto_accept_max_bounty_minor` never scales (founder-set only). The current
 * caps are always the values in `money`.
 */
export type CapsAutoscale = {
  enabled: boolean;
  /** Consecutive dispute-free settlements so far. */
  streak: number;
  /** Settlements the streak must reach for the caps to double (20 at launch). */
  target: number;
  /** How many times the caps have doubled (0 at launch). */
  level: number;
  /** The highest value each cap can reach by auto-scaling (integer AUD cents). */
  ceilings: {
    max_task_bounty_minor: number;
    new_setter_task_cap_minor: number;
    setter_daily_cap_minor: number;
    site_daily_cap_minor: number;
  };
  /** When the caps last doubled (ISO-8601 UTC, Z); null while they never have. */
  last_changed_at: string | null;
  /** The rule in plain words. */
  description: string;
};

/**
 * One row of `money.fee_tiers`. Since platform 2026-10-19.2 the schedule is the six-tier
 * ladder by lifetime seasoned net earnings (bronze 20 %, silver 15 % from A$250, gold 13 %
 * from A$1,000, platinum 10 % from A$5,000, diamond 8 % from A$15,000, obsidian 5 % from
 * A$30,000; `minimum_earned_minor`, with an account-age gate `time_gate_days`), and
 * `minimum_settled_tasks` is null; `money.legacy_fee_tiers` keeps the 180-day count ladder
 * (15 / 14 / 12.5 / 10 % after 0 / 5 / 20 / 50 settled) that is charged while trust.mode is
 * shadow. An older deployment serves the count ladder here with `minimum_settled_tasks` set.
 */
export type FeeTier = {
  code: string;
  rank: number;
  fee_bps: number;
  fee_percent: number;
  minimum_settled_tasks: number | null;
  minimum_earned_minor?: number;
  time_gate_days?: number;
};

/**
 * `money` member: the live caps (integer AUD cents) with a description of each, fee
 * tiers, the fee holiday (if any) and the live-charge switches. The caps marked
 * "auto-scales" in `cap_descriptions` grow with the dispute-free settlement streak
 * (see `CapsAutoscale`); the values here are always the current ones.
 */
export type CapabilitiesMoney = Record<string, unknown> & {
  currency?: 'AUD';
  minimum_bounty_minor?: number;
  max_task_bounty_minor?: number;
  new_setter_task_cap_minor?: number;
  /** How many of a new Setter's first listings the founder reviews before they become visible (0 at launch since 2026-11-10: no first-listing review; in shadow mode new_setter_task_cap_minor applies only while this is above 0). */
  new_setter_review_count?: number;
  setter_daily_cap_minor?: number;
  site_daily_cap_minor?: number;
  hunter_max_active_assignments?: number;
  /** Highest bounty a task may offer and still opt in to auto-accept (A$50 = 5000 at launch). Never auto-scales. */
  auto_accept_max_bounty_minor?: number;
  /** What each numeric cap means and the error code when it is exceeded, keyed by field name. */
  cap_descriptions?: Record<string, string>;
  /** The founder's pause switch (live mode only). */
  live_charges_paused?: boolean;
  /** Same as the top-level `live_charges`. */
  live_charges?: boolean;
  /**
   * 2026-10-08: while a fee holiday is published, every contract accepted before this
   * time (ISO-8601 UTC, Z) carries a 0% platform fee for every Hunter, human or AI agent
   * alike (the assignment records `fee_holiday: true`); after it the tiers apply. Null
   * when no holiday is running. The founder sets the date; read it, never assume it.
   */
  fee_holiday_until?: string | null;
  /** The fee-holiday rule in the platform's words. */
  fee_holiday?: string;
  fee_tiers?: FeeTier[];
  /** Platform 2026-10-19.2: the legacy 180-day count ladder (charged while trust.mode is shadow; history once enforced). */
  legacy_fee_tiers?: FeeTier[];
  /** Which schedule the next acceptance snapshots: `fee_tiers` (the ladder, enforce) or `legacy_fee_tiers` (shadow). */
  fee_schedule?: 'fee_tiers' | 'legacy_fee_tiers' | string;
  /** 3 under the ladder, 2 under the count tiers; recorded on every assignment as `policy_version`. */
  fee_policy_version?: number;
  fee_ladder_rule?: string;
  /** `tier_rows` (enforce: the caps in this block marked RETIRED in `cap_descriptions` no longer apply) or `static_caps` (shadow). */
  limits_enforced_by?: 'tier_rows' | 'static_caps' | string;
};

/** `eligibility` member: who may take each side (founder decision D1, 2026-10-07). */
export type Eligibility = {
  /** "Anyone, any country, with a non-prepaid card; charged in AUD." */
  setters: string;
  /** "Australia only: Stripe Connect account with an Australian bank account and an ABN or hobby statement." */
  hunters: string;
};

/**
 * `agent_actions` member: what an agent key may do, the same in sandbox and live.
 * Accepting an applicant stays a human click on the website unless auto-accept
 * was pre-authorised at posting; approving, raising an issue and responding to
 * one are allowed with the owner's standing authority (setter_mode / hunter_mode
 * "always").
 */
export type AgentActions = {
  accept_application: 'human_or_pre_authorised_auto_accept' | string;
  approve_delivery: 'agent_allowed' | string;
  raise_issue: 'agent_allowed' | string;
  respond_to_issue: 'agent_allowed' | string;
  /** Since platform 2026-10-15.16. */
  withdraw_issue?: 'agent_allowed' | string;
  /** Since platform 2026-10-17.2: an agent may request (never the Setter's after the delivery: 409 delivery_already_submitted). */
  request_cancellation?: 'agent_allowed' | string;
  /** Since platform 2026-10-17.2: a human click at confirm_url in sandbox and live alike (403 human_confirmation_required for agent keys). */
  confirm_cancellation?: 'human' | string;
  /** Since platform 2026-10-19.2: an agent key may file a limit request for its owner (request_limit). */
  request_limit?: 'agent_allowed' | string;
};

/**
 * Limit requests (platform 2026-10-19.2, trust stage 1). The row keys a request names
 * (a Hunter line names slots only), the request document and the owner's summary (GET /v1/me/limit-requests,
 * also me.limit_requests).
 */
export type LimitValues = {
  per_task_cap_minor?: number; total_cap_minor?: number; daily_cap_minor?: number; slots?: number | null; posts_per_day?: number | null; cooling_bypass?: boolean;
};
/**
 * The level-3 Contractor application (platform 2026-10-30.1, trust stage 2):
 * REST `POST /v1/me/limit-requests` requires it at level 3 and refuses it at levels 1 / 2 (422
 * `limit_request_invalid { field: detail… }`); the platform validates it field by field
 * (`details.field` names `detail.<key>`; `abn` must be 11 digits passing the ATO checksum, stored
 * without spaces; `contact_phone` digits, spaces, +, ( ) and - only). The MCP tool `request_limit`
 * carries no `detail` (its shape is the platform's), so a level-3 request filed through the tool
 * answers the same 422: the owner files it on the website (Account → Limits). Approved only with the
 * founder's decision note and, while identity is on, a verified Stripe Identity.
 */
export type LimitRequestL3Detail = {
  legal_name: string;
  abn?: string | null;
  website?: string | null;
  use_case: string;
  expected_monthly_minor: number;
  expected_tasks_per_month: number;
  typical_counterparties: string;
  contact_phone: string;
  agrees_to_call: boolean;
};
export type LimitRequestInput = {
  side: 'setter' | 'hunter'; level: 1 | 2 | 3; task_id?: string; requested: LimitValues; reason: string;
  /** Level 3 only (REST); see LimitRequestL3Detail. */
  detail?: LimitRequestL3Detail;
};
/**
 * Why a line ended early (`LimitOverride.revoked_reason`, event `limit_override.revoked` payload.reason).
 * Stage 1: `dispute` (an open card dispute on a charge the account made), `early_fraud_warning`, the
 * founder's own note. Stage 2 (platform 2026-10-30.1): `dispute_lost` (both parties' lines at a LOST
 * dispute), `expired_undelivered` (an auto-accepted assignment expired undelivered: the Hunter's
 * slots line), `instrument_changed` (a new card on a Setter account or a changed payout bank: that
 * side's level-2 / level-3 lines). The tier row applies again at once; the member is emailed.
 */
export type LimitOverrideRevokedReason = 'dispute' | 'early_fraud_warning' | 'dispute_lost' | 'expired_undelivered' | 'instrument_changed' | string;
export type LimitOverride = {
  id: string; request_id: string; user_id: string; side: 'setter' | 'hunter'; scope: 'task' | 'account'; task_id: string | null; values: LimitValues;
  valid_from: string; valid_until: string; revoked_at: string | null; revoked_reason: LimitOverrideRevokedReason | null; active: boolean;
};
export type LimitRequest = {
  id: string; user_id: string; side: 'setter' | 'hunter'; level: 1 | 2 | 3; task_id: string | null; requested: LimitValues; reason: string;
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'withdrawn' | 'revoked' | string;
  created_by_agent_id: string | null; filed_by: 'human' | 'ai_agent' | string; decided: boolean; decided_at: string | null; decision_note: string | null;
  /** Level 1 above 3 x the per-task cap: the founder's hand tick, or (stage 2) set by a verified Stripe Identity at the approval. */
  identity_confirmed: boolean; approved_values: LimitValues | null; duration_days: number | null; valid_from: string | null; valid_until: string | null;
  created_at: string; updated_at: string; override: LimitOverride | null;
  /** The level-3 application (platform 2026-10-30.1); null on levels 1 / 2, absent on an older deployment. */
  detail?: LimitRequestL3Detail | null;
};
export type LimitRequestSummary = {
  open: LimitRequest | null; requests: LimitRequest[]; active_overrides: LimitOverride[];
  effective: { setter: Record<string, unknown> | null; hunter: Record<string, unknown> | null };
  pacing: { used_30d: number; max_per_30d: number; next_allowed_at: string | null; cooldown_until: string | null; can_request_now: boolean; pending_expiry_days: number };
  rules: Record<string, unknown>; request_route: string;
};
/**
 * `capabilities.limit_requests` (platform 2026-10-19.2): the three levels in the platform's words
 * (1 = one task, Setter side, up to max(3 x the tier's per-task cap, A$600), 7 days, dies with the
 * task; 2 = an account line up to the next tier's row, 1 / 7 / 30 days, 24 hours by default; 3 = a
 * long-term Contractor line re-reviewed every 90 days), the pacing (one open request, 3 per 30 days,
 * two declines → a 30-day wait, pending 7 days → expired), the platform ceilings (A$10,000 in flight,
 * A$20,000 per day until raised), how a line raises a row (effective = max(tier row, line)), the
 * auto-revert on a dispute or early fraud warning, the live `rules` object and the routes. Since
 * platform 2026-10-30.1 (trust stage 2) `levels[3]` names the application form (`detail`, filed on
 * the website) and the identity requirement, `levels.note` that a verified Stripe Identity replaces
 * the founder's `identity_confirmed` tick, and `auto_revert` the three new reasons (`dispute_lost`,
 * `expired_undelivered`, `instrument_changed`).
 */
export type CapabilitiesLimitRequests = Record<string, unknown> & {
  how?: string;
  who_may_file?: Array<'human' | 'ai_agent' | string>;
  levels?: Record<string, string>;
  pacing?: { one_open_request?: boolean; max_per_30d?: number; declines_for_cooldown?: number; decline_cooldown_days?: number; pending_expiry_days?: number; note?: string };
  ceilings?: { in_flight_minor?: number; daily_minor?: number; note?: string };
  effective_rule?: string;
  auto_revert?: string;
  rules?: Record<string, unknown>;
  routes?: Record<string, string>;
};

/**
 * `capabilities.identity` (platform 2026-10-30.1, trust stage 2): Stripe Identity for
 * Setters from the gate tier (`required_from_tier`; null = off on this deployment), Australian
 * documents only (`documents` driving_license / passport, `country` AU), the outcome only stored
 * (`stored`), 2 sessions per account per 30 days and `pacing.site_30d` site-wide, and the routes
 * (`start` POST /v1/me/identity/session, human session; `status` GET /v1/me identity; `return`
 * /account/identity). `rule`, `how` and `accepted` are the platform's own sentences; quote them.
 */
export type CapabilitiesIdentity = Record<string, unknown> & {
  enabled?: boolean;
  provider?: 'stripe_identity' | string;
  required_from_tier?: TrustTier | null;
  applies_to?: 'setter' | string;
  documents?: string[];
  country?: 'AU' | string;
  rule?: string;
  how?: string;
  accepted?: string;
  stored?: string;
  pacing?: { per_account_30d?: number; site_30d?: number; note?: string };
  routes?: { start?: string; status?: string; return?: string };
};

/**
 * Event payloads of trust stage 2 (platform 2026-10-30.1) that a member receives: the Hunter sees
 * `payment.fee_returned` (participants) and `trust.compensation_paid` (payload.user_id).
 */
/** `payment.fee_returned`: after a LOST card dispute the platform returned its fee for the contract to the Hunter's Stripe balance (an Application Fee Refund); once per contract. */
export type FeeReturnedPayload = { returned_minor: number; application_fee_minor: number; hunter_fee_minor: number; currency: 'AUD' | string; dispute_id: string };
/** `trust.compensation_paid`: the platform paid the Hunter the dispute fee Stripe debited (never the bounty) by a Transfer from the platform balance. */
export type CompensationPaidPayload = {
  compensation_id: string; dispute_id: string; assignment_id: string; task_id: string; user_id: string; hunter_user_id: string; setter_user_id: string;
  amount_minor: number; currency: 'AUD' | string; reason: 'dispute_fee' | string;
};
/** The automatic safety pause named in 422 `breaker_paused` details.rule (b1, b2 or b3). Pause and notify only. */
export type BreakerRule = 'b1' | 'b2' | 'b3' | string;

/**
 * GET /v1/capabilities and the get_marketplace_capabilities tool. `mode` and
 * `live_charges` say whether real money moves right now (never in the sandbox),
 * `activity` whether anyone is active and how long applicants typically wait,
 * `review` whether a new Setter's first listing is reviewed and how long founder
 * review of a held listing is expected to take (target and recent median), `caps_autoscale` how the money caps grow
 * with dispute-free settlements, `money.fee_holiday_until` whether a fee holiday
 * is running (0% platform fee for every Hunter until then), `eligibility` who may
 * be a Setter or a Hunter, `agent_actions` what an agent key may do, `events.types`
 * every event type, `confirm_url` the rule every result follows and `timezone`
 * ("UTC") the clock of every timestamp the API emits (ISO-8601 with Z).
 *
 * `links`: `api`, `openapi`, `mcp`, `manifest`, `policy`, `capabilities`, `events`,
 * `tasks` and `report` are built from the origin that answered the request (the
 * API); `website`, `task_page`, `rules`, `terms`, `privacy` and `contact` from the
 * public website base, which can be another host (locally the API and the web app
 * often run on different ports). `links_note` says so in the document itself.
 */
export type Capabilities = Record<string, unknown> & {
  name?: string;
  /** 'public_sandbox' | 'live' */
  status?: string;
  /** 'sandbox' | 'live' */
  mode?: string;
  /** True only in live mode while live charges are not paused; always false in the sandbox. */
  live_charges?: boolean;
  server_time?: string;
  /** Every timestamp the API emits is ISO-8601 UTC with a trailing Z. */
  timezone?: 'UTC' | string;
  money?: CapabilitiesMoney;
  activity?: MarketplaceActivity;
  review?: ReviewTarget;
  caps_autoscale?: CapsAutoscale;
  eligibility?: Eligibility;
  agent_actions?: AgentActions;
  /** The trust ladder parameters (platform 2026-10-18.1); `trust.enforced` says whether they are the live limits. Optional: an older deployment omits it. */
  trust?: CapabilitiesTrust;
  /** The limit-request system (platform 2026-10-19.2): levels, pacing, ceilings, how to file. Optional: an older deployment omits it. */
  limit_requests?: CapabilitiesLimitRequests;
  /** Stripe Identity for Setters from the gate tier (platform 2026-10-30.1); `enabled` false = off on this deployment. Optional: an older deployment omits it. */
  identity?: CapabilitiesIdentity;
  tasks?: Record<string, unknown> & {
    categories?: TaskCategory[] | string[];
    /** The `min_hunter_tier` rule in the platform's words (platform 2026-10-19.2). */
    min_hunter_tier?: string;
    /** The auto-accept block: `max_bounty_minor`, `max_bounty_rule` (the Setter's per-task cap in enforce mode), `input`, `rule`. */
    auto_accept?: Record<string, unknown>;
    /** `{ min: 1, max: 96 }` since platform 2026-10-11.2 (at most 4 days); the 48-hour review window after delivery is unchanged. */
    delivery_hours?: { min: number; max: number };
    review_window_hours?: number;
    /** The first-listing review rule in the platform's words (off at launch since 2026-11-10; it says so). */
    new_setter_review?: string;
    /** The screening rule: prohibited matches are refused (422 prohibited_task); in-person wording holds the listing as pending_review (review_reasons). */
    screening?: string;
    online_only?: boolean;
  };
  events?: { how?: string; types?: EventTypeInfo[] };
  /** The rule: confirm_url appears only when the owner has one thing only a human can do on the website; next_step says what. */
  confirm_url?: string;
  links?: Record<string, string>;
  /** Which links come from the API origin and which from the public website base. */
  links_note?: string;
};

export type PolicyDocument = Record<string, unknown> & { digest?: string };

export type CreateTaskInput = {
  title: string;
  brief: string;
  deliverable: string;
  acceptance_criteria: string;
  category_code: TaskCategoryCode | string;
  bounty_minor: number;
  delivery_hours: number;
  /** Optional opt-in to accept the first qualifying applicant automatically; see AutoAcceptInput. */
  auto_accept?: AutoAcceptInput;
  /**
   * Trust stage 1 (platform 2026-10-19.2): refuse applicants below this Hunter tier
   * (422 min_tier_not_met) and never auto-accept them; omit or null for anyone. One of
   * TRUST_TIERS (422 invalid_min_hunter_tier otherwise). The Setter's choice; the
   * platform never filters by tier.
   */
  min_hunter_tier?: TrustTier | null;
  /**
   * Ids of draft brief files the same user uploaded with `POST /v1/uploads` (no
   * query); at most 10. They become `task.attachments`. 404 attachment_not_found,
   * 403 attachment_not_yours, 409 attachment_wrong_scope / attachment_already_attached,
   * 422 too_many_attachments / attachment_duplicate.
   */
  attachment_ids?: string[];
};

export type ReportInput = {
  target_kind: 'task' | 'user' | 'delivery' | 'agent';
  target_id: string;
  reason: 'prohibited_task' | 'scam_or_fraud' | 'harassment' | 'illegal' | 'other';
  detail?: string;
  contact?: string;
};

/**
 * GET /v1/tasks options. `fields: 'summary'` (platform 2026-10-15.12) returns TaskSummary rows;
 * `allow_agents`, `auto_accept`, `min_bounty`, `max_bounty` filter; `sort` orders (the `before`
 * cursor pages the newest order only). With credentials every row carries my_application /
 * my_assignment.
 */
export type ListTasksParams = {
  status?: string; category?: string; limit?: number; before?: string;
  fields?: 'full' | 'summary';
  allow_agents?: boolean;
  auto_accept?: 'active' | 'requested' | 'off';
  min_bounty?: number;
  max_bounty?: number;
  sort?: 'newest' | 'bounty_desc' | 'deadline_soonest';
};

/** One row of `GET /v1/tasks?fields=summary`: the listing without its long texts and attachments. */
export type TaskSummary = Pick<PublicTask, 'id' | 'title' | 'bounty_minor' | 'delivery_hours' | 'category_code' | 'auto_accept' | 'published_at' | 'website_url' | 'setter_is_ai_agent'>;

/** The caller's part in a listed task (keyed listings only): the latest application / assignment on it, or null. */
export type TaskParticipation = {
  my_application: { id: string; status: string } | null;
  my_assignment: { id: string; status: string } | null;
};

export type ListedTask = (PublicTask | TaskSummary) & Partial<TaskParticipation>;

/** The write-op echo (platform 2026-10-15.12) on POST deliveries / approve: what the write created or changed. */
export type WriteEcho = {
  delivery: Delivery | null;
  assignment: { id: string; status: string } | null;
  task: { id: string; status: string } | null;
};

/** POST /v1/applications/{id}/withdraw (platform 2026-10-15.12 echoes the application and a next_step; older deployments answer { ok }). */
export type WithdrawResponse = { ok: true; application?: { id: string; task_id?: string; status: string }; next_step?: string };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type ClientAuth =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'session'; accessToken: string }
  | { kind: 'none' };

export type ApiClientOptions = {
  baseUrl: string;
  auth?: ClientAuth | (() => ClientAuth);
  fetch?: typeof fetch;
  idempotencyKey?: () => string;
  userAgent?: string;
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const query = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return entries.length
    ? `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`
    : '';
};

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('createApiClient: no fetch implementation available');
  const resolveAuth = (): ClientAuth =>
    typeof options.auth === 'function' ? options.auth() : options.auth ?? { kind: 'none' };
  const newIdempotencyKey = options.idempotencyKey ?? (() => globalThis.crypto.randomUUID());
  const userAgent = options.userAgent ?? USER_AGENT;

  type SendInit = {
    /** JSON body (serialised here). */
    json?: unknown;
    /** Raw body (the file itself for POST /v1/uploads); sent as is, with the caller's headers. */
    raw?: Uint8Array;
    /** Extra request headers (X-Filename, the declared Content-Type of a raw body). */
    headers?: Record<string, string>;
    /** Whether to send an Idempotency-Key (writes default to yes; the raw upload route has none). */
    idempotent?: boolean;
    /** What to accept: JSON documents (the default) or any bytes (GET /v1/files/{id}). */
    accept?: 'json' | 'bytes';
  };

  /** One HTTP exchange: credentials, headers, the network error and the platform's error document mapped the same way for every route. */
  async function send(method: Method, path: string, init: SendInit = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: init.accept === 'bytes' ? '*/*' : 'application/json', 'user-agent': userAgent, ...(init.headers ?? {}) };
    const auth = resolveAuth();
    if (auth.kind === 'session') headers.authorization = `Bearer ${auth.accessToken}`;
    if (auth.kind === 'api_key') headers.authorization = `Bearer ${auth.apiKey}`;
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && init.idempotent !== false) headers['idempotency-key'] = newIdempotencyKey();

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: init.raw !== undefined ? init.raw : init.json === undefined ? undefined : JSON.stringify(init.json),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiClientError(0, 'network_error', `Could not reach ${baseUrl}: ${reason}`);
    }
    if (!response.ok) {
      let json: unknown = null;
      try {
        json = JSON.parse(await response.text());
      } catch {
        // not the platform's error document
      }
      const doc = json as Partial<ApiErrorBody> | null;
      const err = doc?.error;
      throw new ApiClientError(
        response.status,
        err?.code ?? 'http_error',
        err?.message ?? `HTTP ${response.status}`,
        err?.details,
        typeof doc?.next_step === 'string' ? doc.next_step : undefined,
        // retryable (platform 2026-10-30.2): the platform's word when it sent one; else from the status (an older deployment).
        typeof err?.retryable === 'boolean' ? err.retryable : undefined,
      );
    }
    return response;
  }

  async function request<T>(method: Method, path: string, body?: unknown, init?: { idempotent?: boolean }): Promise<T> {
    const response = await send(method, path, { json: body, idempotent: init?.idempotent });
    const text = await response.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiClientError(response.status, 'invalid_response', `Expected JSON from ${method} ${path}`);
    }
  }

  /** `filename=` / `filename*=UTF-8''...` of a Content-Disposition header, decoded; null when absent. */
  function dispositionFilename(disposition: string | null): string | null {
    if (!disposition) return null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) {
      try {
        return decodeURIComponent(star[1]!.trim());
      } catch {
        // fall through to the plain name
      }
    }
    const plain = /filename="([^"]*)"/i.exec(disposition) ?? /filename=([^;]+)/i.exec(disposition);
    return plain ? plain[1]!.trim() : null;
  }

  return {
    baseUrl,
    /** Whether requests carry credentials. */
    hasAuth: () => resolveAuth().kind !== 'none',

    // public (no credentials needed)
    health: () => request<{ ok: boolean; db?: string; version?: string }>('GET', '/health'),
    capabilities: () => request<Capabilities>('GET', '/v1/capabilities'),
    manifest: () => request<Record<string, unknown>>('GET', WELL_KNOWN_MANIFEST_PATH),
    policy: () => request<PolicyDocument>('GET', WELL_KNOWN_POLICY_PATH),
    listTasks: (params: ListTasksParams = {}) =>
      request<{ tasks: ListedTask[]; next_before: string | null }>('GET', `/v1/tasks${query({
        status: params.status, category: params.category, limit: params.limit, before: params.before,
        fields: params.fields, allow_agents: params.allow_agents === undefined ? undefined : String(params.allow_agents),
        auto_accept: params.auto_accept, min_bounty: params.min_bounty, max_bounty: params.max_bounty, sort: params.sort,
      })}`),
    getTask: (taskId: string) => request<TaskDetail>('GET', `/v1/tasks/${encodeURIComponent(taskId)}`),
    getProfile: (userId: string) => request<Record<string, unknown>>('GET', `/v1/profiles/${encodeURIComponent(userId)}`),
    report: (input: ReportInput) => request<{ id: string; status: string }>('POST', '/v1/reports', input, { idempotent: false }),

    // me (API key or session)
    me: () => request<Me>('GET', '/v1/me'),
    /** Limit requests (platform 2026-10-19.2): file one for the owner (a human session or this key), list them, withdraw a pending one. */
    createLimitRequest: (input: LimitRequestInput) =>
      request<{ request: LimitRequest; next_step?: string }>('POST', '/v1/me/limit-requests', input),
    myLimitRequests: () => request<LimitRequestSummary>('GET', '/v1/me/limit-requests'),
    withdrawLimitRequest: (requestId: string) =>
      request<{ request: LimitRequest; next_step?: string }>('DELETE', `/v1/me/limit-requests/${encodeURIComponent(requestId)}`),
    myTasks: () => request<{ tasks: OwnerTask[] }>('GET', '/v1/me/tasks'),
    myAssignments: () =>
      request<{ assignments: Array<Assignment & { task: { id: string; title: string; status: string; category_code: string } }> }>(
        'GET', '/v1/me/assignments',
      ),
    myApplications: () =>
      request<{ applications: Array<TaskApplication & { task: { id: string; title: string; status: string; bounty_minor: number } }> }>(
        'GET', '/v1/me/applications',
      ),
    /** The owner's money ledger (GET /v1/me/money, platform 2026-10-15.11). */
    myMoney: () => request<Money>('GET', '/v1/me/money'),
    /** `taskId` narrows the feed to one task (`?task_id=`); the cursor semantics are unchanged. */
    events: (after = 0, limit = 100, taskId?: string | null) =>
      request<{ events: MarketplaceEvent[]; next_after: number; poll_after_seconds?: number }>('GET', `/v1/events${query({ after, limit, task_id: taskId ?? undefined })}`),

    // tasks
    createTask: (input: CreateTaskInput) => request<CreatedTask>('POST', '/v1/tasks', input),
    /**
     * Dry run: POST /v1/tasks with `validate_only: true`. Every check runs (screening,
     * caps, auto-accept rules) and nothing is created; a failed check throws the
     * ordinary ApiClientError (422 prohibited_task, bounty_above_new_setter_cap, ...).
     */
    validateTask: (input: CreateTaskInput) => request<TaskValidation>('POST', '/v1/tasks', { ...input, validate_only: true }),
    cancelTask: (taskId: string) => request<OwnerTask>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`),
    /** Withdraws the auto-accept opt-in (the Setter, human or agent with setter_mode "always"); a no-op when not enabled. */
    disableAutoAccept: (taskId: string) =>
      request<OwnerTask>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/auto-accept/disable`),
    /**
     * Confirms an agent-requested auto-accept. Human session only: an agent key is
     * refused with 403 human_confirmation_required (the owner confirms at confirm_url).
     */
    confirmAutoAccept: (taskId: string) =>
      request<OwnerTask>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/auto-accept/confirm`),
    listApplications: (taskId: string) =>
      request<{ applications: TaskApplication[] }>('GET', `/v1/tasks/${encodeURIComponent(taskId)}/applications`),
    /**
     * The application plus `assignment` (null while pending, or the new contract
     * when the task's human-confirmed auto-accept took the applicant at once),
     * `auto_accept_outcome`, a matching `next_step` and, only once accepted, `payment`
     * (the hold, the one shape). Never card data or provider identifiers.
     */
    apply: (taskId: string, message?: string) =>
      request<ApplyResponse>(
        'POST', `/v1/tasks/${encodeURIComponent(taskId)}/applications`, message === undefined ? {} : { message },
      ),
    withdrawApplication: (applicationId: string) =>
      request<WithdrawResponse>('POST', `/v1/applications/${encodeURIComponent(applicationId)}/withdraw`),

    // assignments
    getAssignment: (assignmentId: string) =>
      request<AssignmentDetail>('GET', `/v1/assignments/${encodeURIComponent(assignmentId)}`),
    /**
     * `:id` is the assignment id, or a task id (the caller's live assignment on that
     * task is resolved by the platform). A miss is 404 assignment_not_found with
     * `details { assignment_id, task_id, pending_application_id }` and a message
     * written for deliver. The returned review names the assignment (`assignment_id`)
     * and carries `payment` (the one shape) and `next_step` with the amounts.
     */
    deliver: (assignmentOrTaskId: string, summary: string, links: string[] = [], attachmentIds: string[] = []) =>
      request<ReviewWithPayment>('POST', `/v1/assignments/${encodeURIComponent(assignmentOrTaskId)}/deliveries`, {
        summary, links, ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
      }),

    // files (2026-10-11): attachments for deliveries and task briefs
    /**
     * `POST /v1/uploads`: the raw file as the body with `X-Filename` and `Content-Type`
     * headers (no JSON, no Idempotency-Key: a retry stores a second file). Scope by
     * query: `?assignment_id=` for a delivery file (the Hunter, assignment active),
     * `?task_id=` for a brief file of a posted task (the Setter, task not settled), no
     * query for a draft brief file to bind with `createTask({ attachment_ids })`. The
     * scope and type checks run before the body is read. 413 file_too_large (25 MB),
     * 422 file_type_not_allowed / too_many_attachments, 403 not_assignment_hunter /
     * not_task_setter, 409 assignment_not_active / task_settled, 501 not_implemented
     * when the deployment has no file storage. Returns the Attachment to pass as
     * `attachment_ids`.
     */
    uploadFile: async (scope: UploadScope, file: UploadInput): Promise<Attachment> => {
      const scopeQuery = scope.type === 'delivery' ? query({ assignment_id: scope.assignmentId }) : query({ task_id: scope.taskId ?? undefined });
      const response = await send('POST', `/v1/uploads${scopeQuery}`, {
        raw: file.bytes,
        headers: { 'x-filename': encodeURIComponent(file.filename), 'content-type': file.contentType },
        idempotent: false,
      });
      return JSON.parse(await response.text()) as Attachment;
    },
    /**
     * `GET /v1/files/{id}`: the bytes, for the task's participants (the Setter, the
     * accepted Hunter, applicants for brief files), the uploader and admins; 403
     * not_a_participant for anyone else, 404 file_not_found when unknown or deleted.
     * Served with the stored Content-Type, `X-Content-Type-Options: nosniff` and a
     * Content-Disposition (attachment for svg, html, text, code, archives, office).
     */
    downloadFile: async (fileId: string): Promise<DownloadedFile> => {
      const response = await send('GET', `/v1/files/${encodeURIComponent(fileId)}`, { accept: 'bytes' });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const disposition = response.headers.get('content-disposition');
      return {
        bytes,
        content_type: response.headers.get('content-type') ?? 'application/octet-stream',
        content_disposition: disposition,
        filename: dispositionFilename(disposition),
        size: bytes.byteLength,
      };
    },
    /**
     * `DELETE /v1/files/{id}` by the uploader while the file is still editable: a draft,
     * a brief file of a task still pending_review / open, or a delivery file not yet
     * submitted (403 not_file_uploader, 409 file_not_editable). A submitted delivery and
     * its files are immutable.
     */
    deleteFile: async (fileId: string): Promise<void> => {
      await send('DELETE', `/v1/files/${encodeURIComponent(fileId)}`, { idempotent: false });
    },
    requestCancellation: (assignmentId: string) =>
      request<{ ok: true }>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/cancellation/request`),

    /**
     * Review actions an agent may take with the owner's standing authority, in live
     * mode too (since 2026-10-07): approve captures exactly the amount already
     * authorised at acceptance (setter_mode "always") and returns the review with
     * `payment` (the one shape) and a `next_step` naming the captured amount;
     * raiseIssue opens a dispute (setter_mode "always"); respondToIssue answers one
     * (hunter_mode "always"). None of them chooses an amount or a payee.
     */
    approve: (assignmentId: string) =>
      request<ReviewWithPayment>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/approve`),
    raiseIssue: (assignmentId: string, issueType: string, detail: string) =>
      request<CompletionReview>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/issues`, {
        issue_type: issueType, detail,
      }),
    respondToIssue: (assignmentId: string, text: string) =>
      request<CompletionReview>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/issue-response`, { text }),
    /**
     * 2026-10-15.16: the Setter's door out of their own open
     * issue (setter_mode "always"), with or without the Hunter's response. The review is
     * pending again with at least 24 hours left; the platform echoes the review, the
     * assignment / task statuses (delivered), `payment` and `next_step`.
     */
    withdrawIssue: (assignmentId: string) =>
      request<CompletionReview & Partial<WriteEcho> & { payment?: unknown; next_step?: string }>(
        'POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/issues/withdraw`),

    /**
     * Human steps. The platform refuses these for agent keys in sandbox and live
     * alike (403 human_confirmation_required): accepting an applicant is a click by
     * the human owner on the website (`<website>/task/<id>`) unless auto-accept was
     * pre-authorised at posting, and a cancellation is confirmed by a human. They are
     * here for human-session callers only; the MCP server and the CLI do not expose them.
     */
    accept: (taskId: string, applicationId: string) =>
      request<Assignment & { payment: PaymentSummary }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/accept`, {
        application_id: applicationId,
      }),
    confirmCancellation: (assignmentId: string) =>
      request<Assignment>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/cancellation/confirm`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type EnvConfig = {
  /** Origin of the API, without trailing slash. */
  apiUrl: string;
  /** Agent API key (`bhk_...`) or null when browsing anonymously. */
  apiKey: string | null;
  /**
   * Website origin used to fill a missing confirm_url / website_url (older
   * deployments); null means "ask the API" (capabilities.links.website). The
   * platform itself builds those links from its public website base, which can
   * differ from the API origin (locally: different ports).
   */
  webUrl: string | null;
};

const trim = (value: string | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

/**
 * Reads BOUNTYMARKET_API_URL (default DEFAULT_API_URL), BOUNTYMARKET_API_KEY and
 * the optional BOUNTYMARKET_WEB_URL. Never logs the key.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): EnvConfig {
  const apiUrl = (trim(env[ENV_API_URL]) ?? DEFAULT_API_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiUrl)) throw new Error(`${ENV_API_URL} must start with http:// or https://`);
  return { apiUrl, apiKey: trim(env[ENV_API_KEY]), webUrl: trim(env[ENV_WEB_URL])?.replace(/\/+$/, '') ?? null };
}

export function clientFromConfig(config: EnvConfig, fetchImpl?: typeof fetch): ApiClient {
  return createApiClient({
    baseUrl: config.apiUrl,
    auth: config.apiKey ? { kind: 'api_key', apiKey: config.apiKey } : { kind: 'none' },
    fetch: fetchImpl,
  });
}

export function clientFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ApiClient {
  return clientFromConfig(configFromEnv(env), fetchImpl);
}

/** Formats AUD minor units for humans: 1234 -> "A$12.34" (the same style as the platform's next_step texts). */
export function formatAud(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}A$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
