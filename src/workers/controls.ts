/**
 * controls.ts — the clickr argv for handing desktop control to a worker or
 * taking it back, shared by `pai worker controls` and the follow pane's
 * "your controls" / "my controls" chat action, so both go through clickr the
 * same way.
 *
 * The grant is exclusive to one worker at a time: clickr's MCP server checks
 * PAI_WORKER_ID/pid against the `--agent <id> --pid <pid>` it was handed
 * control for. Crash paths are covered by clickr's own pid check; a clean
 * exit is covered by returnControlsIfHeld below, called from every exit path
 * of run.ts's runWorker.
 */

import { spawn } from "node:child_process";
import { loadStatus, saveStatus } from "./status.js";

/** clickr argv for `who`: `you` binds the grant to `id` (and its runner pid, when known); `me` has no target. */
export function clickrControlsArgv(id: string, who: "you" | "me", pid?: number): string[] {
  if (who === "me") return ["controls", "me"];
  const argv = ["controls", "you", "--agent", id];
  if (pid !== undefined) argv.push("--pid", String(pid));
  return argv;
}

/** clickr argv to hand a worker's grant back on its exit. */
export function clickrControlsReturnArgv(id: string): string[] {
  return ["controls", "return", "--agent", id];
}

/** Record that `id` was granted clickr desktop controls (`who: "you"` succeeded). */
export function markControlsHeld(logDir: string, id: string): void {
  const status = loadStatus(logDir, id);
  if (!status) return;
  status.controlsHeld = true;
  saveStatus(logDir, status);
}

/**
 * Best-effort hand desktop controls back on a worker's exit, when it ever
 * held them. Never throws and never hangs past clickr's own exit or a 3s
 * cap — a missing clickr binary or a stuck process must not hold up the
 * worker's own exit.
 */
export async function returnControlsIfHeld(logDir: string, id: string | undefined): Promise<void> {
  if (!id) return;
  const status = loadStatus(logDir, id);
  if (!status?.controlsHeld) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      const proc = spawn("clickr", clickrControlsReturnArgv(id), { stdio: "ignore" });
      proc.on("close", finish);
      proc.on("error", finish);
    } catch {
      finish();
    }
    setTimeout(finish, 3000).unref();
  });
}
