/**
 * pool-cli.ts — the `pai worker pool on|off|status` implementations.
 *
 * on flips workers.pool.enabled in the main config and starts the detached
 * host (dist/hooks/worker-pool-host.mjs, same find-and-spawn pattern as the
 * openai proxy); off flips the flag back and shuts the host down; status
 * prints the live state: slots, tasks served, cache-carry total.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkersSection, writeWorkersSection } from "./config.js";
import { ledgerPath } from "./paths.js";
import { fmtTokens } from "./status.js";
import {
  formatCarryByProvider,
  poolCarry,
  poolDir,
  poolHostAlive,
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
  workers.pool = { ...(workers.pool ?? { enabled, maxSlots: 3, idleSecs: 900, port: 8798 }), enabled };
  writeWorkersSection(raw, workers);
}

/** POST /shutdown, best effort: a dead host needs no shutdown. */
function shutdownHost(port: number): void {
  const req = httpRequest({ host: "127.0.0.1", port, path: "/shutdown", method: "POST", timeout: 1500 }, (res) => {
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
  const script = standalonePoolHostPath();
  if (!script) {
    throw new Error(
      `the pool host build was not found — run \`bun run build\` first, ` +
        `or start one by hand: node dist/hooks/worker-pool-host.mjs --port ${port}`
    );
  }
  mkdirSync(logDir, { recursive: true });
  mkdirSync(poolDir(logDir), { recursive: true }); // the pid file lands before the host's first state write
  const child = spawn(process.execPath, [script, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    cwd: logDir,
  });
  child.unref();
  writeFileSync(poolPidPath(logDir), `${child.pid}\n`, "utf8");
  for (let i = 0; i < 40; i++) {
    if (await poolHostAlive(port)) {
      setPoolEnabled(true);
      return [
        `pool host started (pid ${child.pid}, port ${port}, cwd ${logDir})`,
        `routing enabled: eligible headless runs (no worktree, no own system prompt/MCP) go through the pool`,
        `slots: max ${settings.maxSlots}, idle kill ${settings.idleSecs}s`,
      ];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the pool host did not come up on port ${port} (see ${poolPidPath(logDir)})`);
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
      `${alive ? "alive" : "NOT answering (state file is stale)"}`
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
