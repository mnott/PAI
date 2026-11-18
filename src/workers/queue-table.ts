/**
 * queue-table.ts — the ONE worker queue table of the machine: the rows, their order, their plain wording and
 * their actions. `pai worker queue` prints it, /cockpit/queue carries it and the cockpit workers card draws it,
 * so both show the same thing (spec-queue-control).
 *
 * Order = admission order: running jobs first (oldest start first), then the waiting ones 1..n (per provider the
 * capacity queue's grant order, the providers side by side by their position). Commands of `pai pane run` are
 * rows of kind "command" after the running jobs. A moved job (rerouted / fall-through) is ONE row: the
 * continuation, with "continues <old id>" as detail; the old row disappears.
 */
import type { QueueRow } from "./capacity.js";
import type { WorkerStatus } from "./status.js";
import type { PaneRunStatus } from "./pane-run.js";

export type RowState = "running" | "waiting" | "paused" | "frozen" | "deep-frozen";
export type RowAction =
  | "next" | "up" | "down"
  | "pause" | "resume" | "freeze" | "thaw" | "deep-freeze" | "deep-resume"
  | "to-local" | "to-cloud"
  | "prio-low" | "prio-normal" | "prio-high" | "prio-now"
  | "stop";

export interface TableRow {
  /** "running" for a slot holder, else the waiting position 1..n. */
  slot: "running" | "saved" | number;
  kind: "job" | "command";
  id: string;
  state: RowState;
  /** Plain-language state ("waiting for a local slot", "paused: frees its slot"). */
  stateText: string;
  priority: "low" | "normal" | "high" | "now";
  session: string;
  /** "local: <model>" / "cloud: <provider> <model>" / "" for a command. */
  model: string;
  local: boolean;
  task: string;
  seconds: number;
  /** Fixed-width activity cell: "working" | "thinking" | "idle 2m" | "waiting" | "" (never the live tool text). */
  activity: string;
  /** The live last tool call, for a tooltip only (it changes every second and must not move the table). */
  now: string;
  /** "continues <old id>" and plain notes. */
  detail: string;
  actions: RowAction[];
}

export interface TableInput {
  statuses: WorkerStatus[];
  queue: QueueRow[];
  panes: Array<Pick<PaneRunStatus, "id" | "label" | "state" | "startedMs"> & { session?: string }>;
  now: number;
  /** Provider name -> true when it runs on this machine (a local model). */
  isLocal: (provider: string) => boolean;
  /** Session display name of a status. */
  sessionOf: (s: WorkerStatus) => string;
  /** Ids stopped by `pai freeze` (in memory). */
  frozen?: (id: string) => boolean;
  /** Ids stopped durably (`pai stop`); none until that exists. */
  deepFrozen?: (id: string) => boolean;
}

/** The one line above the table (also the CLI footer): states and priorities in plain words. */
export const QUEUE_EXPLAIN =
  "running = holds a slot; waiting = next in line; paused = parked, slot freed for the next job; frozen = stopped in memory, lost on reboot; deep-frozen = stopped and saved, survives reboot. " +
  "Priority: low = others go first; normal = default; high = ahead of normal; now = front of the queue, pauses all other local jobs while it runs.";

/** Plain-words tooltip of each priority. */
export const PRIORITY_TIP: Record<"low" | "normal" | "high" | "now", string> = {
  low: "others go first",
  normal: "default",
  high: "ahead of normal",
  now: "front of the queue and pauses all other local jobs while it runs",
};

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

/** A short activity word from the age of the last status write; idle shows whole minutes/seconds, never the tool text. */
export function activityOf(s: Pick<WorkerStatus, "updated">, waiting: boolean, now: number): string {
  if (waiting) return "waiting";
  const t = Date.parse((s.updated ?? "").replace(" ", "T"));
  if (!Number.isFinite(t)) return "working";
  const age = Math.max(0, Math.floor((now - t) / 1000));
  return age < 20 ? "working" : age < 90 ? "thinking" : `idle ${age < 3600 ? Math.floor(age / 60) + "m" : Math.floor(age / 3600) + "h"}`;
}

const prioOf = (s: WorkerStatus, ticket?: string): TableRow["priority"] => (s.now ? "now" : ((ticket ?? s.priority ?? "normal") as TableRow["priority"]));

function actionsOf(state: RowState, local: boolean, waiting: boolean): RowAction[] {
  if (state === "deep-frozen") return ["deep-resume"];
  const a: RowAction[] = [];
  if (waiting) a.push("next", "up", "down");
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
  for (const s of live) if (s.fallThroughOf && ids.has(s.fallThroughOf)) out.add(s.fallThroughOf);
  return out;
}

export function buildQueueTable(i: TableInput): TableRow[] {
  const stMs = (s: WorkerStatus): number => {
    const t = Date.parse((s.started ?? "").replace(" ", "T"));
    return Number.isFinite(t) ? t : i.now;
  };
  const sec = (ms: number): number => Math.max(0, Math.floor((i.now - ms) / 1000));
  const ticket = new Map(i.queue.map((q) => [q.id, q]));
  const deepIds = new Set(i.statuses.filter((s) => i.deepFrozen?.(s.id) === true).map((s) => s.id));
  const live = i.statuses.filter((s) => deepIds.has(s.id) || s.state === "running" || s.state === "queued" || ticket.has(s.id));
  const gone = replacedIds(live);
  const row = (s: WorkerStatus, waiting: boolean, since: number, prio?: string): Omit<TableRow, "slot"> => {
    const local = i.isLocal(s.provider);
    const deep = i.deepFrozen?.(s.id) === true;
    const fr = !deep && i.frozen?.(s.id) === true;
    const state: RowState = deep ? "deep-frozen" : fr ? "frozen" : s.paused ? "paused" : waiting ? "waiting" : "running";
    const notes = [s.fallThroughOf ? `fall-through of ${s.fallThroughOf}` : "", s.route?.reason?.startsWith("rerouted") ? s.route.reason : "", s.escalated ?? ""].filter(Boolean);
    const stateText =
      state === "waiting" ? `waiting for a ${local ? "local" : "cloud"} slot` : state === "paused" ? "paused (slot freed)" : state === "frozen" ? "frozen (in memory)" : state === "deep-frozen" ? "deep-frozen (saved)" : "running";
    return {
      kind: "job",
      id: s.id,
      state,
      stateText,
      priority: prioOf(s, prio),
      session: i.sessionOf(s),
      model: `${local ? "local" : "cloud"}: ${local ? s.model || s.provider : `${s.provider} ${s.model || ""}`.trim()}`,
      local,
      task: s.label || s.id,
      activity: state === "running" ? activityOf(s, false, i.now) : "",
      now: waiting ? "" : (s.last ?? "").slice(0, 120),
      seconds: sec(since),
      detail: notes.map(plainWording).join("; "),
      actions: actionsOf(state, local, waiting),
    };
  };
  const out: TableRow[] = [];
  const runners = live.filter((s) => s.state === "running" && !deepIds.has(s.id) && !ticket.has(s.id) && !gone.has(s.id)).sort((a, b) => stMs(a) - stMs(b) || (a.id < b.id ? -1 : 1));
  for (const s of runners) out.push({ slot: "running", ...row(s, false, stMs(s)) });
  for (const p of i.panes.filter((p) => p.state === "running").sort((a, b) => a.startedMs - b.startedMs)) {
    out.push({ slot: "running", kind: "command", id: p.id, state: i.frozen?.(p.id) ? "frozen" : "running", stateText: i.frozen?.(p.id) ? "frozen (in memory)" : "running", priority: "normal", session: p.session || "other", model: "", local: false, task: p.label, activity: "", now: "", seconds: sec(p.startedMs), detail: "command", actions: [i.frozen?.(p.id) ? "thaw" : "freeze", "stop"] });
  }
  // waiting: per provider in grant order, providers interleaved by position (1st of each, then 2nd of each ...), ties: waited longest first
  const waiting = i.queue.filter((q) => !gone.has(q.id) && !deepIds.has(q.id) && q.status).sort((a, b) => a.position - b.position || (a.since ?? stMs(a.status!)) - (b.since ?? stMs(b.status!)) || (a.id < b.id ? -1 : 1));
  waiting.forEach((q, n) => out.push({ slot: n + 1, ...row(q.status!, true, q.since ?? stMs(q.status!), q.priority) }));
  for (const s of live.filter((x) => deepIds.has(x.id))) out.push({ slot: "saved", ...row(s, false, stMs(s)) });
  return out;
}

const fmtDur = (s: number): string => (s < 90 ? `${s}s` : s < 5400 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`);
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The CLI rendering of the table (same columns as the cockpit; the actions are the verbs of the commands). */
export function renderQueueTable(rows: TableRow[]): string[] {
  if (!rows.length) return ["nothing running or waiting"];
  const head = ["#", "state", "activity", "prio", "session", "model", "task", "time", "id"];
  const body = rows.map((r) => [r.slot === "running" ? "run" : r.slot === "saved" ? "-" : String(r.slot), r.stateText, r.activity, r.priority, clip(r.session, 18), clip(r.model, 26), clip(r.task + (r.detail ? ` (${r.detail})` : ""), 50), fmtDur(r.seconds), r.id]);
  const w = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, k) => c.padEnd(w[k]!)).join("  ").trimEnd();
  return [fmt(head), ...body.map(fmt), "", QUEUE_EXPLAIN];
}
