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

/** Give each session a moment to pick up the prompt before judging it idle. */
const SETTLE_MS = 4_000;
/** How often to re-ask AIBroker which sessions are back at the prompt. */
const POLL_MS = 2_000;

/**
 * Wait until each session is back at its prompt, i.e. has finished writing its
 * checkpoint.
 *
 * This used to be a flat 5-second sleep before sending /exit. Authoring a real
 * handover — reading state, composing it, writing the file — takes far longer
 * than five seconds, so the exit routinely arrived mid-write and killed the
 * session while it was saving the very thing the command exists to save.
 *
 * `atPrompt` is the signal that a session is idle again. Sessions still busy
 * when the deadline passes are returned as stragglers and deliberately NOT
 * exited: leaving a session open costs nothing, and killing one mid-write costs
 * the checkpoint.
 */
async function waitForSessionsIdle(
  sessionIds: string[],
  timeoutMs: number
): Promise<{ idle: Set<string>; stragglers: Set<string> }> {
  const pending = new Set(sessionIds);
  const idle = new Set<string>();

  await sleep(Math.min(SETTLE_MS, timeoutMs));

  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    let current: AiBrokerSessionMeta[];
    try {
      current = await fetchLiveSessions();
    } catch {
      // AIBroker blipped — try again on the next tick rather than assuming
      // anything about sessions we can no longer see.
      await sleep(POLL_MS);
      continue;
    }

    for (const s of current) {
      if (pending.has(s.sessionId) && s.atPrompt) {
        pending.delete(s.sessionId);
        idle.add(s.sessionId);
      }
    }

    // A session that vanished from the list has already gone; stop waiting.
    const visible = new Set(current.map((s) => s.sessionId));
    for (const id of [...pending]) {
      if (!visible.has(id)) pending.delete(id);
    }

    if (pending.size > 0) await sleep(POLL_MS);
  }

  return { idle, stragglers: pending };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Case-insensitive substring match on the session's name or id. */
export function matchesOnly(s: AiBrokerSessionMeta, only: string): boolean {
  const needle = only.trim().toLowerCase();
  if (!needle) return true;
  const name = (s.paiName ?? s.name ?? "").toLowerCase();
  return name.includes(needle) || s.sessionId.toLowerCase().includes(needle);
}

export async function cmdPauseAll(opts: {
  exit?: boolean;
  dryRun?: boolean;
  only?: string;
  wait?: number;
}): Promise<void> {
  // Upper bound on how long to wait for a session to finish its checkpoint —
  // not a fixed delay. Generous, because the cost of waiting is nothing and the
  // cost of exiting too early is the checkpoint.
  const waitMs = opts.wait ?? 180_000;

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
  const allClaude = liveSessions.filter((s) => s.kind === "claude");
  const claudeSessions = opts.only
    ? allClaude.filter((s) => matchesOnly(s, opts.only!))
    : allClaude;
  const skipped = liveSessions.length - allClaude.length;

  if (opts.only) {
    // Said out loud, because a filter that silently matches nothing looks
    // identical to a filter that matched and did its job quietly.
    console.log(
      dim(
        `  --only ${opts.only}: ${claudeSessions.length} of ${allClaude.length} ` +
          `Claude session(s) matched.`
      )
    );
    if (claudeSessions.length === 0) {
      console.log(warn(`No live Claude session matches "${opts.only}". Nothing to pause.`));
      return;
    }
  }

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

  const results: Array<{
    session: AiBrokerSessionMeta;
    pauseOk: boolean;
    unconfirmed?: boolean;
    exitOk?: boolean;
    error?: string;
  }> = [];

  for (const s of claudeSessions) {
    process.stdout.write("  " + sessionLabel(s) + " … ");

    // Send "pause session" command
    // No trailing newline: the transport appends Enter itself.
    const pauseResult = await sendToSession(s.sessionId, "pause session");

    // Three outcomes, not two. A timeout means the message reached the target's
    // mailbox — the handler deposits before it waits for the submit ack — so the
    // pause is under way and only the confirmation is missing.
    //
    // Printing that as FAILED is worse than useless: the obvious response is to
    // run the command again, and a second "pause session" into a session that
    // already paused nests a fresh "carried forward" block inside the one it
    // just wrote. Measured across 15 sessions: 9 reported failed, 8 verifiably
    // paused, and one refused the duplicate specifically to protect its own
    // checkpoint.
    if (pauseResult.timedOut) {
      console.log(warn("sent — checkpoint still running (not confirmed)"));
      results.push({ session: s, pauseOk: true, unconfirmed: true });
      continue;
    }

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
          dim(
            `  Waiting for sessions to finish writing their checkpoints ` +
              `(up to ${Math.round(waitMs / 1000)}s)…`
          )
      );

      const { stragglers } = await waitForSessionsIdle(
        pausedSessions.map((s) => s.sessionId),
        waitMs
      );

      console.log();
      for (const s of pausedSessions) {
        // Never exit a session that is still working — it is most likely still
        // writing the checkpoint, and /exit would destroy it mid-write.
        if (stragglers.has(s.sessionId)) {
          console.log(
            "  " +
              sessionLabel(s) +
              " " +
              warn("still busy — left open, not exited")
          );
          continue;
        }

        process.stdout.write("  " + sessionLabel(s) + " exiting … ");
        const exitResult = await sendToSession(s.sessionId, "/exit");
        const rec = results.find((r) => r.session.sessionId === s.sessionId)!;
        rec.exitOk = exitResult.ok;
        if (!exitResult.ok) {
          console.log(warn("exit failed: " + (exitResult.error ?? "unknown")));
        } else {
          console.log(ok("exited"));
        }
      }

      if (stragglers.size > 0) {
        console.log(
          "\n" +
            dim(
              `  ${stragglers.size} session(s) were still working. Leaving a ` +
                `session open is harmless; exiting one mid-write is not.`
            )
        );
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = results.length;
  const succeeded = results.filter((r) => r.pauseOk).length;
  const unconfirmed = results.filter((r) => r.unconfirmed).length;
  const confirmed = succeeded - unconfirmed;
  const failed = total - succeeded;

  console.log();
  if (failed === 0 && unconfirmed === 0) {
    console.log(ok(`All ${total} session(s) paused successfully.`));
  } else {
    console.log(
      ok(`${confirmed} confirmed`) +
        (unconfirmed > 0 ? warn(`, ${unconfirmed} still writing`) : "") +
        (failed > 0 ? err(`, ${failed} not delivered`) : "") +
        dim(` — of ${total} session(s).`)
    );
    for (const r of results.filter((r) => !r.pauseOk)) {
      const label = r.session.paiName ?? r.session.name ?? r.session.sessionId.slice(0, 8);
      console.log(err(`  ${label}: ${r.error ?? "unknown error"}`));
    }
    if (unconfirmed > 0) {
      // Said explicitly, because the whole cost of the old wording was that it
      // read as "try again" when trying again is the one harmful move.
      console.log(
        dim(
          `\n  "Still writing" means delivered — the session is composing its\n` +
            `  checkpoint, which routinely outlasts the confirmation window.\n` +
            `  Do NOT re-run to catch them: a second pause nests a new\n` +
            `  "carried forward" block inside the one being written. Check with\n` +
            `  \`pai session list\` in a minute instead.`
        )
      );
    }
  }

  if (opts.exit) {
    const exitOk = results.filter((r) => r.exitOk).length;
    console.log(dim(`  /exit sent to ${exitOk} session(s).`));
  }

  console.log();
}
