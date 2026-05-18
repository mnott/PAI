/**
 * Commander registration for all `pai sessions` sub-commands (plural namespace).
 *
 * This is the canonical namespace. `pai session <subcmd>` (singular) is a
 * deprecated alias that forwards here with a stderr notice.
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
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: { n?: string; all?: boolean; json?: boolean }) => {
      cmdRecent(getDb(), opts);
    });

  // pai sessions goto <name-or-id> [--skip-name] [--skip-go] [--dry-run]
  sessionsCmd
    .command("goto <name-or-id>")
    .description(
      "Go to a session: resume if a resumable snapshot exists, start fresh otherwise.\n" +
        "Recommended short form: pai resume <name>\n" +
        "Resolves by clc/registry name (case-insensitive) or UUID prefix."
    )
    .option("--skip-name", "Do not prepend /Name to restore the session name")
    .option("--skip-go", "Do not append \\ngo to trigger PAI auto-resume")
    .option("--dry-run", "Print the exact argv and cwd, then exit without launching")
    .action(
      (nameOrId: string, opts: { skipName?: boolean; skipGo?: boolean; dryRun?: boolean }) => {
        cmdGoto(getDb(), nameOrId, { noName: opts.skipName, noGo: opts.skipGo, dryRun: opts.dryRun });
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

  // pai sessions recent — DEPRECATED alias for `pai sessions list`
  sessionsCmd
    .command("recent")
    .description("[Deprecated] Use `pai sessions list` instead.")
    .option("-n <count>", "Maximum sessions to show (default: 20)", "20")
    .option("--all", "Include unnamed orphan sessions (not in clc registry)")
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: { n?: string; all?: boolean; json?: boolean }) => {
      process.stderr.write(
        "Deprecated: `pai sessions recent` — use `pai sessions list` instead.\n"
      );
      cmdRecent(getDb(), opts);
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
