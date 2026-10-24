/**
 * reroute.ts — move a worker to another provider: `rerouteWorker` is the one function behind the pane's
 * /now-less commands (/cloud, /local), `pai worker reroute` and the worker_reroute MCP tool, and behind the
 * supervision tick's time-bound escalation (`escalateOverdue`).
 *
 * A queued worker has not started: its waiting process is stopped and the same task starts on the target
 * provider. A running worker goes through the normal kill path (which salvages its commits onto its branch)
 * and the same task starts on the target, with a note naming the old id and the branch it continues from.
 *
 * Escalation policy (config.yaml `workers.reroute`): queuedMaxMin, stallMaxMin, stallFailedCalls. A job whose
 * provider was pinned (--provider, --local, the session profile) is never escalated, a job is escalated once,
 * and only to the fallback (`where: cloud`).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

export interface ReroutePolicy {
  /** Minutes a job may wait for a slot before it goes to the fallback provider. */
  queuedMaxMin: number;
  /** Minutes a running job may go without a successful Edit/Write/commit. */
  stallMaxMin: number;
  /** Failed tool calls in a row that count as a stall. */
  stallFailedCalls: number;
}

const SHIPPED: ReroutePolicy = { queuedMaxMin: 15, stallMaxMin: 10, stallFailedCalls: 6 };

const pos = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);

/** The effective policy: config.yaml `workers.reroute`, the shipped numbers for a missing key. */
export function reroutePolicy(): ReroutePolicy {
  let s: Record<string, unknown> = {};
  try {
    const w = effectiveMainConfig(paiConfigFilePath()).workers as Record<string, unknown> | undefined;
    const r = w?.reroute;
    if (typeof r === "object" && r !== null && !Array.isArray(r)) s = r as Record<string, unknown>;
  } catch {
    // a damaged user config must not stop supervision: the shipped numbers stand alone
  }
  return {
    queuedMaxMin: pos(s.queuedMaxMin, SHIPPED.queuedMaxMin),
    stallMaxMin: pos(s.stallMaxMin, SHIPPED.stallMaxMin),
    stallFailedCalls: pos(s.stallFailedCalls, SHIPPED.stallFailedCalls),
  };
}

const PINNED = /\((?:flag: --provider|local|session profile)\)$/;

/** Whether the caller or the session chose this run's provider (status.routeWhy names the source). */
export function providerPinned(s: Pick<WorkerStatus, "routeWhy">): boolean {
  return PINNED.test(s.routeWhy ?? "");
}

const stampMs = (stamp: string | undefined): number | null => {
  const t = stamp ? Date.parse(stamp.replace(" ", "T")) : NaN;
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
  provider: string;
  model?: string;
  label: string;
  cwd: string;
  specFile: string;
}

export interface RerouteDeps {
  logDir: string;
  load?: (id: string) => WorkerStatus | null;
  /** "cloud" | "local" | a provider name -> the provider to start on (default: resolveTarget, the one resolver). */
  resolve?: (where: string) => Promise<RerouteTarget>;
  /** Stop the old worker the way `pai worker kill` does; it salvages the commits (default: killWorker). */
  kill?: (id: string, reason: string) => Promise<unknown>;
  /** Start the task on the target provider (default: a detached `pai worker run`). */
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

function defaultSpawn(s: SpawnSpec): void {
  const argv = ["worker", "run", "--provider", s.provider, "--label", s.label, "--spec", s.specFile, "--cwd", s.cwd, "--no-queue"];
  if (s.model) argv.push("--model", s.model);
  const child = spawn("pai", argv, { detached: true, stdio: "ignore", cwd: s.cwd, env: process.env });
  child.on("error", () => undefined);
  child.unref();
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
  writeFileSync(specFile, branch ? `${continuedNote(id, branch)}\n\n${text}` : text, "utf8");
  await (d.spawn ?? defaultSpawn)({ provider: target.provider, model: target.model, label: `${old.label} (rerouted)`, cwd: old.cwd, specFile });
  appendLedger(ledgerPath(d.logDir), "WORKER-REROUTE", { id, from: old.provider, to: target.provider, was: old.state, by, reason: d.reason, branch });
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
