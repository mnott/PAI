/**
 * Commander registration for all `pai session` sub-commands.
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

export function registerSessionCommands(
  sessionCmd: Command,
  getDb: () => Database
): void {
  // pai session list [project-slug]
  sessionCmd
    .command("list [project-slug]")
    .description("List sessions, optionally filtered to a single project")
    .option("--limit <n>", "Maximum number of sessions to show", "20")
    .option("--status <status>", "Filter by status: open | completed | compacted")
    .action(
      (
        projectSlug: string | undefined,
        opts: { limit?: string; status?: string }
      ) => {
        cmdList(getDb(), projectSlug, opts);
      }
    );

  // pai session info <project-slug> <number>
  sessionCmd
    .command("info <project-slug> <number>")
    .description("Show full details for a specific session")
    .action((projectSlug: string, number: string) => {
      cmdInfo(getDb(), projectSlug, number);
    });

  // pai session rename <project-slug> <number> <new-slug>
  sessionCmd
    .command("rename <project-slug> <number> <new-slug>")
    .description(
      "Rename a session note — updates file on disk, H1 title, and registry"
    )
    .action((projectSlug: string, number: string, newSlug: string) => {
      cmdRename(getDb(), projectSlug, number, newSlug);
    });

  // pai session slug <project-slug> <number|latest>
  sessionCmd
    .command("slug <project-slug> <number>")
    .description(
      "Generate a descriptive slug from the session JSONL transcript"
    )
    .option("--apply", "Rename the session note using the generated slug")
    .action(
      (projectSlug: string, number: string, opts: { apply?: boolean }) => {
        cmdSlug(getDb(), projectSlug, number, opts);
      }
    );

  // pai session tag <project-slug> <number> [tags...]
  sessionCmd
    .command("tag <project-slug> <number> [tags...]")
    .description(
      "Set or show tags on a session. Tags can be space-separated or comma-separated."
    )
    .action((projectSlug: string, number: string, tags: string[]) => {
      cmdTag(getDb(), projectSlug, number, tags);
    });

  // pai session route <project-slug> <number> <target-project>
  sessionCmd
    .command("route <project-slug> <number> <target-project>")
    .description(
      "Create a cross-reference link from a session to a target project"
    )
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

  // pai session handover [project-slug] [session-id]
  sessionCmd
    .command("handover [project-slug] [session-id]")
    .description(
      "Write a ## Continue section to the project's TODO.md.\n" +
        "Called automatically from session-stop and pre-compact hooks.\n" +
        "Records the last session identifier, timestamp, and working directory\n" +
        "so the next session can resume from the correct context."
    )
    .action(
      (projectSlug: string | undefined, sessionId: string | undefined) => {
        cmdHandover(getDb(), projectSlug, sessionId);
      }
    );

  // pai session checkpoint <message>
  sessionCmd
    .command("checkpoint <message>")
    .description(
      "Append a timestamped checkpoint to the active session note.\n" +
        "Designed for hooks (PostToolUse, UserPromptSubmit) — fast and silent.\n" +
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

  // pai session active [--minutes N] [--json]
  sessionCmd
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

  // pai session auto-route [--cwd path] [--context "text"] [--json]
  sessionCmd
    .command("auto-route")
    .description(
      "Auto-detect which project this session belongs to.\n" +
        "Tries: (1) path match in registry, (2) Notes/PAI.md marker walk, (3) topic detection.\n" +
        "Designed for use in CLAUDE.md session-start hooks."
    )
    .option(
      "--cwd <path>",
      "Working directory to detect from (default: process.cwd())"
    )
    .option(
      "--context <text>",
      "Conversation context for topic-based fallback routing"
    )
    .option("--json", "Output raw JSON instead of formatted display")
    .action(
      async (opts: { cwd?: string; context?: string; json?: boolean }) => {
        await cmdAutoRoute(opts);
      }
    );
}
