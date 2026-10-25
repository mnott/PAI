/**
 * runner.ts — how the server starts and stops a worker. The interface is the
 * seam tests replace; the default runs `runWorker` in this process (the same
 * path as `pai worker run`: routing, capacity, worktree, supervision, report).
 */

import { loadStatus } from "../workers/status.js";
import { killWorker } from "../workers/kill-tree.js";
import { resumePlan } from "../workers/resume-args.js";

export interface RunRequest {
  /** Worker id, minted by the server so the response id is known before the worker exists. */
  workerId: string;
  prompt: string;
  provider: string;
  className: string;
  model?: string;
  instructions?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  /** Worker whose conversation and worktree this run continues. */
  resumeOf?: string;
  label: string;
}

export interface WorkerRunner {
  /** Resolves once the worker exists (its status file is written); rejects when it cannot start. */
  start(req: RunRequest): Promise<void>;
  /** Asks the worker to stop; returns without waiting for the process tree to die. */
  cancel(workerId: string, by: string): Promise<void>;
}

const START_WAIT_MS = 30_000;

export function inProcessRunner(logDir: string): WorkerRunner {
  return {
    async start(req) {
      const { runWorker } = await import("../workers/run.js");
      const claudeArgs: string[] = [];
      let cwd: string | undefined;
      let model = req.model;
      let provider: string | undefined = req.provider;
      if (req.resumeOf) {
        const old = loadStatus(logDir, req.resumeOf);
        if (!old) throw new Error("the worker of the previous response is gone");
        const plan = resumePlan(old, req.prompt);
        claudeArgs.push(...plan.claudeArgs);
        cwd = plan.cwd;
        model ??= old.model;
        provider = old.provider;
      } else {
        claudeArgs.push("-p", req.prompt);
      }
      if (req.instructions) claudeArgs.push("--append-system-prompt", req.instructions);
      if (req.maxTurns !== undefined) claudeArgs.push("--max-turns", String(req.maxTurns));
      const run = runWorker({
        id: req.workerId,
        providerFlag: provider,
        className: req.className,
        ...(model ? { modelFlag: model } : {}),
        label: req.label,
        claudeArgs,
        quiet: true,
        ...(cwd ? { cwd } : {}),
        ...(req.resumeOf ? { resumeOf: req.resumeOf } : {}),
        ...(req.timeoutSeconds !== undefined ? { maxMinutes: req.timeoutSeconds / 60 } : {}),
      });
      let failed: unknown;
      let ended = false;
      run.then(
        () => {
          ended = true;
        },
        (e) => {
          ended = true;
          failed = e;
        },
      );
      const t0 = Date.now();
      while (!loadStatus(logDir, req.workerId)) {
        if (ended) throw failed ?? new Error("the worker ended before it started");
        if (Date.now() - t0 > START_WAIT_MS) throw new Error("the worker did not start in time");
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async cancel(workerId, by) {
      await killWorker(logDir, workerId, { by, reason: "uhp cancel" });
    },
  };
}
