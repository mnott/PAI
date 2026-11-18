/**
 * Daily maintenance step: refresh module and repo summaries of the code graph.
 * Runs `pai code summarize --all --changed` in a low-priority child (the local
 * model does the writing; no local model running = the child exits with an
 * error and the pass is skipped until tomorrow). Best-effort: logs, never throws.
 */
import { spawn } from "node:child_process";
import { buildPassCommand, cliEntry } from "./pass-priority.js";

const DAY_MS = 24 * 3600_000;
const MAX_MINUTES = 90;
let lastRun = 0;

export async function runCodeSummariesDaily(): Promise<void> {
  if (Date.now() - lastRun < DAY_MS - 3600_000) return;
  lastRun = Date.now();
  const { cmd, args } = buildPassCommand(process.platform, process.execPath, cliEntry(), [
    "code", "summarize", "--all", "--changed", "--max-minutes", String(MAX_MINUTES), "--json",
  ]);
  await new Promise<void>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAI_PASS_BACKGROUND: "1" } });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", (e) => { process.stderr.write(`[pai-daemon] code summaries: cannot spawn (${e.message})\n`); resolve(); });
    child.on("close", (code) => {
      process.stderr.write(code === 0
        ? "[pai-daemon] code summaries: done\n"
        : `[pai-daemon] code summaries: skipped (${err.trim().split("\n").pop() ?? `exit ${code}`})\n`);
      resolve();
    });
  });
}
