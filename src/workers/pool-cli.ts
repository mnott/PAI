/**
 * pool-cli.ts — the `pai worker pool on|off|status` implementations.
 *
 * on flips workers.pool.enabled in the main config and starts the detached
 * host (dist/hooks/worker-pool-host.mjs, same find-and-spawn pattern as the
 * openai proxy); off flips the flag back and shuts the host down; status
 * prints the live state: slots, tasks served, cache-carry total.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkersSection, writeWorkersSection } from "./config.js";
import { ledgerPath } from "./paths.js";
import { openHostLog } from "./pool-host-run.js";
import { fmtTokens } from "./status.js";
import {
  formatCarryByProvider,
  poolCarry,
  poolDir,
  poolHostAlive,
  poolHostStale,
  bundleBuildStamp,
  poolPort,
  poolSettings,
  poolPidPath,
  readPoolMetrics,
  poolMetricsPath,
  readPoolState,
  spareStats,
  type PoolState,
} from "./pool.js";
import { request as httpRequest } from "node:http";
import { LOOPBACK_HOST } from "../utils/loopback.js";

/** Where the standalone host bundle lives (see standaloneProxyPath in proxy/server.ts). */
export function standalonePoolHostPath(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const cand of [
      join(dir, "worker-pool-host.mjs"),
      join(dir, "hooks", "worker-pool-host.mjs"),
      join(dir, "dist", "hooks", "worker-pool-host.mjs"),
    ]) {
      if (existsSync(cand)) return cand;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function setPoolEnabled(enabled: boolean): void {
  const { raw, workers } = readWorkersSection();
  workers.pool = { ...(workers.pool), enabled };
  writeWorkersSection(raw, workers);
}

/** POST /shutdown, best effort: a dead host needs no shutdown. */
function shutdownHost(port: number): void {
  const req = httpRequest({ host: LOOPBACK_HOST, port, path: "/shutdown", method: "POST", timeout: 1500 }, (res) => {
    res.resume();
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => {});
  req.end();
}

export async function poolOn(logDir: string): Promise<string[]> {
  const { workers } = readWorkersSection();
  const settings = poolSettings(workers);
  const port = settings.port;
  if (await poolHostAlive(port)) {
    setPoolEnabled(true);
    return [`pool host already running on port ${port} — routing enabled`];
  }
  const started = await startPoolHost(logDir, port, 10_000);
  if (!started.up) throw new Error(`the pool host did not come up on port ${port} (see ${poolPidPath(logDir)})`);
  const pid = started.pid;
  setPoolEnabled(true);
  return [
    `pool host started (pid ${pid}, port ${port}, cwd ${logDir})`,
    `routing enabled: eligible headless runs (no worktree, no own system prompt/MCP) go through the pool`,
    `slots: max ${settings.maxSlots}, idle kill ${settings.idleSecs}s`,
  ];
}

/** Spawn the detached host and wait up to waitMs for it to answer; `up` false = still starting. Does not touch the config. */
async function startPoolHost(logDir: string, port: number, waitMs: number): Promise<{ pid: number | undefined; up: boolean }> {
  const script = standalonePoolHostPath();
  if (!script) {
    throw new Error(
      `the pool host build was not found — run \`bun run build\` first, ` +
        `or start one by hand: node dist/hooks/worker-pool-host.mjs --port ${port}`
    );
  }
  mkdirSync(logDir, { recursive: true });
  mkdirSync(poolDir(logDir), { recursive: true }); // the pid file lands before the host's first state write
  const logFd = openHostLog(logDir);
  const child = spawn(process.execPath, [script, "--port", String(port), "--handover"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: logDir,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(poolPidPath(logDir), `${child.pid}\n`, "utf8");
  for (let i = 0; i < waitMs / 250; i++) {
    if (await poolHostAlive(port)) return { pid: child.pid, up: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { pid: child.pid, up: false };
}

export interface PoolReloadDeps {
  alive: () => Promise<boolean>;
  /** True while any claimed slot is working. */
  busy: () => boolean;
  stop: () => void;
  start: () => Promise<{ pid: number | undefined; up: boolean }>;
  /** Called once when the reload starts waiting for busy slots. */
  onWaiting?: () => void;
  sleep?: (ms: number) => Promise<void>;
  /** Give up waiting for busy slots after this long (default 15 min). */
  maxWaitMs?: number;
}

/** Restart the pool host gracefully: claimed slots finish first, then idle spares are retired with the host and recreated by the new one. Null when no host runs. */
export async function reloadPoolHost(d: PoolReloadDeps): Promise<{ waitedMs: number; newPid: number | undefined; starting: boolean } | null> {
  if (!(await d.alive())) return null;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = d.maxWaitMs ?? 15 * 60_000;
  let waited = 0;
  while (d.busy()) {
    if (waited === 0) d.onWaiting?.();
    if (waited >= limit) throw new Error(`pool slots still busy after ${Math.round(limit / 1000)}s; host not restarted`);
    await sleep(1000);
    waited += 1000;
  }
  d.stop();
  for (let i = 0; i < 40 && (await d.alive()); i++) await sleep(250);
  const started = await d.start();
  return { waitedMs: waited, newPid: started.pid, starting: !started.up };
}

/** Live wiring of reloadPoolHost for `pai reload`. */
export async function poolReloadLive(logDir: string): Promise<{ oldPid: number | undefined; newPid: number | undefined; builtAt: string | null; starting: boolean } | null> {
  const port = poolPort(readWorkersSection().workers);
  const pidPath = poolPidPath(logDir);
  const pidOf = (): number | undefined => {
    try {
      return parseInt(readFileSync(pidPath, "utf8").trim(), 10) || undefined;
    } catch {
      return undefined;
    }
  };
  const oldPid = pidOf();
  const r = await reloadPoolHost({
    alive: () => poolHostAlive(port),
    busy: () => !!readPoolState(logDir)?.slots.some((s) => s.busyWith),
    stop: () => {
      shutdownHost(port);
      if (oldPid) {
        try {
          process.kill(oldPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    },
    onWaiting: () => process.stdout.write("pool host: waiting for busy slots\n"),
    start: () => startPoolHost(logDir, port, 60_000),
  });
  if (!r) return null;
  const m = readPoolState(logDir)?.bundleMtimeMs;
  return { oldPid, newPid: r.newPid, starting: r.starting, builtAt: m === undefined ? null : bundleBuildStamp(m) };
}

export async function poolOff(logDir: string): Promise<string[]> {
  const { workers } = readWorkersSection();
  const port = poolPort(workers);
  setPoolEnabled(false);
  shutdownHost(port);
  const lines = [`routing disabled — every run spawns fresh again`];
  const pidPath = poolPidPath(logDir);
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    unlinkSync(pidPath);
    try {
      process.kill(pid, "SIGTERM");
      lines.push(`pool host pid ${pid} stopped`);
    } catch {
      lines.push(`pool host pid ${pid} was not running (pid file removed)`);
    }
  } else {
    lines.push(`no pool host pid file — nothing to stop`);
  }
  return lines;
}

/** mtime of the bundle on disk, null when there is none. */
export function diskBundleMtime(): number | null {
  const p = standalonePoolHostPath();
  try {
    return p ? statSync(p).mtimeMs : null;
  } catch {
    return null;
  }
}

/** "built <stamp>" plus the stale marker when a newer build sits on disk. */
export function hostBuildText(state: PoolState, diskMtimeMs: number | null): string {
  if (state.bundleMtimeMs === undefined) return "build unknown (host predates build tracking)";
  const built = `built ${bundleBuildStamp(state.bundleMtimeMs)}`;
  return poolHostStale(state.bundleMtimeMs, diskMtimeMs) ? `${built}, stale (newer build on disk)` : built;
}

/** The `pai worker pool status` text: config, host, slots, carry. */
export async function poolStatusText(logDir: string): Promise<string> {
  const { workers } = readWorkersSection();
  const settings = poolSettings(workers);
  const port = settings.port;
  const alive = await poolHostAlive(port);
  const lines: string[] = [];
  lines.push(
    `pool: ${settings.enabled ? "enabled" : "disabled"} (config workers.pool; host port ${port}; ` +
      `spares ${settings.spares}/key${settings.spares === 0 ? " = off" : ""}, retired after ${settings.idleKillSec}s idle` +
      `${settings.continuation ? `; continuation on: max ${settings.maxSlots} slots, idle kill ${settings.idleSecs}s` : ""})`
  );
  const state = readPoolState(logDir);
  if (!state) {
    lines.push(alive ? `host: alive on port ${port} (no state file yet)` : `host: not running`);
    return lines.join("\n");
  }
  lines.push(
    `host: pid ${state.hostPid}, port ${state.port}, up since ${state.startedAt}, ` +
      `${alive ? "alive" : "NOT answering (state file is stale)"}, ` +
      hostBuildText(state, diskBundleMtime())
  );
  lines.push(...spareStatusLines(state, logDir));
  if (state.slots.length) {
    lines.push(`slots (${state.slots.length}):`);
    for (const s of state.slots) {
      lines.push(
        `  ${s.provider}/${s.model} pid ${s.pid} session ${(s.claudeSession ?? "?").slice(0, 8)} ` +
          `tasks ${s.tasks} ${s.busyWith ? `busy ${s.busyWith}` : "idle"} last ${s.lastUsedAt}`
      );
    }
  } else if (settings.continuation) {
    lines.push(`slots: none (a slot spawns with the first pooled task)`);
  }
  const rows = readPoolMetrics(poolMetricsPath(logDir));
  const carry = poolCarry(rows);
  lines.push(
    `tasks served ${state.tasksServed} · carried ${fmtTokens(carry.tokensCarried)} cache-read tokens · ` +
      `first-request hit ratio ${formatCarryByProvider(rows)}`
  );
  return lines.join("\n");
}

const secs = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);

/** Spares per key, claims, misses with reasons, mean setup saved (claims and timings read from the ledger). */
export function spareStatusLines(state: PoolState, logDir: string): string[] {
  const lines: string[] = [];
  const spares = state.spares ?? [];
  const byKey = new Map<string, number>();
  for (const sp of spares) {
    const k = `${sp.repo} · ${sp.provider}/${sp.model}`;
    byKey.set(k, (byKey.get(k) ?? 0) + (sp.state === "ready" ? 1 : 0));
  }
  if (byKey.size) {
    lines.push(`spares (${spares.length}):`);
    for (const [k, ready] of byKey) lines.push(`  ${k}: ${ready} ready${spares.some((x) => `${x.repo} · ${x.provider}/${x.model}` === k && x.state === "starting") ? ", 1+ starting" : ""}`);
  } else {
    lines.push(`spares: none (one starts per repo+provider after a worker ran on it)`);
  }
  let text = "";
  try {
    text = readFileSync(ledgerPath(logDir), "utf8");
  } catch {
    /* no ledger yet */
  }
  const st = spareStats(text);
  const reasons = Object.entries(st.missReasons).map(([r, n]) => `${r} ${n}`).join(", ");
  lines.push(
    `claims ${st.hits} hit, ${st.misses} miss${reasons ? ` (${reasons})` : ""} · setup on a hit ${secs(st.meanHitSetupMs)} vs ${secs(st.meanMissSetupMs)} fresh · ` +
      `mean setup saved ${secs(st.meanSavedMs)}`
  );
  return lines;
}
