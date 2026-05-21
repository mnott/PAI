/**
 * Commander registration for all `pai projects` sub-commands (plural namespace).
 *
 * This is the canonical namespace. `pai project <subcmd>` (singular) is a
 * deprecated alias that forwards here with a stderr notice.
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
  cmdRebind,
  findMovedPath,
} from "./commands.js";
import { existsSync } from "node:fs";
import { ok, warn, err, dim, bold, shortenPath, encodeDir, now } from "../../utils.js";
import { basename } from "node:path";
import { cmdName, cmdUnname, cmdNames, cmdConfig } from "./session-config.js";
import { cmdHealth } from "./health.js";
import { resolveIdentifier } from "./helpers.js";

export { cmdGo };

export function registerProjectsCommands(
  projectsCmd: Command,
  getDb: () => Database
): void {
  // pai projects list — default when `pai projects` is invoked bare
  projectsCmd
    .command("list", { isDefault: true })
    .description(
      "List registered projects. Short form: pai projects (bare, no subcommand)\n" +
        "Default: active projects only. Use --all to include archived."
    )
    .option("--all", "Include archived projects (default: active only)")
    .option("--status <status>", "Filter by status: active | archived")
    .option("--tag <tag>", "Filter by tag")
    .option("--type <type>", "Filter by type")
    .action((opts: { all?: boolean; status?: string; tag?: string; type?: string }) => {
      cmdList(getDb(), opts);
    });

  // pai projects cd <identifier>
  projectsCmd
    .command("cd <identifier>")
    .description(
      "cd to a project directory. Short form: pai cd <name>\n" +
        "(The shell wrapper handles the actual cd; pure output here.)\n" +
        "Auto-detects moved projects when the registered path no longer exists."
    )
    .action((identifier: string) => {
      const db = getDb();
      const project = resolveIdentifier(db, identifier);
      if (!project) {
        console.error(`Project not found: ${identifier}`);
        process.exit(1);
        return;
      }

      if (existsSync(project.root_path)) {
        process.stdout.write(project.root_path + "\n");
        return;
      }

      // Path missing — search for moved location
      process.stderr.write(
        warn(`Path not found: ${project.root_path}\n`) +
        dim("  Searching for moved location...\n")
      );

      const result = findMovedPath(project.root_path);

      if (result.found) {
        const newPath = result.found;
        const newEncoded = encodeDir(newPath);
        const ts = now();
        db.prepare(
          "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
        ).run(newPath, newEncoded, ts, project.id);
        process.stderr.write(
          ok(`Project moved: ${shortenPath(project.root_path, 50)}\n`) +
          dim(`  → ${newPath}\n`) +
          ok("Registry updated.\n")
        );
        process.stdout.write(newPath + "\n");
        return;
      }

      if (result.ambiguous) {
        process.stderr.write(
          warn(`Multiple directories named "${basename(project.root_path)}" found:\n`)
        );
        for (const candidate of result.ambiguous) {
          process.stderr.write(dim(`  ${candidate}\n`));
        }
        process.stderr.write(
          dim(`\n  Disambiguate with: pai projects rebind ${project.slug} <path>\n`)
        );
        process.exitCode = 1;
        return;
      }

      process.stderr.write(
        err(
          `Project "${project.slug}" root_path "${project.root_path}" does not exist on disk\n` +
          `  and no folder named "${basename(project.root_path)}" was found in scan dirs.\n`
        ) +
        dim(`  Fix with: pai projects rebind ${project.slug} <new-path>\n`)
      );
      process.exitCode = 1;
    });

  // pai projects add <path>
  projectsCmd
    .command("add <path>")
    .description("Register a project directory in the PAI registry")
    .option("--slug <slug>", "Override auto-generated slug")
    .option("--type <type>", "Project type: local | central | obsidian-linked | external", "local")
    .option("--display-name <name>", "Human-readable display name")
    .action(
      (
        rawPath: string,
        opts: { slug?: string; type?: string; displayName?: string }
      ) => {
        cmdAdd(getDb(), rawPath, opts);
      }
    );

  // pai projects info <slug>
  projectsCmd
    .command("info <slug>")
    .description("Show full details for a project")
    .action((slug: string) => {
      cmdInfo(getDb(), slug);
    });

  // pai projects archive <slug>
  projectsCmd
    .command("archive <slug>")
    .description("Archive a project")
    .action((slug: string) => {
      cmdArchive(getDb(), slug);
    });

  // pai projects unarchive <slug>
  projectsCmd
    .command("unarchive <slug>")
    .description("Restore an archived project to active status")
    .action((slug: string) => {
      cmdUnarchive(getDb(), slug);
    });

  // pai projects move <slug> <new-path>
  projectsCmd
    .command("move <slug> <new-path>")
    .description("Update the root path for a project")
    .action((slug: string, newPath: string) => {
      cmdMove(getDb(), slug, newPath);
    });

  // pai projects rebind <slug> <new-path>
  projectsCmd
    .command("rebind <slug> <new-path>")
    .description(
      "Manually update the root_path for a project (for when auto-detect found multiple matches).\n" +
        "Validates the new path exists and is a directory, then updates the registry."
    )
    .action((slug: string, newPath: string) => {
      cmdRebind(getDb(), slug, newPath);
    });

  // pai projects tag <slug> <tags...>
  projectsCmd
    .command("tag <slug> <tags...>")
    .description("Add one or more tags to a project")
    .action((slug: string, tags: string[]) => {
      cmdTag(getDb(), slug, tags);
    });

  // pai projects alias <slug> <alias>
  projectsCmd
    .command("alias <slug> <alias>")
    .description("Register an alternative slug for a project")
    .action((slug: string, alias: string) => {
      cmdAlias(getDb(), slug, alias);
    });

  // pai projects edit <slug>
  projectsCmd
    .command("edit <slug>")
    .description("Edit project metadata")
    .option("--display-name <name>", "New display name")
    .option("--type <type>", "New type")
    .action(
      (slug: string, opts: { displayName?: string; type?: string }) => {
        cmdEdit(getDb(), slug, opts);
      }
    );

  // pai projects detect [path]
  projectsCmd
    .command("detect [path]")
    .description("Detect which registered project the given path (or CWD) belongs to")
    .option("--json", "Output raw JSON instead of human-readable text")
    .action((pathArg: string | undefined, opts: { json?: boolean }) => {
      cmdDetect(getDb(), pathArg, opts);
    });

  // pai projects health
  projectsCmd
    .command("health")
    .description(
      "Audit all registered projects: check which paths still exist, find moved/dead projects"
    )
    .option("--fix", "Auto-remediate where possible")
    .option("--json", "Output raw JSON report")
    .option("--status <category>", "Filter output to: active | stale | dead")
    .action((opts: { fix?: boolean; json?: boolean; status?: string }) => {
      cmdHealth(getDb(), opts);
    });

  // pai projects consolidate <identifier>
  projectsCmd
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

  // pai projects promote
  projectsCmd
    .command("promote")
    .description("Promote a session note into a new standalone project")
    .requiredOption("--from-session <path>", "Path to the session note markdown file")
    .requiredOption("--to <path>", "Directory path for the new project (must not exist)")
    .option("--name <name>", "Display name for the new project (derived from filename if omitted)")
    .action((opts: { fromSession: string; to: string; name?: string }) => {
      cmdPromote(getDb(), opts);
    });

  // pai projects go <query>
  projectsCmd
    .command("go <query>")
    .description(
      "Print the root path for a project by slug, partial name, or fuzzy match.\n" +
        "Designed for shell integration: cd $(pai projects go <query>)"
    )
    .action((query: string) => {
      cmdGo(getDb(), query);
    });

  // pai projects name <identifier> <shortname>
  projectsCmd
    .command("name <identifier> <shortname>")
    .description("Give a project a short name for quick access")
    .option("--permission <level>", "Permission level: full | trusted | default")
    .action(
      (
        identifier: string,
        shortname: string,
        opts: { permission?: string }
      ) => {
        cmdName(getDb(), identifier, shortname, opts);
      }
    );

  // pai projects unname <shortname>
  projectsCmd
    .command("unname <shortname>")
    .description("Remove a project's short name")
    .action((shortname: string) => {
      cmdUnname(getDb(), shortname);
    });

  // pai projects names
  projectsCmd
    .command("names")
    .description("List named projects (your curated shortlist)")
    .option("--json", "Output JSON for AIBroker consumption")
    .action((opts: { json?: boolean }) => {
      cmdNames(getDb(), opts);
    });

  // pai projects config [identifier]
  projectsCmd
    .command("config [identifier]")
    .description(
      "View or modify session launch config for a project.\n" +
        "Use --options to discover available keys and presets."
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
    .option("--preset <name>", "Apply a permission preset: full | trusted | default")
    .option("--defaults", "Manage global session defaults instead of a project")
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
