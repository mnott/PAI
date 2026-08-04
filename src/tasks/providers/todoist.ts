/**
 * todoist.ts — Todoist provider for the task bus
 *
 * Talks to the Todoist REST API directly rather than going through the Todoist
 * MCP. The MCP is scoped to a Claude session; the daemon has no session, so an
 * MCP-only integration could never run the bus unattended.
 *
 * See Notes/docs/task-bus.md.
 */

import type {
  ListOptions,
  NewTask,
  Task,
  TaskPriority,
  TaskProvider,
  TodoistProviderConfig,
} from "../types.js";
import { UNROUTED } from "../types.js";
import type { AliasMap } from "../resolver.js";
import { resolveOwner } from "../resolver.js";

/**
 * Unified API v1. The older `/rest/v2` endpoints now return 410 Gone — they
 * were sunset, so anything still targeting them fails outright rather than
 * degrading.
 */
const API = "https://api.todoist.com/api/v1";

// ---------------------------------------------------------------------------
// Wire types (only the fields we rely on)
// ---------------------------------------------------------------------------

/** v1 wraps every collection and pages with an opaque cursor. */
interface WirePage<T> {
  results: T[];
  next_cursor?: string | null;
}

interface WireProject {
  id: string;
  name: string;
  parent_id?: string | null;
  is_archived?: boolean;
  is_deleted?: boolean;
  /**
   * True when the project has collaborators — i.e. someone other than the user
   * can create tasks in it. See ownerContainers for why that matters here.
   */
  is_shared?: boolean;
}

interface WireTask {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  section_id?: string | null;
  labels?: string[];
  priority?: number; // 4 = p1 … 1 = p4
  due?: { date?: string; datetime?: string; string?: string; is_recurring?: boolean } | null;
  /** v1 returns completed and tombstoned tasks inline; both must be filtered. */
  checked?: boolean;
  is_deleted?: boolean;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function call<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) {
    // 401 is by far the most common failure and the least self-explanatory,
    // so name the cause rather than surfacing a bare status code.
    const hint = res.status === 401 ? " (token rejected — check it was copied in full)" : "";
    throw new Error(`Todoist ${res.status} ${res.statusText}${hint}`);
  }

  // 204 on delete/close — nothing to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Drain a paginated collection.
 *
 * Every v1 list endpoint pages. Stopping at the first page would silently
 * truncate — the account here already exceeds one page of tasks — so follow the
 * cursor to exhaustion. The guard is a safety stop against a server that keeps
 * handing back the same cursor, not an intentional cap.
 */
async function collect<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null | undefined;
  let guard = 0;

  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
    const page = await call<WirePage<T>>(token, url);
    out.push(...(page.results ?? []));
    cursor = page.next_cursor;
  } while (cursor && ++guard < 100);

  return out;
}

/**
 * List every live project on the account.
 *
 * Exported because setup uses it both to let the user pick the bus root and to
 * validate the token — a bad token fails here, at install time, rather than
 * silently returning nothing during a routine.
 */
/** A bare calendar date — the only shape `due_date` accepts. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A project inside the bus, and the sub-project whose name decides its owner. */
export interface OwnerContainer {
  project: WireProject;
  /** Name of the nearest ancestor directly under the root. Null at the root. */
  ownerName: string | null;
}

/**
 * Every project in the bus subtree, each mapped to the name that owns it.
 *
 * Ownership belongs to the sub-projects directly under the root — they are the
 * ones mirroring PAI projects. Anything deeper is a FOLDER: a way to group work
 * inside one owner's inbox, not a new owner. So `Claude / Jobs Alpha /
 * Executive Search` is eighteen tasks belonging to Jobs Alpha, filed under a
 * heading.
 *
 * This used to take the root and its direct children only. A grandchild was not
 * merely unrouted, it was never QUERIED — its tasks did not exist as far as the
 * bus was concerned. Which is the worst possible failure for this: the user
 * organises work into a sub-project, it looks tidy, and nothing is ever
 * dispatched. Observed 2026-08-02 with exactly the tree above.
 *
 * Descends from the root rather than walking up from each project, so a cycle
 * in the parent chain — which the API should never produce, but a bad write
 * could — cannot hang the poller.
 */
export function ownerContainers(
  projects: WireProject[],
  root: string
): Map<string, OwnerContainer> {
  const live = projects.filter((p) => !p.is_archived && !p.is_deleted);
  const childrenOf = new Map<string, WireProject[]>();
  for (const p of live) {
    if (!p.parent_id) continue;
    const siblings = childrenOf.get(p.parent_id);
    if (siblings) siblings.push(p);
    else childrenOf.set(p.parent_id, [p]);
  }

  const out = new Map<string, OwnerContainer>();
  const rootProject = live.find((p) => p.id === root);
  if (!rootProject) return out;

  // The root carries no owner name: a task sitting there is unrouted, which is
  // how the findings inbox is meant to work.
  out.set(root, { project: rootProject, ownerName: null });

  const walk = (project: WireProject, ownerName: string): void => {
    if (out.has(project.id)) return; // cycle guard

    // A shared project is excluded, along with everything under it.
    //
    // Inheriting ownership down a subtree means a project only has to be MOVED
    // under the root to gain the right to dispatch work into a session. For a
    // project the user owns that is the entire point. For a shared one it is an
    // escalation: a collaborator writes the task, and the task is a work order
    // that spawns a terminal and types into it. Nobody reparents a project
    // thinking about that.
    //
    // Excluded rather than merely unrouted, and announced rather than dropped
    // quietly — a boundary that narrows in silence is the same defect as one
    // that widens in silence. AIBroker reached the same conclusion from the
    // other side on 2026-08-02 and made subtree grants opt-in; this is the
    // equivalent for a poller that has no grant to opt into.
    if (project.is_shared) {
      process.stderr.write(
        `pai: skipping shared project "${project.name}" (${project.id}) and anything under it — ` +
          `tasks there can be written by a collaborator, and a dispatched task runs as you.\n`
      );
      return;
    }

    out.set(project.id, { project, ownerName });
    for (const child of childrenOf.get(project.id) ?? []) walk(child, ownerName);
  };

  for (const top of childrenOf.get(root) ?? []) walk(top, top.name);

  return out;
}

/**
 * Report a write that the server silently shortened.
 *
 * Todoist caps a task description at 16,383 characters and enforces it by
 * TRUNCATION, not by rejection: the request returns 200 and the response says
 * success. Measured 2026-08-02 — a 19,457-character runbook stored as 16,383,
 * losing 3,074 characters off the end with no error anywhere. What went missing
 * was the close-out section, so a session working from it would have done the
 * job correctly and then never marked the task done.
 *
 * The general form is worth more than the specific limit, which is why this
 * compares what came back rather than checking a number: an API that reports
 * success for an operation that did not fully happen is invisible until someone
 * inspects the artifact instead of the return value. Any sink with an unknown
 * limit deserves the same treatment.
 *
 * Warns rather than throws. The task exists and is usable; failing the call
 * would discard work that mostly succeeded. But it must not pass silently.
 *
 * THIS DOES NOT PREVENT THE LOSS. The truncation still happens and the tail is
 * still gone — all this does is turn a silent data-loss bug into a loud one.
 * That is a large improvement and it is not a resolution, and the difference
 * matters because the obvious wrong conclusion from reading this function is
 * "handled, so long content is fine now". It is not: whether anything is done
 * about the warning depends on someone reading stderr. Long content belongs in
 * a file, with the field pointing at it. Visible failure is not absence of
 * failure.
 */
export function warnIfTruncated(field: string, sent: string | undefined, stored: string | undefined): void {
  const before = sent?.length ?? 0;
  const after = stored?.length ?? 0;
  if (before === 0 || after >= before) return;

  process.stderr.write(
    `\npai: WARNING — Todoist truncated the ${field}.\n` +
      `  sent ${before} characters, stored ${after} — ${before - after} lost, silently.\n` +
      `  The API reported success. Anything at the end of that text is gone.\n` +
      `  Put long content in a file and reference it from the ${field} instead.\n\n`
  );
}

/**
 * Build the due portion of a task write.
 *
 * Exported for testing: the whole defect was a one-word field choice, so the
 * choice itself is what needs pinning.
 */
export function dueField(
  due: string | null | undefined
): Record<string, string> {
  const value = due?.trim();
  if (!value) return {};
  return ISO_DATE.test(value) ? { due_date: value } : { due_string: value };
}

export async function listProjects(token: string): Promise<Array<{ id: string; name: string }>> {
  const projects = await collect<WireProject>(token, "/projects");
  return projects
    .filter((p) => !p.is_archived && !p.is_deleted)
    .map((p) => ({ id: p.id, name: p.name }));
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Strip emoji and case so "Whazaa 🐝" and "whazaa" compare equal. */
function normalizeName(raw: string): string {
  return raw
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .trim()
    .toLowerCase();
}

/** Todoist priority is inverted: 4 is urgent, 1 is lowest. */
function toPriority(wire: number | undefined): TaskPriority {
  switch (wire) {
    case 4: return "p1";
    case 3: return "p2";
    case 2: return "p3";
    default: return "p4";
  }
}

function fromPriority(p: TaskPriority | undefined): number {
  switch (p) {
    case "p1": return 4;
    case "p2": return 3;
    case "p3": return 2;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TodoistProvider implements TaskProvider {
  readonly providerId = "todoist" as const;

  constructor(
    private readonly config: TodoistProviderConfig,
    private readonly aliases: AliasMap,
    /** Bus-level settings. Optional so existing callers keep working. */
    private readonly taskConfig?: { defaultOwner?: string },
  ) {}

  /**
   * Resolution order is config → env → unconfigured. A missing token disables
   * the provider rather than throwing: a user without a tracker still gets a
   * fully working PAI.
   */
  private token(): string | null {
    return this.config.apiKey?.trim() || process.env.TODOIST_API_KEY?.trim() || null;
  }

  isConfigured(): boolean {
    return Boolean(this.config.enabled && this.token() && this.config.rootProjectId);
  }

  /** Owner for a task carrying only the bare `pai` marker. See ResolveInput. */
  private get defaultOwner(): string | null {
    return this.taskConfig?.defaultOwner ?? null;
  }

  /**
   * Fetch one task by id, open or completed.
   *
   * `listOpen` cannot serve this: a completed task is gone from that list, and
   * the whole point of archiving is to run at or after completion. Ownership is
   * resolved the same way as in listOpen — label first, then the container
   * walked up to the sub-project directly under the bus root.
   */
  async getTask(id: string): Promise<Task | null> {
    const token = this.token();
    if (!token || !this.config.rootProjectId) return null;

    let w: WireTask;
    try {
      w = await call<WireTask>(token, `/tasks/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
    if (!w?.id) return null;

    const projects = await collect<WireProject>(token, "/projects");
    const owners = ownerContainers(projects, this.config.rootProjectId);
    const entry = owners.get(w.project_id ?? "");

    const owner = resolveOwner(
      { labels: w.labels ?? [], container: entry?.ownerName ?? null, defaultOwner: this.defaultOwner },
      this.aliases
    );

    return {
      id: w.id,
      title: w.content,
      body: w.description ?? "",
      owner,
      due: w.due?.datetime ?? w.due?.date ?? null,
      recurrence: w.due?.is_recurring ? (w.due.string ?? null) : null,
      priority: toPriority(w.priority),
      labels: w.labels ?? [],
      sourceUrl: `https://app.todoist.com/app/task/${w.id}`,
    };
  }

  async listOpen(opts: ListOptions = {}): Promise<Task[]> {
    const token = this.token();
    if (!token || !this.config.rootProjectId) return [];

    // Fetch the project tree once and keep only the bus subtree. Filtering
    // client-side is deliberate: Todoist's project search returns zero results
    // for names containing emoji, so a name query would silently find nothing.
    const projects = await collect<WireProject>(token, "/projects");
    const root = this.config.rootProjectId;
    const owners = ownerContainers(projects, root);
    if (owners.size === 0) return [];
    const inBus = new Map([...owners].map(([id, o]) => [id, o.project]));

    // Query per bus project rather than draining every task on the account.
    // The account may hold thousands; the bus holds a handful.
    const wire: WireTask[] = [];
    for (const id of inBus.keys()) {
      wire.push(...(await collect<WireTask>(token, `/tasks?project_id=${encodeURIComponent(id)}`)));
    }

    const out: Task[] = [];

    for (const w of wire) {
      if (w.checked || w.is_deleted) continue;

      const entry = owners.get(w.project_id);
      if (!entry) continue;

      // The owning name is the nearest ancestor directly under the root, NOT
      // the project the task literally sits in. The bus root itself is not an
      // owner — a task at the root has no container hint.
      const owner = resolveOwner(
        { labels: w.labels ?? [], container: entry.ownerName, defaultOwner: this.defaultOwner },
        this.aliases
      );

      if (opts.owner && owner.project !== opts.owner) continue;
      if (opts.includeUnrouted === false && owner.project === null) continue;

      const due = w.due?.datetime ?? w.due?.date ?? null;
      if (opts.dueBefore) {
        // No due date means no deadline to miss — such tasks are never overdue,
        // so they are excluded from a date-bounded sweep rather than always shown.
        if (!due || due.slice(0, 10) > opts.dueBefore) continue;
      }

      out.push({
        id: w.id,
        title: w.content,
        body: w.description ?? "",
        owner,
        due,
        recurrence: w.due?.is_recurring ? (w.due.string ?? null) : null,
        priority: toPriority(w.priority),
        labels: w.labels ?? [],
        // v1 does not return a task URL. Build the deep link from the ID so a
        // dispatched task is still one click from the tracker.
        sourceUrl: `https://app.todoist.com/app/task/${w.id}`,
      });

      if (opts.limit && out.length >= opts.limit) break;
    }

    return out;
  }

  /**
   * Choose the wire field for a due value.
   *
   * `due_date` takes an ISO date and nothing else — "tomorrow" or "every day"
   * come back as HTTP 400. Recurrence in particular is only expressible through
   * `due_string`, which is the field Todoist runs its natural-language parser
   * over. Sending everything as a date is what made `pai task add --repeat`
   * impossible to write, and a repeating task is the whole mechanism behind a
   * self-rescheduling routine on the bus.
   *
   * Strict ISO still goes to `due_date` rather than through the parser. The
   * parser is locale-sensitive and there is no reason to hand it a value that
   * is already unambiguous — this keeps existing ISO callers on exactly the
   * path they were on.
   */
  async add(task: NewTask): Promise<Task> {
    const token = this.token();
    if (!token || !this.config.rootProjectId) {
      throw new Error("Todoist provider is not configured — run `pai setup`.");
    }

    // Prefer LOCATION over a label. Ownership resolves from the project a task
    // sits in, so filing it into the owner's sub-project says the same thing
    // the label would — visibly, in one place, and in the field someone changes
    // when they re-assign it. A label added here would only be a second, quieter
    // answer to the same question, and one that survives a move: on 2026-08-02 a
    // task moved between projects was still routed by its old label.
    //
    // Only when no sub-project mirrors this owner does the label do real work,
    // and then it is the sole way to express the intent.
    let ownerProjectId: string | null = null;
    if (task.owner && !task.into) {
      ownerProjectId = await this.subProjectForOwner(task.owner);
    }

    const labels = [...(task.labels ?? [])];
    const needsLabel = task.owner && !task.into && !ownerProjectId;
    if (
      needsLabel &&
      !labels.some((l) => l.toLowerCase() === `pai:${task.owner!.toLowerCase()}`)
    ) {
      labels.push(`pai:${task.owner}`);
    }

    // Unowned work lands in the findings inbox when one is configured, so it is
    // triaged later rather than lost at the root.
    const sectionId = task.owner || task.into ? undefined : this.config.findingsSectionId;

    // Filing into a per-project sub-project keeps findings from piling up flat
    // in the root, where they bury each other across projects.
    const projectId = task.into
      ? (await this.findOrCreateSubProject(task.into)).id
      : (ownerProjectId ?? this.config.rootProjectId);

    const created = await call<WireTask>(token, "/tasks", {
      method: "POST",
      body: {
        content: task.title,
        description: task.body,
        project_id: projectId,
        ...(sectionId ? { section_id: sectionId } : {}),
        labels,
        priority: fromPriority(task.priority),
        ...dueField(task.due),
      },
    });

    // The POST already returns what was stored, so this costs nothing.
    warnIfTruncated("task description", task.body, created.description ?? "");

    return {
      id: created.id,
      title: created.content,
      body: created.description ?? "",
      owner: task.owner
        ? resolveOwner({ labels, container: null, defaultOwner: this.defaultOwner }, this.aliases)
        : { ...UNROUTED },
      due: created.due?.datetime ?? created.due?.date ?? null,
      priority: toPriority(created.priority),
      labels: created.labels ?? [],
      sourceUrl: `https://app.todoist.com/app/task/${created.id}`,
    };
  }

  /**
   * Replace a task's labels.
   *
   * Only ever sends `labels`. Never `due_date`: writing that field destroys a
   * recurrence rule, silently turning a routine into a one-off. Measured — it
   * cost me an invalid test before it cost anyone a schedule.
   */
  async setLabels(id: string, labels: string[]): Promise<void> {
    const token = this.token();
    if (!token) throw new Error("Todoist provider is not configured — run `pai task config`.");
    await call<WireTask>(token, `/tasks/${id}`, { method: "POST", body: { labels } });
  }

  /**
   * Move a task's due date, expressed in Todoist's natural language.
   *
   * Always `due_string`, never `due_date`: writing a bare date to a recurring
   * task drops the recurrence and turns a routine into a one-off, silently. To
   * keep both, the caller passes the rule and the date together — Todoist
   * accepts "every day at 08:00 starting 2026-08-02" and honours each half.
   */
  async setDue(id: string, dueString: string): Promise<void> {
    const token = this.token();
    if (!token) throw new Error("Todoist provider is not configured — run `pai task config`.");
    await call<WireTask>(token, `/tasks/${id}`, { method: "POST", body: { due_string: dueString } });
  }

  /**
   * Find the sub-project named `name` under the bus root, creating it if absent.
   *
   * Per-project sub-projects are the filing convention: a flat pile in the root
   * buries findings across projects. This exists so the convention can be
   * executed rather than re-derived — a session that has to infer structure
   * from the existing project list will sometimes infer cautiously and file
   * flat, which is the mess the convention prevents.
   *
   * Matching is case-insensitive and ignores decoration, so "Whazaa" finds an
   * existing "Whazaa 🐝" rather than creating a near-duplicate.
   */
  /**
   * The sub-projects under the bus root — i.e. every address a task can be
   * filed against. Archived and deleted ones are excluded: they cannot receive
   * work, so listing them would overstate what is reachable.
   */
  /**
   * The existing sub-project that resolves to this owner, if there is one.
   *
   * Matched by running the ordinary ownership resolution over each sub-project
   * name rather than comparing strings, because a display name is rarely its
   * PAI slug — "AIBroker" is `broker`, "SL" is `seriousletter`. Reusing the
   * resolver means filing and reading cannot disagree about where a task
   * belongs, which is a class of bug we have already paid for.
   *
   * Deliberately does NOT create anything. Filing a task should not bring a new
   * address into existence as a side effect; that is `--into`'s job, asked for
   * explicitly.
   */
  private async subProjectForOwner(owner: string): Promise<string | null> {
    try {
      for (const p of await this.listSubProjects()) {
        const resolved = resolveOwner({ labels: [], container: p.name }, this.aliases);
        if (resolved.project === owner) return p.id;
      }
    } catch {
      // Unreachable tracker — fall back to the label, which still routes.
    }
    return null;
  }

  async listSubProjects(): Promise<Array<{ id: string; name: string }>> {
    const token = this.token();
    if (!token || !this.config.rootProjectId) {
      throw new Error("Todoist provider is not configured — run `pai task config`.");
    }

    const root = this.config.rootProjectId;
    const projects = await collect<WireProject>(token, "/projects");
    return projects
      .filter((p) => !p.is_archived && !p.is_deleted && p.parent_id === root)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  async findOrCreateSubProject(name: string): Promise<{ id: string; created: boolean }> {
    const token = this.token();
    if (!token || !this.config.rootProjectId) {
      throw new Error("Todoist provider is not configured — run `pai task config`.");
    }

    const root = this.config.rootProjectId;
    const projects = await collect<WireProject>(token, "/projects");
    const want = normalizeName(name);

    for (const p of projects) {
      if (p.is_archived || p.is_deleted) continue;
      if (p.parent_id === root && normalizeName(p.name) === want) {
        return { id: p.id, created: false };
      }
    }

    const created = await call<WireProject>(token, "/projects", {
      method: "POST",
      body: { name, parent_id: root },
    });
    return { id: created.id, created: true };
  }

  /** Append a comment — used to keep run history on the task itself. */
  async comment(id: string, content: string): Promise<void> {
    const token = this.token();
    if (!token) throw new Error("Todoist provider is not configured — run `pai task config`.");
    const created = await call<{ content?: string }>(token, `/comments`, {
      method: "POST",
      body: { task_id: id, content },
    });
    // Comments have their own cap, and the same truncate-and-report-success
    // behaviour. A run history that quietly loses its tail is worse than none,
    // because it reads as complete.
    warnIfTruncated("comment", content, created?.content ?? "");
  }

  /** Comments on one task, oldest first. */
  async listComments(
    taskId: string
  ): Promise<Array<{ id: string; content: string; postedAt?: string }>> {
    const token = this.token();
    if (!token) return [];
    const wire = await collect<{ id: string; content?: string; posted_at?: string }>(
      token,
      `/comments?task_id=${encodeURIComponent(taskId)}`
    );
    // posted_at is carried because the archive is a record: a discussion with
    // no dates cannot be reconciled against anything that happened around it.
    return wire.map((c) => ({ id: c.id, content: c.content ?? "", postedAt: c.posted_at }));
  }

  async deleteComment(commentId: string): Promise<void> {
    const token = this.token();
    if (!token) throw new Error("Todoist provider is not configured — run `pai task config`.");
    await call<unknown>(token, `/comments/${commentId}`, { method: "DELETE" });
  }

  async complete(id: string): Promise<void> {
    const token = this.token();
    if (!token) throw new Error("Todoist provider is not configured — run `pai setup`.");
    await call<void>(token, `/tasks/${id}/close`, { method: "POST" });
  }
}
