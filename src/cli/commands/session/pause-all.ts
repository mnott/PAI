/**
 * pai pause all [--exit] [--dry-run]
 *
 * Pause every live Claude Code session that AIBroker knows about.
 *
 * For each live session returned by AIBroker's session_content IPC method:
 *   1. Send "pause session" to the iTerm2 pane via send_to_session.
 *   2. Optionally send "\n/exit\n" after a short delay (--exit flag).
 *   3. Print a summary of what was sent and to which sessions.
 *
 * If AIBroker is not running, prints a clear error and exits.
 * If no live sessions are found, reports "nothing to pause".
 */

import chalk from "chalk";
import {
  fetchLiveSessions,
  sendToSession,
  type AiBrokerSessionMeta,
} from "../../lib/aibroker-client.js";
import { header, dim, ok, err, warn } from "../../utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionLabel(s: AiBrokerSessionMeta): string {
  const name = s.paiName ?? s.name;
  return `${chalk.cyan(s.sessionId.slice(0, 8))} ${chalk.bold(name)}`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdPauseAll(opts: {
  exit?: boolean;
  dryRun?: boolean;
  wait?: number;
}): Promise<void> {
  const waitMs = opts.wait ?? 5_000; // ms to wait after "pause session" before /exit

  // ── Fetch live sessions ────────────────────────────────────────────────────
  let liveSessions: AiBrokerSessionMeta[];
  try {
    liveSessions = await fetchLiveSessions();
  } catch (e) {
    console.error(err("AIBroker is not running. Cannot list live sessions."));
    console.error(dim("  Start AIBroker or run `pai pause` from each session manually."));
    process.exitCode = 1;
    return;
  }

  // ── Filter: Claude sessions only (skip bare shells) ───────────────────────
  const claudeSessions = liveSessions.filter((s) => s.kind === "claude");
  const skipped = liveSessions.length - claudeSessions.length;

  if (skipped > 0) {
    process.stderr.write(
      `Skipping ${skipped} non-Claude tab${skipped === 1 ? "" : "s"} (bare shells).\n`
    );
  }

  if (claudeSessions.length === 0) {
    console.log(warn("No live Claude sessions found via AIBroker. Nothing to pause."));
    return;
  }

  // ── Dry-run ───────────────────────────────────────────────────────────────
  if (opts.dryRun) {
    console.log("\n" + header("Dry Run — Would Pause These Sessions") + "\n");
    for (const s of claudeSessions) {
      console.log("  " + sessionLabel(s));
      console.log(dim('    → send: "pause session"'));
      if (opts.exit) {
        console.log(dim(`    → wait ${waitMs}ms then send: "/exit"`));
      }
    }
    console.log();
    return;
  }

  // ── Live run ──────────────────────────────────────────────────────────────
  console.log(
    "\n" +
      header("Pausing All Live Sessions") +
      "\n" +
      dim(`  ${claudeSessions.length} Claude session(s) via AIBroker`) +
      "\n"
  );

  const results: Array<{ session: AiBrokerSessionMeta; pauseOk: boolean; exitOk?: boolean; error?: string }> = [];

  for (const s of claudeSessions) {
    process.stdout.write("  " + sessionLabel(s) + " … ");

    // Send "pause session" command
    const pauseResult = await sendToSession(s.sessionId, "pause session\n");
    if (!pauseResult.ok) {
      console.log(err("FAILED: " + (pauseResult.error ?? "unknown error")));
      results.push({ session: s, pauseOk: false, error: pauseResult.error });
      continue;
    }
    console.log(ok("paused"));
    results.push({ session: s, pauseOk: true });
  }

  // ── Optional /exit after waiting ──────────────────────────────────────────
  if (opts.exit) {
    const pausedSessions = results.filter((r) => r.pauseOk).map((r) => r.session);
    if (pausedSessions.length > 0) {
      console.log(
        "\n" +
          dim(`  Waiting ${waitMs / 1000}s for sessions to save state…`)
      );
      await sleep(waitMs);

      console.log();
      for (const s of pausedSessions) {
        process.stdout.write("  " + sessionLabel(s) + " exiting … ");
        const exitResult = await sendToSession(s.sessionId, "/exit\n");
        const rec = results.find((r) => r.session.sessionId === s.sessionId)!;
        rec.exitOk = exitResult.ok;
        if (!exitResult.ok) {
          console.log(warn("exit failed: " + (exitResult.error ?? "unknown")));
        } else {
          console.log(ok("exited"));
        }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = results.length;
  const succeeded = results.filter((r) => r.pauseOk).length;
  const failed = total - succeeded;

  console.log();
  if (failed === 0) {
    console.log(ok(`All ${total} session(s) paused successfully.`));
  } else {
    console.log(
      warn(`${succeeded}/${total} session(s) paused. `) +
        err(`${failed} failed.`)
    );
    for (const r of results.filter((r) => !r.pauseOk)) {
      const label = r.session.paiName ?? r.session.name ?? r.session.sessionId.slice(0, 8);
      console.log(err(`  ${label}: ${r.error ?? "unknown error"}`));
    }
  }

  if (opts.exit) {
    const exitOk = results.filter((r) => r.exitOk).length;
    console.log(dim(`  /exit sent to ${exitOk} session(s).`));
  }

  console.log();
}
