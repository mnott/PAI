/**
 * queue-table.ts — the ONE worker queue table of the machine: the rows, their order, their plain wording and
 * their actions. `pai worker queue` prints it, /cockpit/queue carries it and the cockpit workers card draws it,
 * so both show the same thing (spec-queue-control).
 *
 * Order = admission order: running jobs first (oldest start first), then the waiting ones 1..n (per provider the
 * capacity queue's grant order, the providers side by side by their position). The rows are model jobs only: a
 * `pai pane run` command is not a job — it uses no model and no slot — so it is never a row; a pane whose command
 * waits on a worker id (`pai worker wait <id>`) shows as an eye on that job's row instead. A moved job (rerouted /
 * fall-through) is ONE row: the continuation, with "continues <old id>" as detail; the old row disappears.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueueRow } from "./capacity.js";
import { pausedFree, slotLent, type WorkerStatus } from "./status.js";
import { paneWaitsOn, type PaneRunStatus } from "./pane-run.js";
import type { SchedSnapshot } from "../router/scheduler.js";
import { topicChip } from "./topic.js";

/** Short id of a worker or pane run: the last dash-part of its id (a queue row never prints the full id). */
export const shortId = (id: string): string => id.slice(id.lastIndexOf("-") + 1);

/** The task's first lines in plain prose: up to `max` characters cut at a sentence end, for a tooltip.
 *  A leading "Repo: …" / "Directory: …" line and a "Task:" prefix are skipped; "" when there is nothing to show. */
export function taskSummary(text: string, max = 300): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && (/^\s*(repo|directory)\s*:/i.test(lines[0]!) || !lines[0]!.trim())) lines.shift();
  if (lines.length) lines[0] = lines[0]!.replace(/^\s*task:\s*/i, "");
  let t = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.slice(0, max);
  // the end of the 3rd sentence when it still fits; else the last full sentence inside the limit (else a plain cut)
  const ends = [...cut.matchAll(/[^.!?]*[.!?](?=\s|$)/g)].map((m) => m.index! + m[0]!.length);
  const third = ends.length >= 3 ? ends[2] : undefined;
  if (third !== undefined && third <= max) return cut.slice(0, third).trim();
  const last = ends.length ? ends[ends.length - 1]! : 0;
  return last > 40 ? cut.slice(0, last).trim() : cut.trim();
}

/** Read the task text a run kept (its --spec file or the <id>.prompt copy): "" when there is none. */
export function readTaskText(logDir: string, s: Pick<WorkerStatus, "id" | "promptFile" | "spec">): string {
  const f = [s.promptFile, s.spec, join(logDir, `${s.id}.prompt`)].find((x): x is string => !!x && x !== "-");
  if (!f) return "";
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

/** Short model label: the provider name for a local model, "cloud: sonnet" for a cloud one (never the full id). */
export function shortModel(local: boolean, provider: string, model?: string): string {
  if (local) return provider;
  const id = (model || "").toLowerCase();
  const fam = id.match(/(sonnet|opus|haiku|fable)/);
  const last = id.split("/").pop() || "";
  return `cloud: ${fam ? fam[1] : last || provider}`;
}

export type RowState = "running" | "waiting" | "paused" | "frozen" | "deep-frozen";
export type RowAction =
  | "next" | "up" | "down"
  | "pause" | "resume" | "freeze" | "thaw" | "deep-freeze" | "deep-resume"
  | "to-local" | "to-cloud"
  | "prio-low" | "prio-normal" | "prio-high" | "prio-now"
  | "stop";

export interface TableRow {
  /** "running" for a slot holder, else the waiting position 1..n. */
  slot: "running" | "saved" | "freed" | number;
  kind: "job";
  id: string;
  state: RowState;
  /** Plain-language state ("waiting for a local slot", "paused: frees its slot"). */
  stateText: string;
  priority: "low" | "normal" | "high" | "now";
  session: string;
  /** The job's topic (--topic), when it has one: the cockpit chip after the session chip. */
  topic?: string;
  /** 1 = orchestrator (class orchestrate/plan), 2 = does the work (its children and direct implement runs). */
  level: 1 | 2;
  /** The L1 job this one was started by, when that job is a row of the table (the child is drawn under it). */
  parent?: string;
  /** Why this job is not on the local model ("class orchestrate runs on the cloud"); absent for a local job. */
  cloudWhy?: string;
  /** Short name: "<provider>" for a local model / "cloud: <short model>". */
  model: string;
  /** Full "local: <model id>" / "cloud: <provider> <model id>" for a tooltip. */
  modelFull?: string;
  local: boolean;
  task: string;
  seconds: number;
  /** Fixed-width activity cell: "writing" | "in line" | "tool" | "idle 2m" | "waiting" | "" — real state, never a guess (see ACT_TIP). */
  activity: string;
  /** Plain sentence of what the activity word means, for its tooltip. */
  activityTip: string;
  /** The live last tool call, for a tooltip only (it changes every second and must not move the table). */
  now: string;
  /** "continues <old id>" and plain notes. */
  detail: string;
  /** The task's first lines in plain prose (from the stored prompt, no model call): the task cell's tooltip. */
  summary?: string;
  /** Pane runs whose command waits on this job (`pai worker wait <id>`): shown as an eye on this row. */
  waits?: Array<{ id: string; label: string }>;
  /** Set while the job is being restarted by the daemon (older PAI release); the row reads "restarting on new version". */
  restarting?: boolean;
  actions: RowAction[];
}

export interface TableInput {
  statuses: WorkerStatus[];
  queue: QueueRow[];
  /** Running pane commands: never rows (they are not jobs); one whose command waits on a worker id becomes an eye on that job's row. */
  panes: Array<Pick<PaneRunStatus, "id" | "label" | "state" | "startedMs" | "command"> & { session?: string }>;
  now: number;
  /** Provider name -> true when it runs on this machine (a local model). */
  isLocal: (provider: string) => boolean;
  /** Session display name of a status. */
  sessionOf: (s: WorkerStatus) => string;
  /** The task text a run kept (its --spec / <id>.prompt copy): "" when none. Injected so the table itself never reads files. */
  summaryOf?: (s: WorkerStatus) => string;
  /** Ids stopped by `pai freeze` (in memory). */
  frozen?: (id: string) => boolean;
  /** Ids stopped durably (`pai stop`); none until that exists. */
  deepFrozen?: (id: string) => boolean;
  /** The router's local-scheduler snapshot (readSchedFile): whose request is in flight at the model, whose waits in line. Absent = the router cannot be reached: the activity word falls back to the status file only. */
  sched?: SchedSnapshot | null;
}

/** What a worker's request does at the model engine, from the router's scheduler snapshot (the one truth of in flight / in line). */
export interface RequestState {
  /** The worker's request is open at the model: it is generating its reply. */
  inflight?: boolean;
  /** The worker's request waits in the local scheduler queue: it is in line for the engine. */
  queued?: boolean;
}

/** The one line above the table (also the CLI footer): states and priorities in plain words. */
export const QUEUE_EXPLAIN =
  "running = holds a slot; waiting = next in line; paused = parked, slot freed for the next job; frozen = stopped in memory, lost on reboot; deep-frozen = stopped and saved, survives reboot. " +
  "Priority: low = others go first; normal = default; high = ahead of normal; now = front of the queue, pauses all other local jobs while it runs. Slots: \"N of M slots busy\" counts jobs holding a slot; \"back from a long tool run\" = a job that lent its slot while waiting on a long tool took it back while others filled it, so it runs above the cap until one finishes.";

/** Plain-words tooltip of each priority. */
export const PRIORITY_TIP: Record<"low" | "normal" | "high" | "now", string> = {
  low: "others go first",
  normal: "default",
  high: "ahead of normal",
  now: "front of the queue and pauses all other local jobs while it runs",
};

/** Tooltips of the level badge. */
export const LEVEL_TIP: Record<1 | 2, string> = {
  1: "L1 coordinates: splits the work, starts L2 workers, checks their results",
  2: "L2 does the work",
};
/** L1 = an orchestrator (class orchestrate / plan); everything else is L2. */
export const levelOf = (className?: string): 1 | 2 => (className === "orchestrate" || className === "plan" ? 1 : 2);

/** Why a cloud job is not local, in plain words, from the fields the run recorded (route, routeWhy, escalated); "" for a local job. */
export function cloudWhy(s: Pick<WorkerStatus, "route" | "routeWhy" | "escalated" | "className" | "provider">, local: boolean): string {
  if (local) return "";
  const r = s.route?.reason ?? "";
  let m: RegExpMatchArray | null;
  const OP = /^(?:cli|operator|cockpit|you)\b/i;
  if (/^escalated to \S+: (?:by )?(?:cli|operator|cockpit|you)\b/i.test(s.escalated ?? "") || OP.test(r.match(/^(?:rerouted|fall-through) \((.*)\)$/)?.[1] ?? "")) return "moved by operator";
  if ((m = r.match(/^(?:rerouted|fall-through) \(escalation: no edit or commit for (\d+)m\)$/))) return `moved: no edit or commit for ${m[1]} min on the local model`;
  if ((m = r.match(/^(?:rerouted|fall-through) \((.*)\)$/))) return `moved: ${m[1]!.replace(/^escalation: /, "")}`;
  if (s.escalated) return plainWording(s.escalated);
  if ((m = (s.routeWhy ?? "").match(/^class: (\S+)/))) return `class ${m[1]} runs on the cloud`;
  if (/--cloud|flag: --provider/.test(s.routeWhy ?? "")) return "--cloud at start";
  return s.routeWhy ? `chosen at start: ${s.routeWhy}` : "cloud";
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain wording of an internal state/event text; the internal text stays for tooltips. */
export function plainWording(text: string): string {
  let t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^escalated to (\w[\w-]*): (?:cli|operator|cockpit|you)\b.*$/i))) return `moved to cloud (${cap(m[1]!)}) by you`;
  if ((m = t.match(/^escalated to (\w[\w-]*): (?:by )?(?:cli|operator)/i))) return `moved to cloud (${cap(m[1]!)}) by you`;
  if ((m = t.match(/^rerouted \(escalation: no edit or commit for (\d+)m\)$/))) return `moved to cloud: no progress for ${m[1]} min`;
  if ((m = t.match(/^rerouted \(escalation: (\d+) failed tool calls in a row\)$/))) return `moved to cloud: ${m[1]} failed steps in a row`;
  if ((m = t.match(/^(?:rerouted \()?(?:escalation: )?queued (\d+)m \(operator priority\)\)?$/))) return `moved to cloud: waited ${m[1]} min for a local slot`;
  if ((m = t.match(/^fall-through of (\S+)$/))) return `continues job ${m[1]}`;
  if ((m = t.match(/^fell through to (\S+)$/))) return `continued as job ${m[1]}`;
  if ((m = t.match(/^escalated t(\d)→t(\d): (.*)$/))) return `moved to a stronger model: ${m[3]}`;
  if ((m = t.match(/^escalated -> (\S+)$/))) return `continued as job ${m[1]}`;
  if ((m = t.match(/^rerouted \((.*)\)$/))) return `moved to cloud: ${m[1]!.replace(/^escalation: /, "")}`;
  // leftovers of internal vocabulary
  t = t.replace(/\bfall-through\b/gi, "continuation").replace(/\bescalat(?:ed|ion)\b/gi, "moved").replace(/\breroute[d]?\b/gi, "moved").replace(/\bpinned\b/gi, "fixed");
  return t;
}

/** The short word of each activity, shown fixed-width in the cell; ACT_TIP carries the sentence for its tooltip. */
export const ACT_TIP: Record<"writing" | "in line" | "tool" | "waiting", string> = {
  writing: "its request is open at the model — the model is writing its reply",
  "in line": "its request waits in the local scheduler queue, behind other workers at the engine",
  tool: "no request open at the model; a tool (build, test) is running",
  waiting: "waiting for a slot: no request has gone to the model yet",
};

/**
 * The activity word of a RUNNING job, from real state — never the age of the last status write:
 * "writing" its request is open at the model; "in line" it waits in the router's local scheduler queue;
 * "tool" no request open and a tool runs (a Bash the worker waits on); else "idle Nm" past 90 s.
 * Without `req` (the router cannot be reached) only the status file speaks: "tool" / "idle", never a guess.
 */
export function activityOf(s: Pick<WorkerStatus, "updated" | "toolWaitSince">, waiting: boolean, now: number, req?: RequestState): string {
  if (waiting) return "waiting";
  if (req?.inflight) return "writing";
  if (req?.queued) return "in line";
  // a tool running: the PreToolUse hook stamped the wait and the result has not cleared it yet
  if (s.toolWaitSince !== undefined || slotLent(s, now)) return "tool";
  const t = Date.parse((s.updated ?? "").replace(" ", "T"));
  const age = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : Infinity;
  if (age < 90) return "";
  return `idle ${age < 3600 ? Math.floor(age / 60) + "m" : Math.floor(age / 3600) + "h"}`;
}

/** The tooltip sentence of an activity word: the fixed meaning, plus the live last event when there is one. Every word has one, "idle Nm" included. */
export function activityTip(activity: string, nowText?: string): string {
  const m = activity.match(/^idle (\d+)(m|h)$/);
  const base = ACT_TIP[activity as keyof typeof ACT_TIP] ?? (m ? `no request at the model and no tool running for ${m[1]} ${m[2] === "m" ? "minutes" : "hours"}; it may be stuck` : "");
  return nowText ? `${base} — last: ${nowText}` : base;
}

const prioOf = (s: WorkerStatus, ticket?: string): TableRow["priority"] => (s.now ? "now" : ((ticket ?? s.priority ?? "normal") as TableRow["priority"]));

/** Up/next/down only for a waiting row, and only the moves that change something: not "up"/"next" on the first row, not "down" on the last. */
function actionsOf(state: RowState, local: boolean, waiting: boolean, place?: { first: boolean; last: boolean }): RowAction[] {
  if (state === "deep-frozen") return ["deep-resume"];
  const a: RowAction[] = [];
  if (waiting && state === "waiting") {
    if (!place?.first) a.push("next", "up");
    if (!place?.last) a.push("down");
  }
  a.push(state === "paused" ? "resume" : "pause");
  a.push(state === "frozen" ? "thaw" : "freeze");
  a.push("deep-freeze");
  a.push(local ? "to-cloud" : "to-local");
  a.push("prio-low", "prio-normal", "prio-high", "prio-now");
  return a;
}

/** Statuses a live continuation replaced: the old row disappears. */
function replacedIds(live: WorkerStatus[]): Set<string> {
  const ids = new Set(live.map((s) => s.id));
  const out = new Set<string>();
  for (const s of live) if (s.fallThroughOf && ids.has(s.fallThroughOf) && !live.find((o) => o.id === s.fallThroughOf)?.movingTo) out.add(s.fallThroughOf);
  return out;
}

export function buildQueueTable(i: TableInput): TableRow[] {
  const stMs = (s: WorkerStatus): number => {
    const t = Date.parse((s.started ?? "").replace(" ", "T"));
    return Number.isFinite(t) ? t : i.now;
  };
  const sec = (ms: number): number => Math.max(0, Math.floor((i.now - ms) / 1000));
  const ticket = new Map(i.queue.map((q) => [q.id, q]));
  // the request state per worker from the router's snapshot: in flight at the model, or waiting in line (absent snapshot = the router cannot be reached)
  const reqOf = (id: string): RequestState | undefined => {
    const a = i.sched?.workers[id];
    return a ? { inflight: a.activeSince > 0, queued: a.waitingSince > 0 } : undefined;
  };
  const deepIds = new Set(i.statuses.filter((s) => i.deepFrozen?.(s.id) === true).map((s) => s.id));
  const live = i.statuses.filter((s) => deepIds.has(s.id) || s.state === "running" || s.state === "queued" || ticket.has(s.id));
  const gone = replacedIds(live);
  const summaryOf = (s: WorkerStatus): string | undefined => {
    if (!i.summaryOf) return undefined;
    try {
      const t = i.summaryOf(s);
      return t ? t : undefined;
    } catch {
      return undefined;
    }
  };
  const row = (s: WorkerStatus, waiting: boolean, since: number, prio?: string, place?: { first: boolean; last: boolean }, moving?: string): Omit<TableRow, "slot"> => {
    const local = i.isLocal(s.provider);
    const deep = i.deepFrozen?.(s.id) === true;
    const fr = !deep && i.frozen?.(s.id) === true;
    const state: RowState = deep ? "deep-frozen" : fr ? "frozen" : s.paused && !(waiting && s.state === "running") ? "paused" : waiting ? "waiting" : "running";
    const notes = [s.fallThroughOf ? `fall-through of ${s.fallThroughOf}` : "", s.route?.reason?.startsWith("rerouted") ? s.route.reason : "", s.escalated ?? ""].filter(Boolean);
    const stateText =
      state === "waiting" ? (s.restarting ? "restarting on new version" : `waiting for a ${local ? "local" : "cloud"} slot`) : state === "paused" ? (pausedFree(s) ? "paused (slot freed)" : "paused (holds its slot)") : state === "frozen" ? "frozen (in memory)" : state === "deep-frozen" ? "deep-frozen (saved)" : moving ?? "running";
    return {
      kind: "job",
      id: s.id,
      state,
      stateText,
      priority: prioOf(s, prio),
      session: i.sessionOf(s),
      ...(s.topic ? { topic: s.topic } : {}),
      model: shortModel(local, s.provider, s.model),
      modelFull: `${local ? "local" : "cloud"}: ${local ? s.model || s.provider : `${s.provider} ${s.model || ""}`.trim()}`,
      local,
      level: levelOf(s.className),
      ...(s.parent ? { parent: s.parent } : {}),
      ...(cloudWhy(s, local) ? { cloudWhy: cloudWhy(s, local) } : {}),
      task: s.label || s.id,
      activity: state === "running" ? activityOf(s, false, i.now, reqOf(s.id)) : "",
      activityTip: "",
      now: waiting ? "" : (s.last ?? "").slice(0, 120),
      seconds: sec(since),
      detail: notes.map(plainWording).join("; "),
      ...(summaryOf(s) ? { summary: summaryOf(s) } : {}),
      ...(s.restarting ? { restarting: true } : {}),
      actions: actionsOf(state, local, waiting, place),
    };
  };
  const out: TableRow[] = [];
  const runners = live.filter((s) => s.state === "running" && !deepIds.has(s.id) && !ticket.has(s.id) && !gone.has(s.id)).sort((a, b) => stMs(a) - stMs(b) || (a.id < b.id ? -1 : 1));
  // a running job moving to a slot-limited provider keeps running; its continuation waits in the target's queue and is shown on this row
  const moverOf = (id: string) => i.queue.find((q) => q.status?.fallThroughOf === id);
  const movers = new Set(runners.filter((x) => x.movingTo).map((x) => x.id));
  for (const s of runners.filter((x) => !pausedFree(x))) {
    const q = s.movingTo ? moverOf(s.id) : undefined;
    const moving = s.movingTo ? `running (${i.isLocal(s.provider) ? "local" : "cloud"}) · moving to ${i.isLocal(s.movingTo) ? "local" : "cloud"}, waiting #${q ? q.position : "?"}` : undefined;
    out.push({ slot: "running", ...row(s, false, stMs(s), undefined, undefined, moving) });
  }
  // waiting: per provider in grant order, providers interleaved by position (1st of each, then 2nd of each ...), ties: waited longest first
  const waiting = i.queue.filter((q) => !gone.has(q.id) && !deepIds.has(q.id) && q.status && !(q.status.fallThroughOf && movers.has(q.status.fallThroughOf))).sort((a, b) => a.position - b.position || (a.since ?? stMs(a.status!)) - (b.since ?? stMs(b.status!)) || (a.id < b.id ? -1 : 1));
  waiting.forEach((q, n) => out.push({ slot: n + 1, ...row(q.status!, true, q.since ?? stMs(q.status!), q.priority, { first: q.position === 1, last: q.position === q.queued }) }));
  for (const s of runners.filter((x) => pausedFree(x))) out.push({ slot: "freed", ...row(s, false, stMs(s)) });
  for (const s of live.filter((x) => deepIds.has(x.id))) out.push({ slot: "saved", ...row(s, false, stMs(s)) });
  // pane runs are not rows (no model, no slot); one whose command waits on a job shows as an eye on that job's row
  const waiterIds = new Set(i.statuses.map((s) => s.id));
  for (const p of i.panes.filter((x) => x.state === "running")) {
    const target = paneWaitsOn(p.command);
    if (!target || !waiterIds.has(target)) continue;
    const r = out.find((x) => x.id === target);
    if (r) (r.waits ??= []).push({ id: p.id, label: p.label });
  }
  // one order: running, then waiting, then paused/frozen (stable inside each group)
  const sorted = out.map((r, n) => ({ r, n })).sort((a, b) => rowGroup(a.r) - rowGroup(b.r) || a.n - b.n).map(({ r }) => r);
  return nestChildren(sorted).map((r) => ({ ...r, activityTip: r.activity ? activityTip(r.activity, r.now) : "" }));
}

/** A child of an L1 row follows it directly when both are in the same state group; everything else keeps its place. */
export function nestChildren(rows: TableRow[]): TableRow[] {
  const l1 = new Set(rows.filter((r) => r.level === 1).map((r) => r.id));
  const kids = (p: TableRow): TableRow[] => rows.filter((c) => c.parent === p.id && c.level === 2 && rowGroup(c) === rowGroup(p));
  const placed = new Set<string>();
  const out: TableRow[] = [];
  for (const r of rows) {
    if (placed.has(r.id)) continue;
    const p = r.level === 2 && r.parent ? rows.find((x) => x.id === r.parent && l1.has(x.id) && rowGroup(x) === rowGroup(r)) : undefined;
    if (p) continue; // drawn under its L1
    placed.add(r.id);
    out.push(r);
    if (l1.has(r.id)) for (const c of kids(r)) if (!placed.has(c.id)) (placed.add(c.id), out.push(c));
  }
  return out;
}

/** 0 = running, 1 = waiting, 2 = paused / frozen / deep-frozen. */
export function rowGroup(r: Pick<TableRow, "state">): number {
  return r.state === "running" ? 0 : r.state === "waiting" ? 1 : 2;
}
export const GROUP_LABEL = ["running", "waiting", "paused / frozen"] as const;

/** Rows of the chosen sessions only (none chosen = all), keeping their order. */
export function filterBySession<T extends Pick<TableRow, "session">>(rows: T[], sessions: string[]): T[] {
  return sessions.length ? rows.filter((r) => sessions.includes(r.session)) : rows;
}
/** Rows of the chosen topics only (none chosen = all). */
export function filterByTopic<T extends Pick<TableRow, "topic">>(rows: T[], topics: string[]): T[] {
  return topics.length ? rows.filter((r) => !!r.topic && topics.includes(r.topic)) : rows;
}
/** Sorted by session, then by the order the rows came in (admission order); a stable sort. */
export function sortBySession<T extends Pick<TableRow, "session">>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.session < b.r.session ? -1 : a.r.session > b.r.session ? 1 : a.i - b.i)).map((o) => o.r);
}

/** Badge text of a row: "running", "waiting #2", "paused", "frozen", "deep-frozen". */
export function stateBadge(r: Pick<TableRow, "state" | "slot">): string {
  return r.state === "waiting" && typeof r.slot === "number" ? `waiting #${r.slot}` : r.state;
}

const fmtDur = (s: number): string => (s < 90 ? `${s}s` : s < 5400 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`);
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The CLI rendering of the table: same columns and order as the cockpit (state, session, task, model, prio, time) plus the short id. */
export function renderQueueTable(rows: TableRow[]): string[] {
  if (!rows.length) return ["nothing running or waiting"];
  const head = ["state", "session", "task", "model", "prio", "time", "id"];
  const l1Ids = new Set(rows.filter((r) => r.level === 1).map((r) => r.id));
  const body = rows.map((r) => [
    // the activity word is fixed 7 chars so the state column never moves (full meaning in the cockpit tooltip)
    `[${stateBadge(r)}]${r.activity && r.state === "running" ? " " + r.activity.padEnd(7).trimEnd() : ""}`,
    clip(r.session, 18) + (r.topic ? ` [${topicChip(r.topic)}]` : ""),
    clip(`L${r.level} ${r.level === 2 && r.parent && l1Ids.has(r.parent) ? "└ " : ""}${r.task}`, 50),
    clip(r.model + (r.cloudWhy ? " ↑" : ""), 26),
    r.priority,
    fmtDur(r.seconds),
    shortId(r.id),
  ]);
  const w = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c]!.length)));
  // the activity word keeps its fixed 7-char width even when no row needs more (the column never moves)
  const fmt = (cells: string[]): string => cells.map((c, k) => (k === 5 ? c.padStart(w[k]!) : c.padEnd(w[k]!))).join("  ").trimEnd();
  return [fmt(head), ...body.map(fmt), "", QUEUE_EXPLAIN];
}
