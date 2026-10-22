/**
 * scan.ts — the security scan a finished worker gets.
 *
 * `pai audit scan` is the interactive face; this is the automatic one: when
 * a run ends, its own event transcript is scanned with the rules module and
 * the per-severity counts go on the status (`findings`), shown by `ps` and
 * `replay` only when something hit. Best effort throughout — a scan must
 * never fail or slow the worker's end path.
 */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Finding } from "../audit/scan.js";
import { loadRules, projectRuleDirs, userRuleDirs } from "../hooks/ts/lib/rules/load.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";
import { eventsPath } from "./paths.js";
import { type WorkerStatus, saveStatus } from "./status.js";

export interface ScanCounts {
  block: number;
  confirm: number;
  warn: number;
}

/** Per-severity counts of findings; zero counts when there are none. */
export function scanCounts(findings: Finding[]): ScanCounts {
  const c: ScanCounts = { block: 0, confirm: 0, warn: 0 };
  for (const f of findings) c[f.severity as keyof ScanCounts]++;
  return c;
}

/** "scan: 1 block, 2 warn" over the non-zero severities; "" when nothing hit. */
export function scanLine(c: ScanCounts | undefined | null): string {
  if (!c) return "";
  const parts = (["block", "confirm", "warn"] as const).filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  return parts.length ? `scan: ${parts.join(", ")}` : "";
}

/**
 * The run's Claude Code transcript: the session file under the project dir
 * when it exists, else any project dir holding the session id. null when the
 * run never recorded a session.
 */
export function claudeSessionTranscript(sessionId: string, cwd: string, home = homedir()): string | null {
  const projects = join(home, ".claude", "projects");
  const own = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(own)) return own;
  try {
    for (const d of readdirSync(projects)) {
      const p = join(projects, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // no projects dir
  }
  return null;
}

/** The scan thread's entry: the built .mjs next to the bundle, else the TypeScript source (run through tsx). */
function scanThreadEntry(): { file: string; tsx?: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["audit/scan-thread.mjs", "../audit/scan-thread.mjs"]) {
    if (existsSync(join(here, rel))) return { file: join(here, rel) };
  }
  return { file: join(here, "../audit/scan-thread.ts"), tsx: createRequire(import.meta.url).resolve("tsx/cjs") };
}

/**
 * Scan transcripts in a worker_thread; the thread is terminated when budgetMs
 * is spent and "over" is returned. A synchronous regex cannot be interrupted
 * on the calling thread, a thread can be killed.
 */
export function scanInThread(paths: string[], rules: Rule[], budgetMs: number): Promise<Finding[] | "over"> {
  return new Promise((resolve, reject) => {
    const { file, tsx } = scanThreadEntry();
    // source tree (tests, dev): the thread loads the TypeScript through tsx's CJS hook
    const worker = tsx
      ? new Worker(`require(${JSON.stringify(tsx)}); require(${JSON.stringify(file)});`, { eval: true, workerData: { paths, rules } })
      : new Worker(file, { workerData: { paths, rules } });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve("over");
    }, budgetMs);
    timer.unref();
    worker.once("message", (m: { findings?: Finding[]; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.findings) resolve(m.findings);
      else reject(new Error(m.error ?? "scan failed"));
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Scan a finished run's transcript and put the counts on its status. The
 * worker's own event mirror is scanned; when the run also recorded a Claude
 * session, that transcript is scanned too (it carries the full tool results
 * the event mirror may trim). With `budgetMs` the scan runs in a thread that
 * is terminated when the budget expires: "over" is returned and the status
 * records "scan stopped: over budget". Never throws.
 */
export async function scanWorkerRun(
  logDir: string,
  status: WorkerStatus,
  opts: { cwd?: string; home?: string; budgetMs?: number } = {}
): Promise<ScanCounts | "over" | null> {
  try {
    const paths: string[] = [];
    const events = eventsPath(logDir, status.id);
    if (existsSync(events)) paths.push(events);
    if (status.claudeSession) {
      const t = claudeSessionTranscript(status.claudeSession, status.cwd, opts.home);
      if (t) paths.push(t);
    }
    if (!paths.length) return null;
    const { rules } = loadRules(userRuleDirs(opts.cwd ?? status.cwd), { projectDirs: projectRuleDirs(opts.cwd ?? status.cwd) });
    const found = await scanInThread(paths, rules, opts.budgetMs ?? 5000);
    if (found === "over") {
      if (!status.last) status.last = "scan stopped: over budget";
      status.scanStopped = "scan stopped: over budget";
      saveStatus(logDir, status);
      return "over";
    }
    const findings = found;
    const counts = scanCounts(findings);
    status.findings = counts;
    saveStatus(logDir, status);
    return counts;
  } catch {
    // the scan is a report on the run, never a reason the run ends badly
    return null;
  }
}
