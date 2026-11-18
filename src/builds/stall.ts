/**
 * stall.ts — a running build job whose output stands still holds its key for nobody's benefit.
 * Incident 2026-10-20: an xcodebuild test run hung in one XCTest case for 17 min while two jobs queued
 * behind its key. The daemon ticks this every 30 s: a running ticket whose gate log plus declared door
 * logs (ticket.logs) have not grown for `minutes` is marked stalledAt (shown as STALLED by `pai build queue`,
 * ps and the cockpit), logged BUILD-STALL with the last output line, and its owner is told once. Never kills.
 * Silent is not hung (incident 2026-10-28: a door piping xcodebuild through sed flushes in bursts while
 * App Tamer SIGSTOPs the compilers — the logs stay 0 bytes over a working build): the `busy` dep — wait-on's
 * treeBusy by default — samples the build's process tree, and a busy tree resets the quiet window instead
 * of flagging.
 */

import { execFile, execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchTicket, releaseStalled, stallReleaseLine, type BuildTicket } from "./queue.js";
import { killProcessTree, processTree, treeBusy } from "../workers/wait-on.js";

export interface StallDeps {
  /** Size of a file, null when unreadable. */
  size: (path: string) => number | null;
  /** Last non-empty line of a file, "" when none. */
  lastLine: (path: string) => string;
  now: () => number;
  log: (line: string) => void;
  /** Tell the owning session. Resolves false (or rejects) when the message did not get through: it is retried next tick. */
  notify: (t: BuildTicket, text: string) => Promise<unknown> | void;
  /** Is the build's process tree doing work although its logs stand still (default: wait-on's treeBusy). */
  busy: (pid: number) => Promise<{ busy: boolean; why: string }>;
  /** Automatic release of a held lock that is silent and idle (omitted: the tick only flags, as before). */
  release?: StallReleaseDeps;
}

/** The stall policy: a lock whose build printed nothing for `minutes` and whose tree uses under `maxCpuPct` (or is gone) is released. */
export interface StallReleaseDeps {
  minutes: number;
  /** Largest CPU % of the whole process tree that still counts as idle (default 5). */
  maxCpuPct?: number;
  /** Summed CPU % of the tree rooted at `root`; null when the root is gone. */
  cpuPct: (root: number) => number | null;
  /** Save what the tree was doing (sample / ps) before it is killed. Returns the file written, if any. */
  capture: (t: BuildTicket, root: number) => Promise<string | null>;
  /** Kill exactly the processes of the tree rooted at `root`, nothing else. */
  kill: (root: number) => Promise<void>;
  /** Ledger line BUILD-STALL-RELEASE. */
  ledger: (event: string, kv: Record<string, string | number>) => void;
}

export const DEFAULT_RELEASE_MAX_CPU_PCT = 5;

/** Per-ticket watch state, kept by the caller between ticks. */
export type StallState = Map<string, { sig: string; since: number; busy?: boolean; outAt: number; notified?: boolean }>;

/** The build's process tree: the detached command's group root when recorded, else the gate process. */
const treeRoot = (t: BuildTicket): number => (t.pgid && t.pgid > 1 ? t.pgid : t.pid);

export const XCODE_TIMEOUT_HINT = "-test-timeouts-enabled YES -default-test-execution-time-allowance 60 -maximum-test-execution-time-allowance 120";

export const realSize = (p: string): number | null => {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
};

export function realLastLine(p: string): string {
  try {
    const size = statSync(p).size;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    const fd = openSync(p, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

const watched = (t: BuildTicket): string[] => [...new Set([t.log, ...(t.logs ?? [])].filter((x): x is string => !!x))];

/** Newest write time (epoch ms) among the ticket's log files, null when none exists. */
export function lastOutputAt(t: BuildTicket, mtime: (p: string) => number | null = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } }): number | null {
  const ts = watched(t).map(mtime).filter((x): x is number => x !== null);
  return ts.length ? Math.max(...ts) : null;
}

const isXcode = (t: BuildTicket, last: string): boolean => /xcodebuild|xctest|\.xcodeproj|Test Case '/i.test(`${t.cmd} ${t.key ?? ""} ${last}`);

const mins = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function stallMessage(t: BuildTicket, quietMs: number, last: string, behind: BuildTicket[]): string {
  const jobs = behind.length ? behind.map((b) => `${b.label} (${b.session})`).join(", ") : "none";
  const hint = isXcode(t, last) ? `; xcodebuild: add ${XCODE_TIMEOUT_HINT} so a hung test fails instead of holding the key` : "";
  return `build ${t.label}${t.key ? ` [${t.key}]` : ""} stalled ${mins(quietMs)} min; last line: ${last || "(no output)"}; jobs waiting behind it: ${jobs}${hint}. Not killed: stop it with \`pai build release ${t.id}\` or kill the worker.`;
}

/** One pass over the tickets; returns the ids newly flagged. */
export async function stallTick(dir: string, tickets: BuildTicket[], minutes: number, state: StallState, deps: StallDeps): Promise<string[]> {
  const now = deps.now();
  const flagged: string[] = [];
  const running = tickets.filter((t) => t.state === "running");
  for (const id of [...state.keys()]) if (!running.some((t) => t.id === id)) state.delete(id);
  for (const t of running) {
    const files = watched(t);
    const sig = files.map((f) => `${f}=${deps.size(f) ?? "-"}`).join("|");
    const prev = state.get(t.id);
    if (!prev || prev.sig !== sig) {
      state.set(t.id, { sig, since: now, outAt: now });
      if (t.stalledAt) await patchTicket(dir, t.id, { stalledAt: undefined });
      continue;
    }
    // Held, silent and idle for the release threshold: release the lock and kill the tree. A tree that
    // still burns CPU is left to the flag-only path below (a slow build is not a hang).
    const rel = deps.release;
    if (rel && now - prev.outAt >= rel.minutes * 60_000) {
      const root = treeRoot(t);
      const pct = rel.cpuPct(root);
      if (pct === null || pct < (rel.maxCpuPct ?? DEFAULT_RELEASE_MAX_CPU_PCT)) {
        await releaseStall(dir, t, root, pct, now - prev.outAt, files, tickets, rel, deps);
        state.delete(t.id);
        flagged.push(t.id);
        continue;
      }
    }
    // Silent logs over a busy tree are a slow build, not a hang (see the header): reset the quiet
    // window like a log change would, and clear a flag raised before the tree went busy again.
    if ((await deps.busy(treeRoot(t))).busy) {
      state.set(t.id, { sig, since: now, busy: true, outAt: prev.outAt });
      if (t.stalledAt) await patchTicket(dir, t.id, { stalledAt: undefined });
      continue;
    }
    const quiet = now - prev.since;
    // flagged but the owner was not reached (router/broker starved): try again, the flag alone is not an alert
    if (t.stalledAt && !prev.notified) {
      const last = files.map((f) => deps.lastLine(f)).filter(Boolean).pop() ?? "";
      const behind = tickets.filter((x) => x.state === "waiting" && x.key && x.key === t.key);
      prev.notified = await deliver(deps, t, stallMessage(t, quiet, last, behind));
      continue;
    }
    if (t.stalledAt || quiet < minutes * 60_000) continue;
    const last = files.map((f) => deps.lastLine(f)).filter(Boolean).pop() ?? "";
    await patchTicket(dir, t.id, { stalledAt: now });
    const behind = tickets.filter((x) => x.state === "waiting" && x.key && x.key === t.key);
    const text = stallMessage(t, quiet, last, behind);
    deps.log(`BUILD-STALL ${t.id} ${t.label} key=${t.key ?? "-"} quiet=${mins(quiet)}m last=${last || "-"}`);
    state.set(t.id, { ...(state.get(t.id) ?? prev), notified: await deliver(deps, t, text) });
    flagged.push(t.id);
  }
  return flagged;
}

/** True when the message reached the session (notify did not resolve false or throw). */
async function deliver(deps: StallDeps, t: BuildTicket, text: string): Promise<boolean> {
  try {
    return (await Promise.resolve(deps.notify(t, text))) !== false;
  } catch {
    return false;
  }
}

async function releaseStall(dir: string, t: BuildTicket, root: number, pct: number | null, quietMs: number, files: string[], tickets: BuildTicket[], rel: StallReleaseDeps, deps: StallDeps): Promise<void> {
  const quietMin = Math.max(1, Math.floor(quietMs / 60_000));
  const last = files.map((f) => deps.lastLine(f)).filter(Boolean).pop() ?? "";
  let saved: string | null = null;
  try {
    saved = await rel.capture(t, root); // what the build was doing, before it is killed
  } catch {
    /* diagnosis never blocks the release */
  }
  if (pct !== null) await rel.kill(root).catch(() => undefined);
  await releaseStalled(dir, t.id, quietMin);
  rel.ledger("BUILD-STALL-RELEASE", { id: t.id, pid: root, gate: t.pid, cmd: t.cmd, key: t.key ?? "-", quiet: `${quietMin}m`, cpu: pct === null ? "gone" : `${pct}%`, saved: saved ?? "-" });
  deps.log(`BUILD-STALL-RELEASE ${t.id} ${t.label} quiet=${quietMin}m cpu=${pct === null ? "gone" : pct + "%"} last=${last || "-"}`);
  const behind = tickets.filter((x) => x.state === "waiting" && x.key && x.key === t.key);
  await deliver(deps, t, `${stallReleaseLine({ id: t.id, label: t.label, minutes: quietMin, at: 0 })} (${t.label}${t.key ? ` [${t.key}]` : ""}; tree ${pct === null ? "gone" : "killed"}; ${behind.length} job(s) waiting; diagnosis: ${saved ?? "none"})`);
}

/** Real process probes for the release policy: ps for CPU % and the tree, sample/ps saved next to the build log. */
export function realReleaseDeps(dir: string, minutes: number, ledger: StallReleaseDeps["ledger"]): StallReleaseDeps {
  return {
    minutes,
    cpuPct: (root) => {
      const tree = processTree(root);
      try {
        const rows = execFileSync("ps", ["-o", "pid=,%cpu=", "-p", tree.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
        if (!rows.length) return null;
        return Math.round(rows.reduce((a, r) => a + (Number(r.trim().split(/\s+/)[1]) || 0), 0) * 10) / 10;
      } catch {
        return null;
      }
    },
    capture: async (t, root) => {
      mkdirSync(dir, { recursive: true });
      const base = join(dir, `${t.id}.stall`);
      const tree = processTree(root);
      let ps = "";
      try {
        ps = execFileSync("ps", ["-o", "pid,ppid,stat,%cpu,etime,command", "-p", tree.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        ps = "(process tree gone)\n";
      }
      writeFileSync(`${base}.ps.txt`, ps, "utf8");
      if (process.platform !== "darwin") return `${base}.ps.txt`;
      // sample the compiler/test process if there is one, else the tree root
      const rows = ps.split("\n").slice(1);
      const hit = rows.find((r) => /xcodebuild|xctest|swift-frontend|clang|testmanagerd/.test(r));
      const pid = hit ? Number(hit.trim().split(/\s+/)[0]) : tree.length ? root : 0;
      if (pid > 1) {
        await new Promise<void>((resolve) => execFile("sample", [String(pid), "5", "-file", `${base}.sample.txt`], { timeout: 20_000 }, () => resolve()));
      }
      return base;
    },
    kill: (root) => killProcessTree(root),
    ledger,
  };
}

/** The daemon's stall alert: straight to the owner's AIBroker session (noReply), no router and no run-report
 *  messenger chain (both starve first on a loaded machine). false = not delivered, the tick retries. */
export async function directAlert(
  target: string | undefined,
  text: string,
  send: (target: string, text: string, timeoutMs: number, opts: { noReply: boolean }) => Promise<{ ok: boolean }>
): Promise<boolean> {
  if (!target) return false;
  return (await send(target, text, 10_000, { noReply: true })).ok;
}

const daemonState: StallState = new Map();

/** Daemon tick: real files, ledger-less BUILD-STALL on stderr, owner told through `tell`. */
export async function buildStallTick(dir: string, minutes: number, tell: (t: BuildTicket, text: string) => Promise<unknown>, tickets: BuildTicket[], deps: Partial<StallDeps> = {}): Promise<string[]> {
  return stallTick(dir, tickets, minutes, daemonState, {
    size: realSize,
    lastLine: realLastLine,
    now: Date.now,
    log: (l) => process.stderr.write(l + "\n"),
    notify: tell,
    busy: treeBusy,
    ...deps,
  });
}
