/**
 * Commander registration for all `pai sessions` sub-commands (plural namespace).
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import {
  cmdList,
  cmdInfo,
  cmdRename,
  cmdSlug,
  cmdTag,
  cmdRoute,
  cmdActive,
  cmdAutoRoute,
} from "./commands.js";
import { cmdCheckpoint } from "./checkpoint.js";
import { cmdHandover } from "./handover.js";
import { cmdRecent } from "./recent.js";
import { cmdGoto } from "./goto.js";
import { cmdPause } from "./pause.js";
import { cmdEnd } from "./end.js";
import { cmdPauseAll } from "./pause-all.js";
import { cmdClearNames } from "./clear-names.js";

export function registerSessionsCommands(
  sessionsCmd: Command,
  getDb: () => Database
): void {
  // pai sessions list [-n N] [--all] [--json]
  // Default when `pai sessions` is invoked bare (isDefault).
  sessionsCmd
    .command("list", { isDefault: true })
    .description(
      "Resumable sessions catalog — named sessions with resume status.\n" +
        "Short form: pai sessions (bare, no subcommand)\n" +
        "Use --all to also show unnamed orphan sessions."
    )
    .option("-n <count>", "Maximum sessions to show (default: 20)", "20")
    .option("--all", "Include unnamed orphan sessions (not in clc registry)")
    .option("--all-tabs", "Show all iTerm2 tabs in Live Sessions, including bare shells")
    .option("--json", "Output raw JSON instead of formatted table")
    .action(async (opts: { n?: string; all?: boolean; allTabs?: boolean; json?: boolean }) => {
      await cmdRecent(getDb(), opts);
    });

  // pai sessions goto <name-or-id> [--dry-run]
  sessionsCmd
    .command("goto <name-or-id>")
    .description(
      "Go to a session: resume if a resumable snapshot exists, start fresh otherwise.\n" +
        "Recommended short form: pai resume <name>\n" +
        "Resolves by clc/registry name (case-insensitive) or UUID prefix."
    )
    .option("--dry-run", "Print the exact argv and cwd, then exit without launching")
    .action(
      (nameOrId: string, opts: { dryRun?: boolean }) => {
        cmdGoto(getDb(), nameOrId, { dryRun: opts.dryRun });
      }
    );

  // pai sessions pause [--dry-run]
  sessionsCmd
    .command("pause")
    .description(
      "Write a ## Continue checkpoint to the project's TODO.md.\n" +
        "Recommended short form: pai pause\n" +
        "Use /exit inside Claude Code to preserve full session resumability."
    )
    .option("--dry-run", "Preview the ## Continue block without writing it")
    .action((opts: { dryRun?: boolean }) => {
      cmdPause(getDb(), opts);
    });

  // pai sessions pause-all [--exit] [--wait <ms>] [--dry-run]
  sessionsCmd
    .command("pause-all")
    .description(
      "Pause every live Claude Code session via AIBroker.\n" +
        "Requires AIBroker to be running. Sends 'pause session' to each live iTerm2 pane.\n" +
        "Top-level short form: pai pause all"
    )
    .option("--exit", "Also send /exit to each session after it has saved state")
    .option("--wait <ms>", "Milliseconds to wait before /exit (default: 5000)", "5000")
    .option("--dry-run", "Show what would be sent without actually sending")
    .action(async (opts: { exit?: boolean; wait?: string; dryRun?: boolean }) => {
      await cmdPauseAll({
        exit: opts.exit,
        dryRun: opts.dryRun,
        wait: opts.wait !== undefined ? parseInt(opts.wait, 10) : undefined,
      });
    });

  // pai sessions end [--dry-run]
  sessionsCmd
    .command("end")
    .description(
      "Finalize a session: write ## Continue checkpoint + mark session note Completed.\n" +
        "Recommended short form: pai end\n" +
        "Use /exit inside Claude Code after running this command."
    )
    .option("--dry-run", "Preview all changes without writing them")
    .action((opts: { dryRun?: boolean }) => {
      cmdEnd(getDb(), opts);
    });

  // pai sessions info <project-slug> <number>
  sessionsCmd
    .command("info <project-slug> <number>")
    .description("Show full details for a specific session")
    .action((projectSlug: string, number: string) => {
      cmdInfo(getDb(), projectSlug, number);
    });

  // pai sessions rename <project-slug> <number> <new-slug>
  sessionsCmd
    .command("rename <project-slug> <number> <new-slug>")
    .description("Rename a session note — updates file on disk, H1 title, and registry")
    .action((projectSlug: string, number: string, newSlug: string) => {
      cmdRename(getDb(), projectSlug, number, newSlug);
    });

  // pai sessions slug <project-slug> <number>
  sessionsCmd
    .command("slug <project-slug> <number>")
    .description("Generate a descriptive slug from the session JSONL transcript")
    .option("--apply", "Rename the session note using the generated slug")
    .action(
      (projectSlug: string, number: string, opts: { apply?: boolean }) => {
        cmdSlug(getDb(), projectSlug, number, opts);
      }
    );

  // pai sessions tag <project-slug> <number> [tags...]
  sessionsCmd
    .command("tag <project-slug> <number> [tags...]")
    .description("Set or show tags on a session.")
    .action((projectSlug: string, number: string, tags: string[]) => {
      cmdTag(getDb(), projectSlug, number, tags);
    });

  // pai sessions route <project-slug> <number> <target-project>
  sessionsCmd
    .command("route <project-slug> <number> <target-project>")
    .description("Create a cross-reference link from a session to a target project")
    .option("--type <type>", "Link type: related | follow-up | reference", "related")
    .action(
      (
        projectSlug: string,
        number: string,
        targetProject: string,
        opts: { type?: string }
      ) => {
        cmdRoute(getDb(), projectSlug, number, targetProject, opts);
      }
    );

  // pai sessions handover [project-slug] [session-id]
  sessionsCmd
    .command("handover [project-slug] [session-id]")
    .description(
      "Write a ## Continue section to the project's TODO.md.\n" +
        "Called automatically from session-stop and pre-compact hooks."
    )
    .action(
      (projectSlug: string | undefined, sessionId: string | undefined) => {
        cmdHandover(getDb(), projectSlug, sessionId);
      }
    );

  // pai sessions checkpoint <message>
  sessionsCmd
    .command("checkpoint <message>")
    .description(
      "Append a timestamped checkpoint to the active session note.\n" +
        "Rate-limited: skips silently if last checkpoint was < --min-gap seconds ago."
    )
    .option(
      "--min-gap <seconds>",
      "Minimum seconds between checkpoints (default: 300 = 5 minutes)",
      "300"
    )
    .action((message: string, opts: { minGap?: string }) => {
      cmdCheckpoint(message, opts);
    });

  // pai sessions active [--minutes N] [--json]
  sessionsCmd
    .command("active")
    .description(
      "Show currently active Claude Code sessions.\n" +
        "Detects live sessions by checking which JSONL transcript files\n" +
        "were recently modified in ~/.claude/projects/."
    )
    .option(
      "--minutes <n>",
      "Consider sessions active if modified within N minutes (default: 60)",
      "60"
    )
    .option("--json", "Output raw JSON instead of formatted display")
    .action((opts: { minutes?: string; json?: boolean }) => {
      cmdActive(getDb(), opts);
    });

  // pai sessions clear-names [--dry-run]
  sessionsCmd
    .command("clear-names")
    .description(
      "Recovery: wipe corrupted iTerm2 session name state.\n" +
        "Clears ~/.aibroker/session-names.json AND user.paiName from all live iTerm2 sessions.\n" +
        "After running this, use /Name to re-label each tab."
    )
    .option("--dry-run", "Preview what would be cleared without making changes")
    .action(async (opts: { dryRun?: boolean }) => {
      await cmdClearNames(opts);
    });

  // pai sessions auto-route [--cwd path] [--context "text"] [--json]
  sessionsCmd
    .command("auto-route")
    .description(
      "Auto-detect which project this session belongs to.\n" +
        "Tries: (1) path match in registry, (2) Notes/PAI.md marker walk, (3) topic detection."
    )
    .option("--cwd <path>", "Working directory to detect from (default: process.cwd())")
    .option("--context <text>", "Conversation context for topic-based fallback routing")
    .option("--json", "Output raw JSON instead of formatted display")
    .action(
      async (opts: { cwd?: string; context?: string; json?: boolean }) => {
        await cmdAutoRoute(opts);
      }
    );
}
