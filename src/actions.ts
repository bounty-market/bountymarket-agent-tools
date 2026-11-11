/**
 * The marketplace actions shared by the MCP server and the CLI, implemented over
 * the public REST API. Each action returns the same document the hosted MCP tool
 * of the same name returns, so an agent sees one shape everywhere.
 *
 * The platform computes `website_url`, `participant`, `confirm_url`, `payment`,
 * `next_step` and `auto_accept_outcome` itself (REST and the hosted MCP share one
 * builder); these actions pass them through and only fill a missing field from the
 * same rules (src/tools.ts) when an older deployment leaves it out, so the
 * documents are complete either way. Two of those rules matter most: `confirm_url`
 * exists only when the account holder has one thing to do on the website, signed in, that an agent
 * key cannot do (next_step says what), and every `payment` block has one shape.
 */
import {
  ApiClientError, type ApiClient, type Assignment, type CreateTaskInput, type ListTasksParams, type PaymentSummary, type ReviewWithPayment,
  type LimitRequestInput, type TaskDetail, type UploadInput, type UploadScope, type WriteEcho,
} from './api.ts';
import {
  CANCEL_DONE_STEP, CANCEL_REPEAT_STEP, DISABLE_AUTO_ACCEPT_NEXT_STEP, RAISE_ISSUE_NEXT_STEP, RESPOND_TO_ISSUE_NEXT_STEP, WITHDRAW_ISSUE_NEXT_STEP,
  applyNextStep, approveNextStep, autoAcceptConfirmUrl, awaitsOwnerConfirmation, cancelNotOpenStep, confirmHint, confirmUrlFor, deliverNextStep, isRecord,
  EVENTS_POLL_AFTER_SECONDS, ownerAction, pendingHumanAction, postTaskConfirmUrl, postTaskNextStep, requestCancellationNextStep, taskUrl,
  type AutoAcceptState, type HumanActionState, type IssueType, type OwnerAction,
} from './tools.ts';

export type ActionsOptions = {
  /** Website origin for the confirm_url / website_url fallbacks; when null it is read once from the capabilities document. */
  webUrl?: string | null;
};

type Doc = Record<string, unknown>;

/** Splits GET /v1/tasks/:id into the task document, the participant member (block, null, or undefined when absent) and the top-level confirm_url. */
function splitTask(detail: TaskDetail): { task: Doc; participant: Doc | null | undefined; confirmUrl: string | null } {
  const { participant, confirm_url, ...task } = detail as TaskDetail & Doc;
  return {
    task,
    participant: participant === null ? null : isRecord(participant) ? participant : undefined,
    confirmUrl: typeof confirm_url === 'string' ? confirm_url : null,
  };
}

/** The task's auto_accept block as the API returns it, or undefined on a document that lacks it. */
function autoAcceptOf(task: Doc): AutoAcceptState | undefined {
  const block = task.auto_accept;
  return isRecord(block) ? { enabled: block.enabled === true, active: block.active === true } : undefined;
}

/** tasks.review_reasons (the Setter's own view, 2026-10-08): the screening categories that hold the listing for an online-only check; null otherwise. */
function reviewReasonsOf(task: Doc): string[] | null {
  const reasons = task.review_reasons;
  return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : null;
}

const NO_PAYMENT: PaymentSummary = {
  status: 'none', authorised_minor: 0, captured_minor: 0, refunded_minor: 0, hunter_fee_minor: 0, hunter_net_minor: 0, currency: 'AUD',
};

const PAYMENT_STATUSES = new Set(['none', 'held', 'captured', 'refunded', 'canceled', 'failed']);

/** Assignment statuses after which the contract is over (the platform's ENDED_ASSIGNMENT_STATUSES): no cancellation request can wait on them. */
const ENDED_ASSIGNMENT_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'expired']);
/** Task statuses with a live assignment, where a cancellation request can wait for the Setter. */
const ASSIGNED_TASK_STATUSES: ReadonlySet<string> = new Set(['assigned', 'delivered', 'issue_raised']);

/** participant.cancellation_requested_by as the platform sends it ('setter' | 'hunter'), else null. */
function requestedByOf(participant: Doc | null | undefined): 'setter' | 'hunter' | null {
  const by = participant?.cancellation_requested_by;
  return by === 'setter' || by === 'hunter' ? by : null;
}

/**
 * The one payment shape. The platform sends it complete; an older deployment's
 * block (participant `payment` without the fee fields, or the former assignment
 * detail with amount_minor / application_fee_minor) is folded into the same shape,
 * taking the Hunter's locked fee from the assignment when the block lacks it.
 */
function normalisePayment(raw: unknown, assignment?: Pick<Assignment, 'fee_minor'> | null): PaymentSummary {
  if (!isRecord(raw)) return { ...NO_PAYMENT };
  if (typeof raw.authorised_minor === 'number' && typeof raw.hunter_fee_minor === 'number' && typeof raw.hunter_net_minor === 'number') {
    return raw as unknown as PaymentSummary;
  }
  const given = String(raw.status ?? 'none');
  const status = (given === 'requires_capture' ? 'held' : given === 'partially_refunded' ? 'captured' : PAYMENT_STATUSES.has(given) ? given : 'none') as PaymentSummary['status'];
  const live = status === 'held' || status === 'captured' || status === 'refunded';
  const authorised = typeof raw.authorised_minor === 'number' ? raw.authorised_minor : live && typeof raw.amount_minor === 'number' ? raw.amount_minor : 0;
  const captured = typeof raw.captured_minor === 'number' ? raw.captured_minor : 0;
  const refunded = typeof raw.refunded_minor === 'number' ? raw.refunded_minor : 0;
  const fee = live ? Math.max(0, (typeof raw.application_fee_minor === 'number' ? raw.application_fee_minor : assignment?.fee_minor ?? 0)
    - (typeof raw.application_fee_refunded_minor === 'number' ? raw.application_fee_refunded_minor : 0)) : 0;
  const net = status === 'held' ? Math.max(0, authorised - fee) : live ? Math.max(0, captured - refunded - fee) : 0;
  return { status, authorised_minor: authorised, captured_minor: captured, refunded_minor: refunded, hunter_fee_minor: fee, hunter_net_minor: net, currency: 'AUD' };
}

/** A review as the platform returns it; an older deployment's review gains `approved_by` (null until approved; `auto` after auto-confirmation). */
function withApprovedBy<T extends Doc>(review: T): T {
  if ('approved_by' in review) return review;
  const approvedBy = review.status === 'auto_confirmed' ? { user_id: null, agent_id: null, kind: 'auto' } : null;
  return { ...review, approved_by: approvedBy };
}

/** The withdraw result as the platform sends it (2026-10-15.12), completed for an older deployment that answers { ok } only. */
function finishWithdraw(response: { ok: true; application?: { id: string; task_id?: string; status: string }; next_step?: string }, applicationId: string, taskId: string | null) {
  const application = response.application ?? { id: applicationId, ...(taskId ? { task_id: taskId } : {}), status: 'withdrawn' };
  return {
    ok: true as const,
    application,
    next_step: response.next_step ?? `Withdrawn: the Setter no longer sees this application and it no longer counts as your live application on task ${application.task_id ?? taskId ?? '(unknown)'}. `
      + 'You may apply to the task again while it is open (apply_to_task / POST /v1/tasks/{id}/applications); nothing was charged or held.',
  };
}

export function createActions(client: ApiClient, options: ActionsOptions = {}) {
  let website: Promise<string> | null = null;

  async function resolveWebsite(): Promise<string> {
    if (options.webUrl) return options.webUrl.replace(/\/+$/, '');
    try {
      const capabilities = await client.capabilities();
      const link = isRecord(capabilities.links) ? capabilities.links.website : undefined;
      if (typeof link === 'string' && link) return link.replace(/\/+$/, '');
    } catch {
      // fall through: the API origin is the best guess
    }
    return client.baseUrl;
  }

  const websiteUrl = () => (website ??= resolveWebsite());

  /** Every task document carries website_url (<website>/task/<id>); an older deployment's is filled from the same path. */
  async function withWebsiteUrl<T extends Doc>(task: T): Promise<T> {
    if (typeof task.website_url === 'string' || typeof task.id !== 'string') return task;
    return { ...task, website_url: taskUrl(await websiteUrl(), task.id) };
  }

  /** The one payment shape read back from the assignment; null when it cannot be read. */
  async function paymentOf(assignmentId: string, assignment?: Pick<Assignment, 'fee_minor'> | null): Promise<PaymentSummary | null> {
    try {
      const detail = await client.getAssignment(assignmentId);
      return detail.payment ? normalisePayment(detail.payment, detail.assignment ?? assignment) : null;
    } catch {
      return null;
    }
  }

  /**
   * The live assignment of a task, for the Setter-side and Hunter-side review
   * actions: the account's participant view of the task names it. Resolved the way
   * the hosted endpoint does (404 assignment_not_found when there is none).
   */
  async function liveAssignmentOf(taskId: string): Promise<Assignment> {
    return (await liveParticipationOf(taskId)).assignment;
  }

  /** liveAssignmentOf plus the account's side on it ('setter' or 'hunter'), from the same task read. */
  async function liveParticipationOf(taskId: string): Promise<{ assignment: Assignment; role: 'setter' | 'hunter' }> {
    const { participant } = splitTask(await client.getTask(taskId));
    const role = participant?.role === 'setter' || participant?.role === 'hunter' ? participant.role : null;
    const assignment = role && isRecord(participant!.assignment)
      ? (participant!.assignment as unknown as Assignment)
      : null;
    if (!role || !assignment || assignment.status === 'cancelled' || assignment.status === 'expired') {
      throw new ApiClientError(404, 'assignment_not_found', 'This task has no live assignment that your account is part of.');
    }
    return { assignment, role };
  }

  /**
   * The account's side on an assignment it can read (so it is its Setter or its Hunter): the Setter when the
   * task's participant block says so, as the hosted tool checks the Setter first; the Hunter otherwise. A deployment
   * without the block is answered from GET /v1/me (the Hunter is the assignment's hunter_user_id).
   */
  async function sideOf(taskId: string, assignment: Assignment): Promise<'setter' | 'hunter'> {
    const { participant } = splitTask(await client.getTask(taskId));
    if (participant) return participant.role === 'setter' ? 'setter' : 'hunter';
    const me = await client.me();
    return me.id === assignment.hunter_user_id ? 'hunter' : 'setter';
  }

  /**
   * The participant block as the hosted get_task returns it: every field present
   * in every status, confirm_url only while an action only the account holder can take is pending. The
   * platform sends it complete; an older deployment's block is completed here from
   * the same rules.
   */
  async function completeParticipant(task: Doc, participant: Doc, topConfirmUrl: string | null) {
    const role = participant.role === 'setter' || participant.role === 'hunter' ? participant.role : 'applicant';
    const view: Doc = { role };
    const applications = Array.isArray(participant.applications) ? participant.applications as Doc[] : [];
    if (role === 'setter') view.applications = applications;
    const myApplication = participant.my_application ?? participant.application ?? null;
    if (role !== 'setter') view.my_application = myApplication;
    const assignment = isRecord(participant.assignment) ? participant.assignment as unknown as Assignment : null;
    view.assignment = assignment;
    view.deliveries = Array.isArray(participant.deliveries) ? participant.deliveries : [];
    view.review = isRecord(participant.review) ? withApprovedBy(participant.review) : null;
    view.payment = normalisePayment(participant.payment, assignment);

    const status = String(task.status);
    const autoAccept = autoAcceptOf(task);
    const pending = applications.filter((a) => a.status === 'pending');
    const skippedReasons = pending.map((a) => a.auto_accept_skipped_reason).filter((r): r is string => typeof r === 'string');
    const taskFacts = {
      status, delivery_hours: Number(task.delivery_hours ?? 0), bounty_minor: Number(task.bounty_minor ?? 0), review_reasons: reviewReasonsOf(task),
    };
    const step = typeof participant.next_step === 'string' ? participant.next_step
      : typeof participant.confirm_hint === 'string' ? participant.confirm_hint
        : confirmHint(role, taskFacts, autoAccept, { pendingApplications: pending.length, skippedReasons });
    view.next_step = step;
    view.confirm_hint = typeof participant.confirm_hint === 'string' ? participant.confirm_hint : step;
    // agent_authority (platform 2026-10-11.6): { setter_mode, hunter_mode } of the key, null for a human session; null when an older deployment omits it.
    view.agent_authority = isRecord(participant.agent_authority) ? participant.agent_authority : null;

    // The platform's confirm_url follows the rule; a short block gets the same rule applied to what it shows
    // (the website is only looked up when the rule says the account holder has a click to make).
    const given = typeof participant.confirm_url === 'string' ? participant.confirm_url : topConfirmUrl;
    const taskId = String(task.id);
    const humanState = { status, autoAccept, pendingApplications: pending.length, liveAssignment: !!assignment && assignment.status !== 'cancelled' && assignment.status !== 'expired' };
    const confirmUrl = given ?? (pendingHumanAction(role, humanState) ? confirmUrlFor(await websiteUrl(), taskId, role, humanState) : null);
    if (confirmUrl) view.confirm_url = confirmUrl;
    if (role === 'setter' && awaitsOwnerConfirmation(autoAccept)) {
      view.auto_accept_status = 'pending_owner_confirmation';
      view.auto_accept_confirm_url = typeof participant.auto_accept_confirm_url === 'string'
        ? participant.auto_accept_confirm_url
        : autoAcceptConfirmUrl(await websiteUrl(), taskId);
    }
    return { view, confirmUrl };
  }

  /** pending_owner_action for one row once the state is known: the website is looked up only when something waits. */
  async function rowAction(taskId: string, role: 'setter' | 'hunter', state: HumanActionState): Promise<OwnerAction> {
    if (!pendingHumanAction(role, state)) return { pending_owner_action: null };
    return ownerAction(await websiteUrl(), taskId, role, state);
  }

  /**
   * list_my_tasks row (platform 2026-11-10): GET /v1/me/tasks carries the status, the auto-accept terms and
   * work.pending_applications; only a task with a Hunter on it (or an older deployment without `work`) needs its
   * participant view read, for who asked to cancel. A view that cannot be read shows nothing pending.
   */
  async function setterRowAction(task: Doc): Promise<OwnerAction> {
    const status = String(task.status);
    const taskId = String(task.id);
    const work = isRecord(task.work) ? task.work : null;
    const knownPending = work && typeof work.pending_applications === 'number' ? work.pending_applications : null;
    const state: HumanActionState = { status, autoAccept: autoAcceptOf(task), pendingApplications: knownPending ?? 0, cancellationRequestedBy: null, liveAssignment: false };
    if (ASSIGNED_TASK_STATUSES.has(status) || (status === 'open' && knownPending === null)) {
      try {
        const { participant } = splitTask(await client.getTask(taskId));
        if (participant) {
          if (knownPending === null && Array.isArray(participant.applications)) {
            state.pendingApplications = (participant.applications as Doc[]).filter((a) => a.status === 'pending').length;
          }
          const assignment = isRecord(participant.assignment) ? participant.assignment : null;
          state.liveAssignment = !!assignment && !ENDED_ASSIGNMENT_STATUSES.has(String(assignment.status));
          state.cancellationRequestedBy = requestedByOf(participant);
        }
      } catch {
        // the view could not be read: nothing is shown as pending rather than a guess
      }
    }
    return rowAction(taskId, 'setter', state);
  }

  /** list_my_assignments row: only an active or delivered assignment can carry the Setter's cancellation request for the account holder to confirm. */
  async function hunterRowAction(assignment: Doc): Promise<OwnerAction> {
    if (assignment.status !== 'active' && assignment.status !== 'delivered') return { pending_owner_action: null };
    const taskId = typeof assignment.task_id === 'string' ? assignment.task_id : isRecord(assignment.task) ? String(assignment.task.id) : null;
    if (!taskId) return { pending_owner_action: null };
    try {
      const { task, participant } = splitTask(await client.getTask(taskId));
      if (!participant || participant.role !== 'hunter') return { pending_owner_action: null };
      return rowAction(taskId, 'hunter', {
        status: String(task.status), autoAccept: undefined, pendingApplications: 0, cancellationRequestedBy: requestedByOf(participant), liveAssignment: true,
      });
    } catch {
      return { pending_owner_action: null };
    }
  }

  return {
    websiteUrl,

    capabilities: () => client.capabilities(),

    rules: () => client.policy(),

    /**
     * `fields: 'summary'`, the filters and `sort` (platform 2026-10-15.12) pass through;
     * with a key every row carries my_application / my_assignment as the platform sends them.
     */
    async searchTasks(params: Omit<ListTasksParams, 'before'>) {
      const { tasks } = await client.listTasks({ ...params, status: params.status ?? 'open' });
      return { tasks, count: tasks.length };
    },

    /**
     * Withdraws the account's pending application (platform 2026-10-15.12 echoes it and a
     * next_step). `id` is the application id, or a task id: when the platform answers
     * application_not_pending for an unknown id, the account's pending application on that
     * task (get_task participant.my_application) is resolved and withdrawn instead.
     */
    async withdrawApplication(id: string) {
      let applicationId = id;
      let taskId: string | null = null;
      try {
        return finishWithdraw(await client.withdrawApplication(applicationId), applicationId, null);
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'application_not_pending') throw error;
      }
      const detail = await client.getTask(id).catch(() => null);
      const mine = detail?.participant && 'my_application' in detail.participant ? detail.participant.my_application : null;
      if (!detail || !mine || mine.status !== 'pending') {
        throw new ApiClientError(404, 'application_not_found',
          `No pending application on your account under id ${id} (as an application id or a task id).`,
          { application_id: id, task_id: id },
          'Pass the application id from apply (application.id) or the task id of a task your account applied to and has not been accepted on.');
      }
      applicationId = mine.id;
      taskId = detail.id;
      return finishWithdraw(await client.withdrawApplication(applicationId), applicationId, taskId);
    },

    /**
     * Public listing (with website_url) for anyone. With a key, `participant` is
     * always present: the block for the account's side of the task (role,
     * applications or my_application, assignment, deliveries, review, payment,
     * next_step, confirm_hint and, only while an action only the account holder can take is pending,
     * confirm_url, copied to the top level) or null when the key takes no part.
     */
    async getTask(taskId: string) {
      const { task: raw, participant, confirmUrl: top } = splitTask(await client.getTask(taskId));
      const task = await withWebsiteUrl(raw);
      const result: Doc = { task };
      if (participant === null || (participant === undefined && client.hasAuth())) return { ...result, participant: null };
      if (!participant) return result;
      const { view, confirmUrl } = await completeParticipant(task, participant, top);
      result.participant = view;
      if (confirmUrl) result.confirm_url = confirmUrl;
      return result;
    },

    /**
     * Posts the task. The result carries the task (with website_url) and next_step
     * (the same text get_task returns for that state), and confirm_url only while an
     * agent-requested auto-accept waits for the account holder's one click (then also
     * auto_accept_status). Without confirm_url nothing needs a click on the website.
     */
    async postTask(input: CreateTaskInput) {
      const { auto_accept_status, confirm_url, next_step, ...created } = await client.createTask(input);
      const task = await withWebsiteUrl(created as unknown as Doc);
      const autoAccept = autoAcceptOf(task);
      const awaitingOwner = auto_accept_status === 'pending_owner_confirmation' || awaitsOwnerConfirmation(autoAccept);
      // confirm_url only while the account holder has the one click to make; the website is looked up only then.
      const posted = { id: String(task.id), status: String(task.status) };
      const requested = awaitingOwner ? { enabled: true, active: false } : autoAccept;
      const needsClick = pendingHumanAction('setter', { status: posted.status, autoAccept: requested, pendingApplications: 0 }) !== null;
      const confirmUrl = typeof confirm_url === 'string'
        ? confirm_url
        : needsClick ? postTaskConfirmUrl(await websiteUrl(), posted, requested) : null;
      return {
        task,
        next_step: typeof next_step === 'string'
          ? next_step
          : postTaskNextStep({
            status: String(task.status), delivery_hours: Number(task.delivery_hours ?? 0), bounty_minor: Number(task.bounty_minor ?? 0),
            review_reasons: reviewReasonsOf(task),
          }, autoAccept),
        ...(awaitingOwner ? { auto_accept_status: 'pending_owner_confirmation' as const } : {}),
        ...(confirmUrl ? { confirm_url: confirmUrl } : {}),
      };
    },

    /**
     * Dry run of post_task (`validate_only: true`): every check runs (screening,
     * caps, auto-accept rules) and nothing is created. Returns the platform's
     * { valid: true, would_create, warnings }; a failed check is the ordinary error.
     */
    async validateTask(input: CreateTaskInput) {
      const result = await client.validateTask(input);
      return result as unknown as Doc;
    },

    /**
     * Setter side (setter_mode "always"): withdraws the auto-accept opt-in. Pending
     * applications stay pending. The result carries the same state-aware next_step
     * and confirm_url rule as get_task: confirm_url only when the account holder now has an
     * applicant to accept by hand (or another click only they can make), so the agent is
     * not sent to a page with nothing on it.
     */
    async disableAutoAccept(taskId: string) {
      const task = await withWebsiteUrl(await client.disableAutoAccept(taskId) as unknown as Doc);
      let step: string | null = null;
      let confirmUrl: string | null = null;
      try {
        const { task: fresh, participant, confirmUrl: top } = splitTask(await client.getTask(String(task.id)));
        if (participant) {
          const completed = await completeParticipant(fresh, participant, top);
          step = `Auto-accept is off. ${String(completed.view.next_step)}`;
          confirmUrl = completed.confirmUrl;
        }
      } catch {
        // the view could not be read back: the generic next_step below still holds
      }
      return {
        task,
        ...(confirmUrl ? { confirm_url: confirmUrl } : {}),
        next_step: step ?? DISABLE_AUTO_ACCEPT_NEXT_STEP,
      };
    },

    /**
     * The application as the hosted tool returns it, with `assignment` (null while
     * pending), `auto_accept_outcome`, a matching `next_step` and, only once accepted,
     * `payment` (the hold, the one shape; platform 2026-10-11.6). An older deployment
     * that omits the block gets it folded from the assignment's locked fee.
     */
    async applyToTask(taskId: string, message?: string) {
      const { assignment, auto_accept_outcome, payment: rawPayment, next_step, ...application } = await client.apply(taskId, message);
      const attached = isRecord(assignment) ? (assignment as unknown as Assignment) : null;
      const outcome = typeof auto_accept_outcome === 'string'
        ? auto_accept_outcome
        : (application.status === 'accepted' || attached ? 'accepted' : 'not_enabled');
      const payment = attached
        ? (isRecord(rawPayment) ? normalisePayment(rawPayment, attached) : normalisePayment({ status: 'held', authorised_minor: attached.bounty_minor }, attached))
        : null;
      return {
        application,
        assignment: attached,
        auto_accept_outcome: outcome,
        ...(payment ? { payment } : {}),
        next_step: typeof next_step === 'string' ? next_step : applyNextStep(outcome, attached),
      };
    },

    /**
     * The account's tasks as GET /v1/me/tasks sends them, each with pending_owner_action ({ kind, confirm_url } or null)
     * and, only when one is pending, a short next_step, as the hosted list_my_tasks (platform 2026-11-10).
     */
    async listMyTasks() {
      const { tasks } = await client.myTasks();
      const rows = await Promise.all(tasks.map(async (task) => ({ ...task, ...(await setterRowAction(task as unknown as Doc)) })));
      return { tasks: rows, count: rows.length };
    },

    /** The account's assignments as the Hunter, each with pending_owner_action (the Setter's cancellation request to confirm) as on the hosted tool. */
    async listMyAssignments() {
      const { assignments } = await client.myAssignments();
      const rows = await Promise.all(assignments.map(async (a) => ({ ...a, ...(await hunterRowAction(a as unknown as Doc)) })));
      return { assignments: rows, count: rows.length };
    },

    /**
     * Setter side (setter_mode "always"; platform 2026-11-10): cancels the account's open or
     * pending_review task. The result is the hosted cancel_task's { task, already_cancelled, next_step }; a repeat
     * on a task the account already cancelled answers already_cancelled true and changes nothing. A task past open is
     * 409 task_not_open with the cancel-specific next_step (a task with a Hunter ends by request_cancellation).
     */
    async cancelTask(taskId: string) {
      let response: Doc;
      try {
        response = await client.cancelTask(taskId) as unknown as Doc;
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'task_not_open') throw error;
        // An older deployment answers a repeat with 409 task_not_open: the account's own cancelled listing is the idempotent
        // answer. A task that had an assignment ended by a mutual cancellation, not by cancel_task: that stays the refusal.
        const status = isRecord(error.details) ? error.details.task_status : undefined;
        if (status === 'cancelled') {
          const repeat = await client.getTask(taskId).then(splitTask).catch(() => null);
          if (repeat?.participant?.role === 'setter' && repeat.participant.assignment === null && repeat.task.status === 'cancelled') {
            return { task: await withWebsiteUrl(repeat.task), already_cancelled: true, next_step: CANCEL_REPEAT_STEP };
          }
        }
        if (error.nextStep !== undefined) throw error;
        throw new ApiClientError(error.status, error.code, error.message, error.details, cancelNotOpenStep(error.details), error.retryable);
      }
      const { already_cancelled, next_step, ...task } = response;
      const repeat = already_cancelled === true;
      return {
        task: await withWebsiteUrl(task),
        already_cancelled: repeat,
        next_step: typeof next_step === 'string' ? next_step : repeat ? CANCEL_REPEAT_STEP : CANCEL_DONE_STEP,
      };
    },

    /**
     * Either side (the authority of the key's side, "always"; platform 2026-11-10): asks for a mutual
     * cancellation of an accepted assignment, by assignment id or by the task id (the account's live assignment on it).
     * Nothing changes until the other side confirms on the website, signed in; confirming is never a tool. The result is
     * the hosted request_cancellation's { ok, assignment { id, status }, task_id, requested_by, next_step }.
     */
    async requestCancellation(target: { assignmentId?: string | null; taskId?: string | null }) {
      // The side is worked out before the write, as the hosted tool does: a read that fails here changes nothing,
      // and nothing is read after the write (a successful request is never reported as an error).
      let assignment: Assignment;
      let taskId: string;
      let role: 'setter' | 'hunter';
      if (target.assignmentId) {
        // GET /v1/assignments/{id} answers only the Setter or the Hunter of that assignment (403 not_a_participant).
        const detail = await client.getAssignment(target.assignmentId);
        assignment = detail.assignment;
        taskId = String(assignment.task_id ?? detail.task.id);
        role = await sideOf(taskId, assignment);
      } else {
        taskId = String(target.taskId);
        ({ assignment, role } = await liveParticipationOf(taskId));
      }
      // The platform checks the participant and the side's authority (403 not_a_participant, agent_*_authority_denied).
      await client.requestCancellation(assignment.id);
      return {
        ok: true as const,
        assignment: { id: assignment.id, status: assignment.status },
        task_id: taskId,
        requested_by: role,
        next_step: requestCancellationNextStep(role),
      };
    },

    /** The account's money ledger, both sides (platform 2026-10-15.11): returned as the platform sends it. */
    getMoney: () => client.myMoney(),

    /**
     * Delivers by assignment id or by task id (the platform resolves the account's live
     * assignment on that task). A miss is the platform's 404 assignment_not_found,
     * written for deliver and naming the pending application if any. `attachmentIds`
     * are files uploaded beforehand with `uploadFile({ type: 'delivery', assignmentId })`
     * (2026-10-11); they become `delivery.attachments` and are covered by the digest.
     * The result carries the review, the payment (the one shape; what the Hunter will
     * receive) and next_step with the amounts.
     */
    async submitDelivery(assignmentOrTaskId: string, summary: string, links: string[] = [], attachmentIds: string[] = []) {
      const response = await client.deliver(assignmentOrTaskId, summary, links, attachmentIds);
      const { payment: rawPayment, next_step, delivery, assignment, task, ...review } = response as ReviewWithPayment & Partial<WriteEcho> & Doc;
      const assignmentId = typeof review.assignment_id === 'string' ? review.assignment_id : assignmentOrTaskId;
      // The platform computes and stores the digest. Since 2026-10-15.12 the response echoes the delivery record
      // (content_digest, attachments with sha256) and the new statuses; only an older deployment needs the read-back.
      const echoed = isRecord(delivery) && typeof delivery.content_digest === 'string';
      let contentDigest: string | null = echoed ? (delivery.content_digest as string) : null;
      let detail: Awaited<ReturnType<ApiClient['getAssignment']>> | null = null;
      if (!echoed) {
        try {
          detail = await client.getAssignment(assignmentId);
          contentDigest = detail.deliveries.find((d) => d.id === review.delivery_id)?.content_digest ?? null;
        } catch {
          detail = null;
        }
      }
      const payment = isRecord(rawPayment)
        ? normalisePayment(rawPayment, detail?.assignment)
        : detail?.payment ? normalisePayment(detail.payment, detail.assignment) : null;
      return {
        assignment_id: assignmentId,
        review: withApprovedBy(review),
        content_digest: contentDigest,
        delivery: isRecord(delivery) ? delivery : detail?.deliveries.find((d) => d.id === review.delivery_id) ?? null,
        assignment: isRecord(assignment) ? assignment : detail ? { id: detail.assignment.id, status: detail.assignment.status } : null,
        task: isRecord(task) ? task : detail ? { id: detail.task.id, status: detail.task.status } : null,
        payment,
        next_step: typeof next_step === 'string' ? next_step : deliverNextStep(review as { review_deadline_at?: string | null }, payment),
      };
    },

    /**
     * Setter side (setter_mode "always"): approves the delivery on the account's task.
     * Captures exactly the amount already authorised at acceptance; nothing more is
     * charged and no amount or payee is chosen here. The result carries the review
     * (approved_by names the agent), the payment (the one shape; the fee is the
     * Hunter's) and next_step with the amount.
     */
    async approveDelivery(taskId: string) {
      const assignment = await liveAssignmentOf(taskId);
      const response = await client.approve(assignment.id);
      const { payment: rawPayment, next_step, delivery, assignment: echoedAssignment, task, ...review } = response as ReviewWithPayment & Partial<WriteEcho> & Doc;
      const payment = isRecord(rawPayment) ? normalisePayment(rawPayment, assignment) : await paymentOf(assignment.id, assignment);
      // The echo (2026-10-15.12): task approved, assignment completed, the approved delivery; completed from what is known otherwise.
      return {
        review: withApprovedBy(review),
        delivery: isRecord(delivery) ? delivery : null,
        assignment: isRecord(echoedAssignment) ? echoedAssignment : { id: assignment.id, status: 'completed' },
        task: isRecord(task) ? task : { id: taskId, status: 'approved' },
        payment,
        next_step: typeof next_step === 'string' ? next_step : approveNextStep(payment),
      };
    },

    /** Setter side (setter_mode "always"): raises an issue before review.review_deadline_at (24 hours after delivery by default). */
    async raiseIssue(taskId: string, issueType: IssueType | string, text: string) {
      const assignment = await liveAssignmentOf(taskId);
      const review = await client.raiseIssue(assignment.id, issueType, text);
      return { review: withApprovedBy(review as unknown as Doc), next_step: RAISE_ISSUE_NEXT_STEP };
    },

    /** Hunter side (hunter_mode "always"): the one response to an open issue, within 24 hours. */
    async respondToIssue(taskId: string, text: string) {
      const assignment = await liveAssignmentOf(taskId);
      const review = await client.respondToIssue(assignment.id, text);
      return { review: withApprovedBy(review as unknown as Doc), next_step: RESPOND_TO_ISSUE_NEXT_STEP };
    },

    /**
     * Setter side (setter_mode "always", 2026-10-15.16): withdraws the account's open issue on
     * the task's live assignment, with or without the Hunter's response. The review is
     * pending again with at least 24 hours left; the platform echoes the assignment / task
     * statuses (delivered), the payment (still the hold) and next_step with the deadline.
     * Nothing is captured by a withdrawal.
     */
    async withdrawIssue(taskId: string) {
      const assignment = await liveAssignmentOf(taskId);
      const response = await client.withdrawIssue(assignment.id);
      const { payment: rawPayment, next_step, assignment: echoedAssignment, task, delivery: _delivery, ...review } = response as Record<string, unknown>;
      return {
        review: withApprovedBy(review as Doc),
        assignment: isRecord(echoedAssignment) ? echoedAssignment : { id: assignment.id, status: 'delivered' },
        task: isRecord(task) ? task : { id: taskId, status: 'delivered' },
        payment: isRecord(rawPayment) ? normalisePayment(rawPayment, assignment) : await paymentOf(assignment.id, assignment),
        next_step: typeof next_step === 'string' ? next_step : WITHDRAW_ISSUE_NEXT_STEP,
      };
    },

    /** `taskId` follows one task only (the cursor still advances over its events). */
    async getEvents(after = 0, limit = 100, taskId?: string | null) {
      const { events, next_after, poll_after_seconds } = await client.events(after, limit, taskId);
      // poll_after_seconds (platform 2026-10-15.12): the server's suggested wait; the default for an older deployment.
      return {
        events,
        next_after: next_after ?? (events.at(-1)?.seq ?? after),
        poll_after_seconds: typeof poll_after_seconds === 'number' ? poll_after_seconds : EVENTS_POLL_AFTER_SECONDS,
      };
    },

    /**
     * Files (2026-10-11). Not MCP tools: binary never travels over MCP. The CLI and
     * library callers upload over REST and pass the returned id as attachment_ids to
     * submitDelivery / postTask; the result is the Attachment plus a next_step saying
     * how to attach it.
     */
    async uploadFile(scope: UploadScope, file: UploadInput) {
      const attachment = await client.uploadFile(scope, file);
      const nextStep = scope.type === 'delivery'
        ? `Uploaded for assignment ${scope.assignmentId}. Pass the id as attachment_ids in submit_delivery (CLI: deliver ... --attach ${attachment.id}); `
          + 'the Setter downloads it at GET /v1/files/{id} once the delivery is submitted. Not yet attached: DELETE /v1/files/{id} removes it until then.'
        : scope.taskId
          ? `Attached to task ${scope.taskId} as a brief file: applicants and participants can download it at GET /v1/files/{id}. `
            + 'DELETE /v1/files/{id} removes it while the task is pending_review or open.'
          : `Uploaded as a draft brief file. Pass the id as attachment_ids in post_task (CLI: tasks post ... --attach ${attachment.id}); `
            + 'until then only you can read it, and it is swept after 20 days if never attached.';
      return { attachment, next_step: nextStep };
    },

    downloadFile: (fileId: string) => client.downloadFile(fileId),

    async deleteFile(fileId: string) {
      await client.deleteFile(fileId);
      return { ok: true as const, file_id: fileId };
    },

    me: () => client.me(),

    /**
     * request_limit (platform 2026-10-19.2): asks the founder for a higher limit for the account
     * (level 1 one task, 2 an account line, 3 a long-term line). The platform paces the filings and answers with the
     * request and a next_step; the decision arrives as limit_request.approved / declined events (and mail to the account holder).
     */
    async requestLimit(input: LimitRequestInput) {
      const response = await client.createLimitRequest(input);
      return {
        request: response.request,
        next_step: typeof response.next_step === 'string' ? response.next_step : REQUEST_LIMIT_NEXT_STEP,
      };
    },

    /**
     * The account's limit-request document (GET /v1/me/limit-requests; the same object as
     * me.limit_requests): the open request, the latest requests, the lines in force
     * (active_overrides, effective per side), the pacing and the rules. No MCP tool of its
     * own (me folds it in); the CLI `limit-requests` prints it.
     */
    myLimitRequests: () => client.myLimitRequests(),

    /**
     * Withdraw the account's pending limit request (DELETE /v1/me/limit-requests/{id}). Only a
     * pending one (409 limit_request_not_pending otherwise); it still counts toward the three
     * filings per 30 days.
     */
    async withdrawLimitRequest(requestId: string) {
      const response = await client.withdrawLimitRequest(requestId);
      return {
        request: response.request,
        next_step: typeof response.next_step === 'string' ? response.next_step : WITHDRAW_LIMIT_NEXT_STEP,
      };
    },
  };
}

/**
 * request_limit next_step (fallback) when an older deployment answers with the bare request: the hosted tool's words, word for
 * word (the account holder since platform 2026-11-12.1); it changes when the platform's does.
 */
const REQUEST_LIMIT_NEXT_STEP = 'Filed for the account holder. The founder answers in the console, normally within 24 hours: watch get_events for limit_request.approved / '
  + 'limit_request.declined (the account holder is emailed too); unanswered for 7 days it expires. me.limit_requests lists it and the lines in force. Tell the account holder what was asked and why.';

/** Withdraw next_step (fallback) when an older deployment answers with the bare request. */
const WITHDRAW_LIMIT_NEXT_STEP = 'Withdrawn; nothing waits for the founder. It still counts toward the three filings per 30 days, so file one request for everything '
  + 'the account needs. me.limit_requests shows the pacing (can_request_now, next_allowed_at).';

export type Actions = ReturnType<typeof createActions>;
