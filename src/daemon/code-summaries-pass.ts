/**
 * Daily maintenance step after the nightly incremental index: `pai code relate`, then module and repo summaries.
 * Runs `pai code summarize --all --changed` in a low-priority child (the local
 * model does the writing; no local model running = the child exits with an
 * error and the pass is skipped until tomorrow). Best-effort: logs, never throws.
 */
import { spawn } from "node:child_process";
import { cliEntry } from "./pass-priority.js";

const DAY_MS = 24 * 3600_000;
const MAX_MINUTES = 90;
let lastRun = 0;

export async function runCodeSummariesDaily(): Promise<void> {
  if (Date.now() - lastRun < DAY_MS - 3600_000) return;
  lastRun = Date.now();
  // order: relate (the nightly incremental index ran just before), then summarize --changed
  await runStep("relate", ["code", "relate"]);
  await runStep("summaries", ["code", "summarize", "--all", "--changed", "--max-minutes", String(MAX_MINUTES), "--json"]);
}

function runStep(label: string, passArgs: string[]): Promise<void> {
  // NOT buildPassCommand/`pai memory pass`: those are the index/embed pass children and take the
  // shared memory-run marker. `code relate` / `code summarize` hold no marker, so this child must
  // not be wrapped in the pass runner (2026-11-20: the nightly chain's child read like an index
  // run for its whole ~90 min). Low priority is still held inside via PAI_PASS_BACKGROUND.
  const cmd = process.execPath;
  const args = [cliEntry(), ...passArgs];
  return new Promise<void>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAI_PASS_BACKGROUND: "1" } });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", (e) => { process.stderr.write(`[pai-daemon] code ${label}: cannot spawn (${e.message})\n`); resolve(); });
    child.on("close", (code) => {
      process.stderr.write(code === 0
        ? `[pai-daemon] code ${label}: done\n`
        : `[pai-daemon] code ${label}: skipped (${err.trim().split("\n").pop() ?? `exit ${code}`})\n`);
      resolve();
    });
  });
}
