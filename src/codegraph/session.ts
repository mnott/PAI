/**
 * Code graph for sessions and workers: the session-start line, the background
 * first index (one at a time per machine, behind a lock), the dirty list the
 * Edit/Write hook appends to, and the post-merge / nightly incremental runs.
 * No watcher: the graph is reconciled on query; this only decides when a
 * background `pai code index` is worth starting. Every effect is injectable.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { buildPassCommand } from "../daemon/pass-priority.js";
import type { StorageBackend } from "../storage/interface.js";
import { listFiles } from "./indexer.js";

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".py"]);

export const GRAPH_ASK_LINE =
  'Ask it first: pai code explore "<question>", callers <symbol>, callees <symbol> (MCP: code_explore, code_callers, …) before grepping.';
export const GRAPH_INDEXING_LINE =
  "Code graph: indexing this repo in the background (first run ~4 min for 1400 files); until then use grep as usual.";

const stateDir = (): string => paiHomePath("state", "codegraph");
const repoKey = (root: string): string => createHash("sha1").update(resolve(root)).digest("hex").slice(0, 12);
export const dirtyPath = (root: string): string => join(stateDir(), `dirty-${repoKey(root)}.txt`);
export const lockPath = (): string => join(stateDir(), "index.lock");

/** git repo with at least one source file of a supported language */
export function isCodeRepo(root: string): boolean {
  if (!existsSync(join(root, ".git"))) return false;
  try {
    return listFiles(root).some((f) => SOURCE_EXT.has(extname(f)));
  } catch {
    return false;
  }
}

export function formatAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 2880) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

// ---- dirty list (PostToolUse hook: append only, no parsing) ----

export function markDirty(root: string, file: string): void {
  const rootAbs = resolve(root);
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const abs = isAbsolute(file) ? file : resolve(rootAbs, file);
  const rel = relative(real(rootAbs), join(real(dirname(abs)), basename(abs)));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(dirtyPath(rootAbs), `${rel}\n`);
}

export function readDirty(root: string): string[] {
  try {
    return [...new Set(readFileSync(dirtyPath(root), "utf8").split("\n").filter(Boolean))];
  } catch {
    return [];
  }
}

/** Read and clear the dirty list. */
export function consumeDirty(root: string): string[] {
  const list = readDirty(root);
  if (list.length) rmSync(dirtyPath(root), { force: true });
  return list;
}

// ---- background index with a machine-wide lock ----

export interface LockInfo { pid: number; root: string; startedAt: number }

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The running index, or null (a stale lock is removed). */
export function runningIndex(alive: (pid: number) => boolean = pidAlive): LockInfo | null {
  try {
    const l = JSON.parse(readFileSync(lockPath(), "utf8")) as LockInfo;
    if (alive(l.pid)) return l;
    rmSync(lockPath(), { force: true });
  } catch { /* none */ }
  return null;
}

export interface BgDeps {
  /** why indexing must not start now (frozen, battery below the guard), else null */
  skipReason: () => Promise<string | null>;
  /** start the detached background-priority child; returns its pid */
  spawnIndex: (root: string) => number | null;
  alive: (pid: number) => boolean;
}

export const liveBgDeps: BgDeps = {
  skipReason: async () => {
    try {
      const { isFrozen } = await import("../workers/freeze.js");
      if (isFrozen()) return "frozen";
      const { readBattery } = await import("../daemon/battery-guard.js");
      const { readPowerConfig } = await import("../daemon/battery-gate.js");
      const r = await readBattery();
      const { cfg } = readPowerConfig();
      if (r && r.source === "battery" && r.pct !== null && r.pct <= cfg.pauseBelowPct) return `battery ${r.pct}%`;
    } catch { /* guards are best effort */ }
    return null;
  },
  spawnIndex: (root) => {
    const c = buildPassCommand(process.platform, "pai", "code", ["index", root]);
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore", cwd: root });
    child.on("error", () => undefined);
    child.unref();
    return child.pid ?? null;
  },
  alive: pidAlive,
};

export type BgResult = "started" | "running" | "busy" | "skipped";

/** Start `pai code index <root>` at background priority unless one runs on this machine or the guards say no. */
export async function startBackgroundIndex(root: string, deps: BgDeps = liveBgDeps): Promise<BgResult> {
  const rootAbs = resolve(root);
  const cur = runningIndex(deps.alive);
  if (cur) return cur.root === rootAbs ? "running" : "busy";
  if (await deps.skipReason()) return "skipped";
  const pid = deps.spawnIndex(rootAbs);
  if (pid === null) return "skipped";
  mkdirSync(dirname(lockPath()), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify({ pid, root: rootAbs, startedAt: Date.now() } satisfies LockInfo));
  return "started";
}

// ---- session start / workers ----

/** The one session-start line for a repo, starting the background index when it has none. Null: not a code repo or nothing to say. */
export async function sessionGraphLine(backend: StorageBackend, root: string, deps: BgDeps = liveBgDeps, now = Date.now()): Promise<string | null> {
  const rootAbs = resolve(root);
  if (!isCodeRepo(rootAbs)) return null;
  const s = await backend.codeGraph().stats(rootAbs);
  if (s.files > 0) {
    const age = s.lastIndexedAt != null ? formatAge(now - s.lastIndexedAt) : "earlier";
    return `Code graph: ${s.files} files indexed (updated ${age}). ${GRAPH_ASK_LINE}`;
  }
  const r = await startBackgroundIndex(rootAbs, deps);
  return r === "started" || r === "running" ? GRAPH_INDEXING_LINE : null;
}

/** True when the repo has an index (worker prompt line). */
export async function isIndexed(backend: StorageBackend, root: string): Promise<boolean> {
  return (await backend.codeGraph().stats(resolve(root))).files > 0;
}

/** After a merge / in the nightly pass: incremental background index, only for repos that already have one. */
export async function incrementalIndexIfIndexed(backend: StorageBackend, root: string, deps: BgDeps = liveBgDeps): Promise<BgResult | "unindexed"> {
  if (!(await isIndexed(backend, root))) return "unindexed";
  return startBackgroundIndex(root, deps);
}
