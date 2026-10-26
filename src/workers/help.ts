/**
 * help.ts — `pai worker help`: a worker with a budget asks a stronger model
 * to do one sub-task, then continues with the answer.
 *
 * The risk is a local worker deferring everything upward, so every call is
 * counted per orchestrated unit (scope) and refused past the budget, and
 * every call lands in `<logDir>/help-ledger.jsonl` so the help rate is
 * measurable (`pai worker help --report`).
 *
 * Scope: PAI_HELP_SCOPE when the orchestrator set it, else the top-most
 * ancestor in the caller's parent chain, else the caller itself.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadStatuses, type WorkerStatus } from "./status.js";
import { parentFromEnv } from "./tree.js";

export const DEFAULT_HELP_BUDGET = 2;
export const HELP_MAX_MINUTES = 20;
/** Exit code of a refused call. */
export const HELP_REFUSED_EXIT = 4;

export interface HelpEntry {
  ts: string;
  caller: string | null;
  scope: string;
  task: string;
  provider: string;
  model: string;
  durationMs: number;
  tokens: number | null;
  outcome: "ok" | "failed";
}

export function helpLedgerPath(logDir: string): string {
  return join(logDir, "help-ledger.jsonl");
}

export function readHelpLedger(logDir: string, scope?: string): HelpEntry[] {
  const path = helpLedgerPath(logDir);
  if (!existsSync(path)) return [];
  const out: HelpEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HelpEntry;
      if (!scope || e.scope === scope) out.push(e);
    } catch {
      // half-written line: skip
    }
  }
  return out;
}

export function appendHelpEntry(logDir: string, e: HelpEntry): void {
  const path = helpLedgerPath(logDir);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
}

/** The unit a help call is counted against. */
export function resolveHelpScope(
  statuses: Pick<WorkerStatus, "id" | "parent">[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const set = env.PAI_HELP_SCOPE?.trim();
  if (set) return set;
  const me = parentFromEnv(env);
  if (!me) return "session";
  const byId = new Map(statuses.map((s) => [s.id, s]));
  let cur = me;
  const seen = new Set([cur]);
  for (;;) {
    const p = byId.get(cur)?.parent;
    if (!p || seen.has(p) || !byId.has(p)) return cur;
    seen.add(p);
    cur = p;
  }
}

export function helpBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PAI_HELP_BUDGET);
  return Number.isInteger(n) && n >= 0 && env.PAI_HELP_BUDGET?.trim() ? n : DEFAULT_HELP_BUDGET;
}

export interface HelpRunResult {
  /** The sub-worker's final report text. */
  report: string;
  tokens: number | null;
  ok: boolean;
}

export interface HelpDeps {
  /** Run the sub-worker to completion. */
  spawnWorker: (argv: string[], cwd: string) => Promise<HelpRunResult>;
  /** Files changed in cwd (git porcelain paths). */
  changedFiles: (cwd: string) => string[];
  now: () => number;
}

export interface HelpRequest {
  task: string;
  provider: string;
  model: string;
  files: string[];
  cwd: string;
}

export type HelpOutcome =
  | { refused: true; message: string }
  | { refused: false; text: string; ok: boolean };

export function helpArgv(req: HelpRequest): string[] {
  const files = req.files.length ? `\n\nRelevant files: ${req.files.join(", ")}` : "";
  return [
    "worker", "run",
    "--provider", req.provider,
    "--model", req.model,
    "--class", "implement",
    "--no-worktree",
    "--max-minutes", String(HELP_MAX_MINUTES),
    "--label", `help: ${req.task.slice(0, 60)}`,
    "--output-format", "json",
    "-p", `${req.task}${files}`,
  ];
}

export async function requestHelp(
  logDir: string,
  req: HelpRequest,
  deps: HelpDeps,
  env: NodeJS.ProcessEnv = process.env
): Promise<HelpOutcome> {
  const scope = resolveHelpScope(loadStatuses(logDir), env);
  const budget = helpBudget(env);
  const used = readHelpLedger(logDir, scope).length;
  if (used >= budget) {
    return { refused: true, message: `help budget used (${used}/${budget}): report the blocker in your R x= line instead` };
  }
  const before = new Set(deps.changedFiles(req.cwd));
  const t0 = deps.now();
  let res: HelpRunResult;
  try {
    res = await deps.spawnWorker(helpArgv(req), req.cwd);
  } catch (e) {
    res = { report: e instanceof Error ? e.message : String(e), tokens: null, ok: false };
  }
  appendHelpEntry(logDir, {
    ts: new Date(t0).toISOString(),
    caller: parentFromEnv(env),
    scope,
    task: req.task,
    provider: req.provider,
    model: req.model,
    durationMs: deps.now() - t0,
    tokens: res.tokens,
    outcome: res.ok ? "ok" : "failed",
  });
  const changed = deps.changedFiles(req.cwd).filter((f) => !before.has(f));
  const text = `${res.report.trim()}\n\nchanged files: ${changed.length ? changed.join(", ") : "none"}`;
  return { refused: false, text, ok: res.ok };
}

export function renderHelpReport(entries: HelpEntry[]): string {
  if (!entries.length) return "no help calls recorded";
  const lines = entries.map(
    (e) =>
      `${e.ts}  scope=${e.scope}  caller=${e.caller ?? "-"}  ${e.provider}/${e.model}  ` +
      `${Math.round(e.durationMs / 1000)}s  tokens=${e.tokens ?? "?"}  ${e.outcome}  ${e.task.replace(/\s+/g, " ").slice(0, 80)}`
  );
  const perScope = new Map<string, number>();
  for (const e of entries) perScope.set(e.scope, (perScope.get(e.scope) ?? 0) + 1);
  lines.push("", [...perScope].map(([s, n]) => `${s}: ${n} call${n === 1 ? "" : "s"}`).join("; "));
  return lines.join("\n");
}

/** Paths from `git status --porcelain -z`: NUL-separated, unquoted; a rename entry is followed by its source path. */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    files.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C" || e[1] === "R" || e[1] === "C") i++;
  }
  return files;
}

/** Real changed-file lister: git porcelain paths, empty outside git. */
export function gitChangedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "-z"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return parsePorcelainZ(out);
  } catch {
    return [];
  }
}

/** Real spawn: the same pai binary, `worker run --output-format json`; parses claude's result JSON. */
export function spawnPaiWorker(argv: string[], cwd: string): Promise<HelpRunResult> {
  return new Promise((resolve) => {
    const bin = process.env.PAI_BIN || "pai";
    const child = spawn(bin, argv, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    let errText = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errText += d));
    child.on("error", (e) => resolve({ report: e.message, tokens: null, ok: false }));
    child.on("close", (code) => {
      try {
        const j = JSON.parse(out) as { result?: string; usage?: Record<string, number>; is_error?: boolean };
        const u = j.usage ?? {};
        const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        resolve({ report: j.result ?? out, tokens: tokens || null, ok: code === 0 && j.is_error !== true });
      } catch {
        resolve({ report: (out || errText).trim(), tokens: null, ok: code === 0 });
      }
    });
  });
}
