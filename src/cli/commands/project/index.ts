/**
 * Commander registration for all `pai project` sub-commands.
 * Imports from focused sub-modules and wires up CLI options.
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
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

export function registerProjectCommands(
  projectCmd: Command,
  getDb: () => Database
): void {
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
      (
        rawPath: string,
        opts: { slug?: string; type?: string; displayName?: string }
      ) => {
        cmdAdd(getDb(), rawPath, opts);
      }
    );

  // pai project list
  projectCmd
    .command("list")
    .description("List registered projects")
    .option("--status <status>", "Filter by status: active | archived")
    .option("--tag <tag>", "Filter by tag")
    .option("--type <type>", "Filter by type")
    .action((opts: { status?: string; tag?: string; type?: string }) => {
      cmdList(getDb(), opts);
    });

  // pai project info <slug>
  projectCmd
    .command("info <slug>")
    .description("Show full details for a project")
    .action((slug: string) => {
      cmdInfo(getDb(), slug);
    });

  // pai project archive <slug>
  projectCmd
    .command("archive <slug>")
    .description("Archive a project")
    .action((slug: string) => {
      cmdArchive(getDb(), slug);
    });

  // pai project unarchive <slug>
  projectCmd
    .command("unarchive <slug>")
    .description("Restore an archived project to active status")
    .action((slug: string) => {
      cmdUnarchive(getDb(), slug);
    });

  // pai project move <slug> <new-path>
  projectCmd
    .command("move <slug> <new-path>")
    .description("Update the root path for a project")
    .action((slug: string, newPath: string) => {
      cmdMove(getDb(), slug, newPath);
    });

  // pai project tag <slug> <tags...>
  projectCmd
    .command("tag <slug> <tags...>")
    .description("Add one or more tags to a project")
    .action((slug: string, tags: string[]) => {
      cmdTag(getDb(), slug, tags);
    });

  // pai project alias <slug> <alias>
  projectCmd
    .command("alias <slug> <alias>")
    .description("Register an alternative slug for a project")
    .action((slug: string, alias: string) => {
      cmdAlias(getDb(), slug, alias);
    });

  // pai project edit <slug>
  projectCmd
    .command("edit <slug>")
    .description("Edit project metadata")
    .option("--display-name <name>", "New display name")
    .option("--type <type>", "New type")
    .action(
      (slug: string, opts: { displayName?: string; type?: string }) => {
        cmdEdit(getDb(), slug, opts);
      }
    );

  // pai project cd <slug-or-number>
  projectCmd
    .command("cd <identifier>")
    .description(
      "Print the root path for a project (use with: cd $(pai project cd <id>))"
    )
    .action((identifier: string) => {
      const project = resolveIdentifier(getDb(), identifier);
      if (!project) {
        console.error(`Project not found: ${identifier}`);
        process.exit(1);
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
    .action((pathArg: string | undefined, opts: { json?: boolean }) => {
      cmdDetect(getDb(), pathArg, opts);
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
    .action((opts: { fix?: boolean; json?: boolean; status?: string }) => {
      cmdHealth(getDb(), opts);
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
      (identifier: string, opts: { yes?: boolean; dryRun?: boolean }) => {
        cmdConsolidate(getDb(), identifier, opts);
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
    .action((opts: { fromSession: string; to: string; name?: string }) => {
      cmdPromote(getDb(), opts);
    });

  // pai project go <query>
  projectCmd
    .command("go <query>")
    .description(
      "Print the root path for a project by slug, partial name, or fuzzy match.\n" +
        "Designed for shell integration: cd $(pai project go <query>)\n" +
        "Or set a shell alias: alias pcd='cd $(pai project go)'"
    )
    .action((query: string) => {
      cmdGo(getDb(), query);
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
      (
        identifier: string,
        shortname: string,
        opts: { permission?: string }
      ) => {
        cmdName(getDb(), identifier, shortname, opts);
      }
    );

  // pai project unname <shortname>
  projectCmd
    .command("unname <shortname>")
    .description("Remove a project's short name")
    .action((shortname: string) => {
      cmdUnname(getDb(), shortname);
    });

  // pai project names
  projectCmd
    .command("names")
    .description("List named projects (your curated shortlist)")
    .option("--json", "Output JSON for AIBroker consumption")
    .action((opts: { json?: boolean }) => {
      cmdNames(getDb(), opts);
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
      (
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
        cmdConfig(getDb(), identifier, opts);
      }
    );
}
