/**
 * reroute.ts — move a worker to another provider: `rerouteWorker` is the one function behind the pane's
 * /now-less commands (/cloud, /local), `pai worker reroute` and the worker_reroute MCP tool, and behind the
 * supervision tick's time-bound escalation (`escalateOverdue`).
 *
 * A queued worker has not started: its waiting process is stopped and the same task starts on the target
 * provider. A running worker goes through the normal kill path (which salvages its commits onto its branch)
 * and the same task starts on the target, with a note naming the old id and the branch it continues from.
 *
 * The restart itself is the fall-through's: `rerunOn` (run/escalate.ts) starts the task on the target and links the
 * two runs (ledger, _fallThroughOf, fallThroughTo).
 *
 * Escalation policy (workers.escalate): queuedMaxMin, stallMaxMin, stallFailedCalls. A job whose
 * provider was pinned (an explicit per-run --provider or --local; the session profile is not a pin) is never escalated, a job is escalated once,
 * and only to the fallback (`where: cloud`).
 */

import { swapPromptArg } from "./args.js";
import { parseStamp } from "./ledger.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escalationPolicy } from "./config.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

export type ReroutePolicy = ReturnType<typeof escalationPolicy>;

/** The effective policy: workers.escalate, read through the same loader as the rest of the escalation settings. */
export const reroutePolicy = escalationPolicy;

const PINNED = /\((?:flag: --provider|local)\)$/;

/** Whether the caller chose this run's provider (status.routeWhy names the source). */
export function providerPinned(s: Pick<WorkerStatus, "routeWhy">): boolean {
  return PINNED.test(s.routeWhy ?? "");
}

const stampMs = (stamp: string | undefined): number | null => {
  const t = stamp ? parseStamp(stamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * Why this job should move to the fallback provider now, or null. Pure: status in, reason out.
 * Skips a pinned provider, an already rerouted job, a paused one, a job without a task copy to restart.
 */
export function escalationReason(s: WorkerStatus, nowMs: number, p: ReroutePolicy = reroutePolicy()): string | null {
  if (s.rerouted || s.origin === "chat" || s.paused || providerPinned(s)) return null;
  if (!s.spec && !s.promptFile) return null;
  if (s.state === "queued") {
    const since = s.capacity?.sinceMs ?? stampMs(s.started);
    const min = since === null || since === undefined ? 0 : (nowMs - since) / 60_000;
    return min >= p.queuedMaxMin ? `queued ${Math.floor(min)}m` : null;
  }
  if (s.state !== "running") return null;
  if ((s.consecFails ?? 0) >= p.stallFailedCalls) return `${s.consecFails} failed tool calls in a row`;
  const last = stampMs(s.progressAt) ?? stampMs(s.started);
  const min = last === null ? 0 : (nowMs - last) / 60_000;
  return min >= p.stallMaxMin ? `no edit or commit for ${Math.floor(min)}m` : null;
}

export interface RerouteTarget {
  provider: string;
  model?: string;
  description: string;
}

export interface SpawnSpec {
  /** The old run and why it moves. */
  id: string;
  why: string;
  provider: string;
  model?: string;
  specFile: string;
  /** The old run's claude args with the task text swapped in: the restart is headless with the same tools and flags. */
  claudeArgs: string[];
}

export interface RerouteDeps {
  logDir: string;
  load?: (id: string) => WorkerStatus | null;
  /** "cloud" | "local" | a provider name -> the provider to start on (default: resolveTarget, the one resolver). */
  resolve?: (where: string) => Promise<RerouteTarget>;
  /** Stop the old worker the way `pai worker kill` does; it salvages the commits (default: killWorker). */
  kill?: (id: string, reason: string) => Promise<unknown>;
  /** Start the task on the target provider (default: rerunOn, the fall-through's restart). */
  spawn?: (s: SpawnSpec) => void | Promise<void>;
  /** Wait before the kill so the old pane can print its line (default 1500 when the worker has a pane, tests pass 0). */
  announceMs?: number;
  /** Who asked, for the ledger and the kill reason. */
  by?: string;
  /** Why (escalation reason); absent for an operator's command. */
  reason?: string;
}

export interface RerouteResult {
  id: string;
  provider: string;
  was: "queued" | "running";
  branch?: string;
  specFile: string;
  description: string;
}

/** The note a continued task starts with. */
export const continuedNote = (id: string, branch: string): string => `continued from ${id} on branch ${branch} — its commits are there, start from that branch`;

async function defaultResolve(where: string): Promise<RerouteTarget> {
  const { resolveTarget } = await import("./target.js");
  const t = await resolveTarget({ where });
  if (!t.provider) throw new Error(`no provider for "${where}"`);
  return { provider: t.provider, model: t.model, description: t.description };
}

async function defaultKill(logDir: string, id: string, reason: string, by: string): Promise<unknown> {
  const { killWorker } = await import("./kill-tree.js");
  return killWorker(logDir, id, { by, reason });
}

/** The restart is the run's own fall-through path, fed from the status the old run left (it may live in another process). */
function defaultSpawn(logDir: string): (s: SpawnSpec) => void {
  return (s) => {
    const st = loadStatus(logDir, s.id);
    if (!st) return;
    void import("./run/escalate.js")
      .then(({ rerunOn }) =>
        rerunOn(
          { logDir, cwd: st.cwd, label: st.label, specPath: s.specFile, claudeArgs: s.claudeArgs, className: st.className, quiet: true },
          s.id,
          s.why,
          st,
          { provider: s.provider, model: s.model }
        )
      )
      .catch(() => undefined);
  };
}

/** Where the task text of `s` lives: its --spec file or the copy the run kept. */
function taskText(s: WorkerStatus): string {
  const file = [s.promptFile, s.spec].find((f): f is string => !!f && f !== "-" && existsSync(f));
  if (!file) throw new Error(`worker ${s.id} kept no copy of its task (started before reroute support, or from stdin) — nothing to start elsewhere`);
  return readFileSync(file, "utf8");
}

/**
 * Move worker `id` to `where` (cloud, local or a provider name). Throws when it is not queued or running,
 * already runs there, or its task is not recoverable; nothing is stopped before those checks pass.
 */
export async function rerouteWorker(id: string, where: string, d: RerouteDeps): Promise<RerouteResult> {
  const load = d.load ?? ((x: string) => loadStatus(d.logDir, x));
  const old = load(id);
  if (!old) throw new Error(`no worker named "${id}"`);
  if (old.state !== "queued" && old.state !== "running") throw new Error(`worker ${id} is ${old.state}; only a queued or running worker can be rerouted`);
  const target = await (d.resolve ?? defaultResolve)(where);
  if (target.provider === old.provider) throw new Error(`worker ${id} already runs on ${old.provider}`);
  const text = taskText(old);
  const by = d.by ?? "reroute";
  const reason = d.reason ?? `${by}: ${where}`;
  // the marker first: a second tick or command sees it and does not start another reroute
  old.rerouted = `${target.provider}: ${d.reason ?? by}`;
  saveStatus(d.logDir, old, new Date(), true);
  const wait = d.announceMs ?? (old.pane ? 1500 : 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await (d.kill ?? ((x, r) => defaultKill(d.logDir, x, r, by)))(id, `rerouted to ${target.provider} (${reason})`);
  const branch = old.state === "running" ? (load(id)?.branch ?? old.branch ?? undefined) : undefined;
  const specFile = join(d.logDir, `${id}.reroute.prompt`);
  const task = branch ? `${continuedNote(id, branch)}\n\n${text}` : text;
  writeFileSync(specFile, task, "utf8");
  const claudeArgs = old.claudeArgs?.length ? swapPromptArg(old.claudeArgs, task) : [];
  await (d.spawn ?? defaultSpawn(d.logDir))({ id, why: `rerouted by ${by}${d.reason ? `: ${d.reason}` : ""}`, provider: target.provider, model: target.model, specFile, claudeArgs });
  return { id, provider: target.provider, was: old.state, ...(branch ? { branch } : {}), specFile, description: target.description };
}

export interface Escalation {
  id: string;
  label: string;
  provider: string;
  reason: string;
  session: string | null;
}

/**
 * The supervision tick's pass: every overdue job goes to the fallback provider through rerouteWorker.
 * One escalation per job (the marker is written before anything is stopped, a failed reroute keeps it),
 * and a job already on the fallback is left alone.
 */
export async function escalateOverdue(
  statuses: WorkerStatus[],
  d: Omit<RerouteDeps, "by" | "reason">,
  nowMs: number = Date.now(),
  policy: ReroutePolicy = reroutePolicy()
): Promise<Escalation[]> {
  const done: Escalation[] = [];
  for (const s of statuses) {
    const reason = escalationReason(s, nowMs, policy);
    if (!reason) continue;
    try {
      const r = await rerouteWorker(s.id, "cloud", { ...d, by: "escalation", reason });
      done.push({ id: s.id, label: s.label, provider: r.provider, reason, session: s.spawnerSession ?? s.session?.id ?? null });
    } catch (e) {
      // already on the fallback or no task copy: marked so the next tick does not try again
      const st = (d.load ?? ((x: string) => loadStatus(d.logDir, x)))(s.id);
      if (st && !st.rerouted) {
        st.rerouted = `skipped: ${(e as Error).message}`.slice(0, 120);
        saveStatus(d.logDir, st, new Date(), true);
      }
    }
  }
  return done;
}

/** The orchestrator's AG2 S message for one escalation. */
export const escalationMessage = (e: Escalation): string => `S|i=${e.id}|z=${e.label}: escalated to ${e.provider}: ${e.reason}`;

/** The pane's one line for an escalation. */
export const escalationLine = (rerouted: string): string => `» escalated to ${rerouted}`;
