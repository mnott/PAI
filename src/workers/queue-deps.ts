/**
 * queue-deps.ts — the real QueueDeps of `pai queue`: workers and merges are the
 * plan runner's launchWorker / mergeBranch; git and shell calls run as children.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, launchWorker, mergeBranch, realCommitsAhead, stopLaunchedWorkers } from "./plan-deps.js";
import { parseNumstat } from "./queue.js";
import type { QueueDeps } from "./queue-runner.js";
import { resolveRunnerProvider } from "./local-provider.js";

export function realQueueDeps(logDir: string, repo: string): QueueDeps {
  const dir = mkdtempSync(join(tmpdir(), "pai-queue-"));
  const git = async (repo: string, ...a: string[]) => (await capture("git", a, repo)).out;
  return {
    async startWorker(req) {
      const specFile = join(dir, `${req.itemId}-${req.attempt}.txt`);
      writeFileSync(specFile, req.spec, "utf8");
      return launchWorker(req, specFile, repo, logDir);
    },
    async inspect(repo, id) {
      const base = (await git(repo, "merge-base", "HEAD", `worker/${id}`)).trim();
      const range = `${base}..worker/${id}`;
      const size = parseNumstat(await git(repo, "diff", "--numstat", range));
      return { ...size, stat: (await git(repo, "diff", "--stat", range)).trim(), commits: await realCommitsAhead(repo, base, id) };
    },
    async sh(cmd, cwd) {
      const r = await capture(cmd, [], cwd, true);
      return { ok: r.code === 0, output: r.out + r.err };
    },
    merge: mergeBranch,
    resolveLocal: resolveRunnerProvider,
    stopActive: async () => void (await stopLaunchedWorkers(logDir)),
  };
}

/** Diff of worker/<id> against the checkout, for an `again` round (capped). */
export async function branchDiff(repo: string, id: string, maxLines = 300): Promise<string> {
  const base = (await capture("git", ["merge-base", "HEAD", `worker/${id}`], repo)).out.trim();
  const out = (await capture("git", ["diff", `${base}..worker/${id}`], repo)).out;
  return out.split("\n").slice(0, maxLines).join("\n");
}
