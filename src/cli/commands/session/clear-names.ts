/**
 * pai sessions clear-names
 *
 * Recovery command: wipes corrupted iTerm2 session name state.
 *
 * Two-step reset:
 *   1. Clear ~/.aibroker/session-names.json (the persistent name store).
 *   2. Clear user.paiName variable from all live iTerm2 sessions.
 *
 * After this runs the user can `/Name` each tab fresh. Nothing is
 * set automatically — the user re-asserts names via the /Name skill.
 */

import { callAiBroker } from "../../lib/aibroker-client.js";
import { ok, err, dim, warn } from "../../utils.js";

export async function cmdClearNames(opts: { dryRun?: boolean }): Promise<void> {
  if (opts.dryRun) {
    console.log(dim("Dry run — would:"));
    console.log(dim("  1. Call AIBroker clear_session_names  (wipe session-names.json)"));
    console.log(dim("  2. Call AIBroker clear_pai_names      (wipe user.paiName from all iTerm sessions)"));
    return;
  }

  let anyFailed = false;

  // Step 1: clear the persistent name store
  process.stdout.write("Clearing session-names.json … ");
  try {
    const r1 = await callAiBroker("clear_session_names", {}, 10_000) as {
      cleared?: number;
    };
    const n = r1.cleared ?? 0;
    console.log(ok(`cleared ${n} entr${n === 1 ? "y" : "ies"}`));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED")) {
      console.log(warn("AIBroker not running — session-names.json not cleared"));
      anyFailed = true;
    } else {
      console.log(err(msg));
      anyFailed = true;
    }
  }

  // Step 2: clear user.paiName from all live iTerm2 sessions
  process.stdout.write("Clearing user.paiName from iTerm2 sessions … ");
  try {
    const r2 = await callAiBroker("clear_pai_names", {}, 30_000) as {
      cleared?: number;
    };
    const n = r2.cleared ?? 0;
    console.log(ok(`cleared ${n} session${n === 1 ? "" : "s"}`));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED")) {
      console.log(warn("AIBroker not running — iTerm2 paiName variables not cleared"));
      anyFailed = true;
    } else {
      console.log(err(msg));
      anyFailed = true;
    }
  }

  if (anyFailed) {
    console.log(warn("\nSome steps could not complete. Restart AIBroker and try again."));
    process.exitCode = 1;
  } else {
    console.log(ok("\nDone. Use /Name to re-label each tab."));
  }
}
