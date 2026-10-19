/**
 * plan-deps.ts — the real RunnerDeps of `pai plan run`: workers, merges and
 * checks are the existing `pai worker run` / `pai worker merge` verbs, run as
 * child processes of this same binary (PAI_BIN, else `pai`).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerReport } from "./report.js";
import { eventsPath } from "./paths.js";
import { loadStatuses } from "./status.js";
import { sumRunUsage } from "./usage.js";
import { appendRunLog, tail, type MergeOutcome, type RunnerDeps, type StartRequest, type WorkerOutcome } from "./plan-runner.js";
import type { Plan } from "./plan.js";

interface Captured {
  code: number | null;
  out: string;
  err: string;
}

function capture(cmd: string, args: string[], cwd: string, shell = false): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, shell });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: 1, out, err: err + e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const pai = (): string => process.env.PAI_BIN || "pai";

/** Tokens a finished worker used, from its run log; null when unavailable. */
function workerTokens(logDir: string, id: string): number | null {
  try {
    const sum = sumRunUsage(readFileSync(eventsPath(logDir, id), "utf8"));
    let n = 0;
    for (const t of sum.byModel.values()) n += t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.output;
    return n || null;
  } catch {
    return null;
  }
}

/** Paths with uncommitted changes in the plan's repo (`git status --porcelain`). */
export async function dirtyPaths(repo: string): Promise<string[]> {
  const r = await capture("git", ["status", "--porcelain"], repo);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
}

export function realRunnerDeps(plan: Plan, logDir: string, logPath: string): RunnerDeps {
  const dir = mkdtempSync(join(tmpdir(), "pai-plan-"));
  return {
    now: Date.now,
    log: (e) => appendRunLog(logPath, e),
    async startWorker(req: StartRequest): Promise<WorkerOutcome> {
      const specFile = join(dir, `${req.part.id}-${req.attempt}.txt`);
      writeFileSync(specFile, req.spec, "utf8");
      const t0 = Date.now() - 1000;
      const args = ["worker", "run", "--provider", req.provider, "--class", "implement", ...(req.tier === "sonnet" ? ["--model", "sonnet"] : []), "--label", req.label, "--spec", specFile, "--cwd", plan.repo, "--no-pane", "--output-format", "json"];
      const r = await capture(pai(), args, plan.repo);
      const st = loadStatuses(logDir)
        .filter((s) => s.label === req.label && Date.parse(s.started) >= t0)
        .sort((a, b) => b.started.localeCompare(a.started))[0];
      if (!st) return { id: "", ok: false, failure: tail(r.err || r.out) || `worker did not start (exit ${r.code})` };
      let text = "";
      try {
        text = (JSON.parse(r.out) as { result?: string }).result ?? "";
      } catch {
        text = r.out;
      }
      const report = parseWorkerReport(text);
      const passed = !!report && (report.result ? report.result === "+" : (report.checks ?? []).every((c) => c.ok !== false));
      const ok = st.state === "done" && (st.rc ?? 0) === 0 && passed;
      const failure = ok ? undefined : !report ? `worker ended without a valid report (${st.state}): ${tail(text || r.err, 15)}` : [report.why, ...(report.open ?? []), report.notes].filter(Boolean).join("\n") || `report result ${report.result ?? "?"}`;
      return { id: st.id, ok, failure, tokens: workerTokens(logDir, st.id) };
    },
    async merge(id: string, gate: string): Promise<MergeOutcome> {
      const rev = async (...a: string[]) => (await capture("git", a, plan.repo)).out.trim();
      const before = await rev("rev-parse", "HEAD");
      const ahead = Number(await rev("rev-list", "--count", `HEAD..worker/${id}`));
      if (!(ahead > 0)) return { ok: false, noCommit: true, before, output: `branch worker/${id} has no commit beyond ${before.slice(0, 7)}` };
      const r = await capture(pai(), ["worker", "merge", id, "--verify", gate], plan.repo);
      const output = r.out + r.err;
      if (r.code !== 0) return { ok: false, before, output };
      const head = await rev("rev-parse", "HEAD");
      return { ok: true, commit: head || undefined, before, output };
    },
    async unitCheck(cmd: string) {
      const r = await capture(cmd, [], plan.repo, true);
      return { ok: r.code === 0, output: r.out + r.err };
    },
  };
}
