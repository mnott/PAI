/**
 * types.ts — Task Bus type definitions
 *
 * Defines the provider registry, ownership resolution, and configuration schema
 * for PAI's cross-session task subsystem.
 *
 * The task bus routes work between PAI sessions through an external tracker.
 * A session files a task; a routine reads it later and dispatches it to the
 * session that owns it — spawning one if none is running.
 *
 * See Notes/docs/task-bus.md for the architecture and its constraints.
 */

// ---------------------------------------------------------------------------
// Provider identifiers
// ---------------------------------------------------------------------------

export type ProviderId = "todoist";

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Prefix marking a tracker label as a PAI ownership assertion.
 * A task labelled `pai:acme-api` is owned by the `acme-api` project.
 */
export const OWNER_LABEL_PREFIX = "pai:";

/**
 * How a task's owner was determined. Recorded so the routine can explain
 * itself, and so a mis-resolution is diagnosable rather than silent.
 *
 * - "label"     — an explicit `pai:<project>` label (authoritative)
 * - "container" — the enclosing sub-project name matched a PAI alias (fallback)
 * - "none"      — unresolved; the task stays in the findings inbox
 */
export type OwnerSource = "label" | "container" | "none";

export interface TaskOwner {
  /** Resolved PAI project short name, e.g. "acme-api". Null when UNROUTED. */
  project: string | null;
  /** Absolute path to the project root. Null when UNROUTED. */
  rootPath: string | null;
  source: OwnerSource;
  /**
   * The raw string that resolution was attempted against, kept for diagnostics
   * when `source` is "none" — e.g. a "Reading List 📚" container matches no
   * PAI project, which is expected rather than a fault.
   */
  rawHint?: string;
}

/** An unresolved owner. UNROUTED is a normal state, not an error. */
export const UNROUTED: TaskOwner = {
  project: null,
  rootPath: null,
  source: "none",
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskPriority = "p1" | "p2" | "p3" | "p4";

export interface Task {
  /** Provider-native task ID. Opaque; never parsed. */
  id: string;
  title: string;
  /**
   * Full procedure AND reasoning — enough that the task is actionable months
   * later, or by the user alone, without re-deriving anything. Enforced at
   * filing time rather than left to discipline.
   */
  body: string;
  owner: TaskOwner;
  /** ISO 8601 date or datetime. Null when the task has no due date. */
  due: string | null;
  /**
   * The tracker's own recurrence text, e.g. "every day at 08:00". Null for a
   * one-off.
   *
   * Kept verbatim rather than parsed into a rule because it is also the only
   * way to write a recurrence back: Todoist re-parses this string, and it is
   * what lets a due date be restored without destroying the recurrence.
   */
  recurrence?: string | null;
  priority: TaskPriority;
  labels: string[];
  /**
   * Stable reference to the artifact this task is about. Prefer a `hook://`
   * URL over a filesystem path — it survives renames and moves, and opens in
   * DEVONthink To Go on iOS.
   */
  sourceUrl?: string;
  /** True for organizational headers that cannot be completed. */
  isHeader?: boolean;
}

/** A task being filed. `owner` is a project short name, resolved on write. */
export interface NewTask {
  title: string;
  body: string;
  owner?: string | null;
  due?: string;
  priority?: TaskPriority;
  labels?: string[];
  sourceUrl?: string;
  /**
   * Sub-project to file into, created if absent.
   *
   * The convention is one sub-project per PAI project under the bus root. It
   * previously existed only in the shape of the data, so every session had to
   * re-derive it — and a session that inferred cautiously filed flat instead,
   * which is exactly the pile the convention prevents.
   */
  into?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Only tasks due on or before this ISO date. Omit for all open tasks. */
  dueBefore?: string;
  /** Restrict to one resolved owner. Omit for every owner. */
  owner?: string;
  /** Include tasks that resolved to UNROUTED. Default: true. */
  includeUnrouted?: boolean;
  limit?: number;
}

export interface TaskProvider {
  readonly providerId: ProviderId;

  /**
   * False when no credential is configured. The bus degrades to a no-op
   * rather than failing — a user without a tracker still gets working PAI.
   */
  isConfigured(): boolean;

  listOpen(opts: ListOptions): Promise<Task[]>;
  add(task: NewTask): Promise<Task>;
  complete(id: string): Promise<void>;

  /**
   * Rewrite a task's due date through the tracker's natural-language field.
   *
   * Optional, and deliberately expressed as a string rather than a date: a
   * recurring task's schedule and its next occurrence are the same field, so
   * moving the date without the rule silently downgrades a routine to a one-off.
   * A provider that cannot express both at once should not offer this.
   */
  setDue?(id: string, dueString: string): Promise<void>;

  /**
   * Sub-projects under the bus root — the set of addresses a task can be filed
   * against, one per session.
   *
   * Optional because it is not universal: a tracker may address work by tag or
   * list rather than by nested project, and forcing a nesting concept onto one
   * that has none would mean faking it. A provider without these simply does
   * not offer session-scoped inboxes, and callers say so rather than failing.
   */
  listSubProjects?(): Promise<Array<{ id: string; name: string }>>;
  findOrCreateSubProject?(name: string): Promise<{ id: string; created: boolean }>;

  /**
   * The comment thread on a task, oldest first.
   *
   * Optional because not every tracker has threaded comments. Where it exists,
   * the thread is usually where the reasoning lives — the question, the answer,
   * the correction — and completing the task takes it out of view. That is what
   * the archive exists to keep.
   */
  listComments?(taskId: string): Promise<Array<{ id: string; content: string; postedAt?: string }>>;

  /**
   * One task by id, whether open or completed.
   *
   * Needed because archiving runs at or after completion, and a completed task
   * is gone from `listOpen` — which is exactly the moment its discussion stops
   * being visible and most needs keeping.
   */
  getTask?(id: string): Promise<Task | null>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TodoistProviderConfig {
  enabled: boolean;
  /**
   * API token. Resolution order is apiKey → TODOIST_API_KEY env → unconfigured.
   *
   * Never read this from another tool's config file. PAI ships as a product;
   * scraping ~/.claude.json for a key belonging to the Todoist MCP is not
   * acceptable even though the key is sitting there.
   */
  apiKey?: string;
  /**
   * Tracker project ID that roots the bus (the "Claude 🤖" project).
   *
   * Stored as an ID, never a name. Todoist's project search silently returns
   * zero results for names containing emoji — resolving by name would report
   * "no tasks" instead of failing, which is the exact class of silent failure
   * this subsystem exists to surface.
   */
  rootProjectId?: string;
  /** Section ID for the findings inbox. Tasks land here when UNROUTED. */
  findingsSectionId?: string;
}

export interface TaskConfig {
  /** Master switch. When false the bus is inert. */
  enabled: boolean;
  providers: {
    todoist: TodoistProviderConfig;
  };
  /**
   * Dispatch work to the owning session automatically, spawning one if absent.
   * Requires AIBroker. When false — or when AIBroker is unavailable — PAI
   * reports which project owns each task and leaves acting to the user.
   */
  autoDispatch: boolean;

  /**
   * Seconds AIBroker may spend on a single dispatch, spawn included.
   *
   * Passed down to the transport so both sides share one deadline. Raise it on
   * a loaded machine where sessions are slow to start accepting input.
   */
  dispatchTimeoutSecs?: number;

  /**
   * Project a task goes to when it carries the bare `pai` marker and its
   * location says nothing — an Inbox capture, typically.
   *
   * This is the one thing a task's location cannot express: "an AI should take
   * this, and I do not know which one yet". Everything else is answered by the
   * project the task sits in.
   *
   * Unset means such a task stays UNROUTED, which is a legitimate choice: it
   * then surfaces in the findings inbox for triage rather than being guessed at.
   */
  defaultOwner?: string;
}

export const DEFAULT_TASK_CONFIG: TaskConfig = {
  enabled: false,
  providers: {
    todoist: {
      enabled: false,
    },
  },
  autoDispatch: false,
};

// ---------------------------------------------------------------------------
// Dispatch results
// ---------------------------------------------------------------------------

/**
 * What happened to one task during a dispatch run.
 *
 * - "delivered"    — sent to an already-running session, and confirmed submitted
 * - "queued"       — typed into a live session that was mid-turn, so submission
 *                    could not be confirmed inside the window. This is delivery:
 *                    Claude Code holds typed input until the current turn ends.
 *                    Never retried — the text is already in the input box, so a
 *                    second attempt is a second copy, not a retry. One trigger
 *                    arrived three times on 2026-08-01 for exactly that reason.
 * - "spawned"      — none running; one was launched, came up, and received it
 * - "unrouted"     — no owner resolved; left in the findings inbox
 * - "unlaunchable" — an owner resolved but no PAI alias exists to launch it
 * - "unreachable"  — a session was launched but never became ready to accept input
 * - "skipped"      — autoDispatch is off, or no transport; reported only
 *
 * `unlaunchable` and `unreachable` are distinct because the fixes differ:
 * the first is a setup gap (register an alias), the second is a runtime
 * failure (find out why the session did not come up). Collapsing them would
 * send users looking in the wrong place.
 *
 * None of these are errors. A task that could not be delivered is a routing
 * result to report, not an exception to throw.
 */
export type DispatchOutcome =
  | "delivered"
  | "queued"
  | "spawned"
  | "unrouted"
  | "unlaunchable"
  | "unreachable"
  | "skipped";

export interface DispatchResult {
  task: Task;
  outcome: DispatchOutcome;
  /** Session the task reached, when it reached one. */
  session?: string;
  /** Why the task did not reach a session. Present on failure outcomes. */
  reason?: string;
}
