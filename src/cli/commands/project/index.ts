/**
 * ⚠️ THIS REGISTRATION IS NOT WIRED TO ANYTHING. See projects-index.ts.
 *
 * `program.ts` calls `registerProjectsCommands` (plural, from projects-index.ts)
 * for both `pai projects` and `pai project`. The `registerProjectCommands`
 * (singular) below is exported, re-exported by ../project.ts, and called by
 * nobody.
 *
 * This cost real time on 2026-08-04: `pai project merge` and
 * `pai project unregister` were added HERE, built, and did not exist at the
 * command line — the same failure as `probeResume` in three copies earlier the
 * same day, where a fix landed in a file the user's path never reached. Two
 * registration functions for one command set, and no way to tell which is live
 * except by following program.ts.
 *
 * Add commands to projects-index.ts. Deleting this one is the real fix and wants
 * doing when someone can watch the CLI surface afterwards.
 */

import type { Command } from "commander";
import { cmdPromote } from "../../../session/promote.js";
import {
  cmdAdd,
  cmdList,
  cmdInfo,
  cmdArchive,
  cmdUnarchive,
  cmdMove,
  cmdTag,
  cmdAlias,
  cmdEdit,
  cmdDetect,
  cmdConsolidate,
  cmdGo,
} from "./commands.js";
import { cmdName, cmdUnname, cmdNames, cmdConfig } from "./session-config.js";
import { cmdHealth } from "./health.js";
import { resolveIdentifier } from "./helpers.js";

export { cmdGo };

export function registerProjectCommands(projectCmd: Command): void {
  // pai project add <path>
  projectCmd
    .command("add <path>")
    .description("Register a project directory in the PAI registry")
    .option("--slug <slug>", "Override auto-generated slug")
    .option(
      "--type <type>",
      "Project type: local | central | obsidian-linked | external",
      "local"
    )
    .option("--display-name <name>", "Human-readable display name")
    .action(
      async (
        rawPath: string,
        opts: { slug?: string; type?: string; displayName?: string }
      ) => {
        await cmdAdd(rawPath, opts);
      }
    );

  // pai project list
  projectCmd
    .command("list")
    .description(
      "List registered projects. Short form: pai projects"
    )
    .option("--status <status>", "Filter by status: active | archived")
    .option("--tag <tag>", "Filter by tag")
    .option("--type <type>", "Filter by type")
    .action(async (opts: { status?: string; tag?: string; type?: string }) => {
      await cmdList(opts);
    });

  // pai project info <slug>
  projectCmd
    .command("info <slug>")
    .description("Show full details for a project")
    .action(async (slug: string) => {
      await cmdInfo(slug);
    });

  // pai project archive <slug>
  projectCmd
    .command("archive <slug>")
    .description("Archive a project")
    .action(async (slug: string) => {
      await cmdArchive(slug);
    });

  // merge / unregister are registered in projects-index.ts, the live file. They
  // were added here first and did not exist at the command line — see the banner
  // at the top of this file.

  // pai project unarchive <slug>
  projectCmd
    .command("unarchive <slug>")
    .description("Restore an archived project to active status")
    .action(async (slug: string) => {
      await cmdUnarchive(slug);
    });

  // pai project move <slug> <new-path>
  projectCmd
    .command("move <slug> <new-path>")
    .description("Update the root path for a project")
    .action(async (slug: string, newPath: string) => {
      await cmdMove(slug, newPath);
    });

  // pai project tag <slug> <tags...>
  projectCmd
    .command("tag <slug> <tags...>")
    .description("Add one or more tags to a project")
    .action(async (slug: string, tags: string[]) => {
      await cmdTag(slug, tags);
    });

  // pai project alias <slug> <alias>
  projectCmd
    .command("alias <slug> <alias>")
    .description("Register an alternative slug for a project")
    .action(async (slug: string, alias: string) => {
      await cmdAlias(slug, alias);
    });

  // pai project edit <slug>
  projectCmd
    .command("edit <slug>")
    .description("Edit project metadata")
    .option("--display-name <name>", "New display name")
    .option("--type <type>", "New type")
    .action(
      async (slug: string, opts: { displayName?: string; type?: string }) => {
        await cmdEdit(slug, opts);
      }
    );

  // pai project cd <slug-or-number>
  projectCmd
    .command("cd <identifier>")
    .description(
      "cd to a project directory. Short form: pai cd <name>\n" +
        "(The shell wrapper handles the actual cd; pure output here.)"
    )
    .action(async (identifier: string) => {
      const project = await resolveIdentifier(identifier);
      if (!project) {
        console.error(`Project not found: ${identifier}`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(project.root_path + "\n");
    });

  // pai project detect [path]
  projectCmd
    .command("detect [path]")
    .description(
      "Detect which registered project the given path (or CWD) belongs to"
    )
    .option("--json", "Output raw JSON instead of human-readable text")
    .action(async (pathArg: string | undefined, opts: { json?: boolean }) => {
      await cmdDetect(pathArg, opts);
    });

  // pai project health
  projectCmd
    .command("health")
    .description(
      "Audit all registered projects: check which paths still exist, find moved/dead projects"
    )
    .option(
      "--fix",
      "Auto-remediate where possible (update moved paths, archive dead zero-session projects)"
    )
    .option("--json", "Output raw JSON report")
    .option("--status <category>", "Filter output to: active | stale | dead")
    .action(async (opts: { fix?: boolean; json?: boolean; status?: string }) => {
      await cmdHealth(opts);
    });

  // pai project consolidate <slug-or-number>
  projectCmd
    .command("consolidate <identifier>")
    .description(
      "Consolidate scattered ~/.claude/projects/.../Notes/ directories for a project into its canonical Notes/ location"
    )
    .option("--yes", "Perform consolidation without confirmation prompt")
    .option("--dry-run", "Preview what would be moved without making changes")
    .action(
      async (identifier: string, opts: { yes?: boolean; dryRun?: boolean }) => {
        await cmdConsolidate(identifier, opts);
      }
    );

  // pai project promote
  projectCmd
    .command("promote")
    .description("Promote a session note into a new standalone project")
    .requiredOption(
      "--from-session <path>",
      "Path to the session note markdown file"
    )
    .requiredOption(
      "--to <path>",
      "Directory path for the new project (must not exist)"
    )
    .option(
      "--name <name>",
      "Display name for the new project (derived from filename if omitted)"
    )
    .action(async (opts: { fromSession: string; to: string; name?: string }) => {
      await cmdPromote(opts);
    });

  // pai project go <query>
  projectCmd
    .command("go <query>")
    .description(
      "Print the root path for a project by slug, partial name, or fuzzy match.\n" +
        "Designed for shell integration: cd $(pai project go <query>)\n" +
        "Or set a shell alias: alias pcd='cd $(pai project go)'"
    )
    .action(async (query: string) => {
      await cmdGo(query);
    });

  // pai project name <slug-or-number> <shortname>
  projectCmd
    .command("name <identifier> <shortname>")
    .description(
      "Give a project a short name for quick access (used by AIBroker to launch sessions)"
    )
    .option(
      "--permission <level>",
      "Permission level: full | trusted | default (or raw CLI flags)"
    )
    .action(
      async (
        identifier: string,
        shortname: string,
        opts: { permission?: string }
      ) => {
        await cmdName(identifier, shortname, opts);
      }
    );

  // pai project unname <shortname>
  projectCmd
    .command("unname <shortname>")
    .description("Remove a project's short name")
    .action(async (shortname: string) => {
      await cmdUnname(shortname);
    });

  // pai project names
  projectCmd
    .command("names")
    .description("List named projects (your curated shortlist)")
    .option("--json", "Output JSON for AIBroker consumption")
    .action(async (opts: { json?: boolean }) => {
      await cmdNames(opts);
    });

  // pai project config [identifier]
  projectCmd
    .command("config [identifier]")
    .description(
      "View or modify session launch config for a project.\n" +
        "Use --options to discover available keys and presets.\n" +
        "Use --defaults to manage global defaults for new sessions."
    )
    .option(
      "--set <key=value...>",
      "Set config values (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[]
    )
    .option(
      "--unset <key...>",
      "Remove config keys (repeatable, use env.KEY for env vars)",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[]
    )
    .option(
      "--preset <name>",
      "Apply a permission preset: full | trusted | default"
    )
    .option(
      "--defaults",
      "Manage global session defaults instead of a project"
    )
    .option("--options", "List available config keys and presets")
    .option("--json", "Output JSON")
    .option("--reset", "Reset config to empty (inherit global defaults)")
    .action(
      async (
        identifier: string | undefined,
        opts: {
          set?: string[];
          unset?: string[];
          preset?: string;
          defaults?: boolean;
          options?: boolean;
          json?: boolean;
          reset?: boolean;
        }
      ) => {
        await cmdConfig(identifier, opts);
      }
    );
}
