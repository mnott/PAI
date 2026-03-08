/** Memory status and settings commands for the PAI memory index. */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { openFederation } from "../../../memory/db.js";
import { renderTable, dim, bold, ok, err, warn, fmtDate } from "../../utils.js";
import { loadConfig, CONFIG_FILE, ensureConfigDir } from "../../../daemon/config.js";

function tierColor(tier: string): string {
  switch (tier) {
    case "evergreen": return chalk.green(tier);
    case "daily":     return chalk.yellow(tier);
    case "topic":     return chalk.blue(tier);
    case "session":   return chalk.dim(tier);
    default:          return tier;
  }
}

export function registerStatsCommands(
  memoryCmd: Command,
  getDb: () => Database,
): void {

  // -------------------------------------------------------------------------
  // pai memory status [project-slug]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("status [project-slug]")
    .description("Show memory index statistics")
    .action((projectSlug: string | undefined) => {
      const registryDb = getDb();

      let federation: Database;
      try {
        federation = openFederation();
      } catch (e) {
        console.error(err(`Failed to open federation database: ${e}`));
        process.exit(1);
      }

      if (projectSlug) {
        const project = registryDb
          .prepare("SELECT id, slug, display_name FROM projects WHERE slug = ?")
          .get(projectSlug) as
          | { id: number; slug: string; display_name: string }
          | undefined;

        if (!project) {
          console.error(err(`Project not found: ${projectSlug}`));
          process.exit(1);
        }

        const fileStats = federation
          .prepare("SELECT COUNT(*) as files FROM memory_files WHERE project_id = ?")
          .get(project.id) as { files: number };

        const chunkStats = federation
          .prepare("SELECT COUNT(*) as chunks FROM memory_chunks WHERE project_id = ?")
          .get(project.id) as { chunks: number };

        const lastUpdate = federation
          .prepare("SELECT MAX(updated_at) as last_at FROM memory_chunks WHERE project_id = ?")
          .get(project.id) as { last_at: number | null };

        const tierBreakdown = federation
          .prepare("SELECT tier, COUNT(*) as n FROM memory_chunks WHERE project_id = ? GROUP BY tier ORDER BY n DESC")
          .all(project.id) as Array<{ tier: string; n: number }>;

        console.log(`\n  ${bold(project.display_name)} ${dim(`(${project.slug})`)}\n`);
        console.log(`  ${bold("Files indexed:")}  ${fileStats.files}`);
        console.log(`  ${bold("Chunks:")}         ${chunkStats.chunks}`);
        console.log(`  ${bold("Last indexed:")}   ${lastUpdate.last_at ? fmtDate(lastUpdate.last_at) : dim("never")}`);

        if (tierBreakdown.length > 0) {
          console.log(`\n  ${bold("By tier:")}`);
          for (const row of tierBreakdown) {
            console.log(`    ${tierColor(row.tier).padEnd(20)}  ${row.n} chunks`);
          }
        }
        console.log();

      } else {
        const globalFiles = federation.prepare("SELECT COUNT(*) as n FROM memory_files").get() as { n: number };
        const globalChunks = federation.prepare("SELECT COUNT(*) as n FROM memory_chunks").get() as { n: number };
        const lastUpdate = federation.prepare("SELECT MAX(updated_at) as last_at FROM memory_chunks").get() as { last_at: number | null };

        const projectStats = federation
          .prepare(
            `SELECT
               mf.project_id,
               COUNT(DISTINCT mf.path) as files,
               COUNT(mc.id) as chunks,
               MAX(mc.updated_at) as last_at
             FROM memory_files mf
             LEFT JOIN memory_chunks mc ON mc.project_id = mf.project_id AND mc.path = mf.path
             GROUP BY mf.project_id
             ORDER BY chunks DESC`,
          )
          .all() as Array<{ project_id: number; files: number; chunks: number; last_at: number | null }>;

        const projectIds = projectStats.map((p) => p.project_id);
        const slugMap = new Map<number, string>();
        if (projectIds.length > 0) {
          const placeholders = projectIds.map(() => "?").join(", ");
          const slugRows = registryDb
            .prepare(`SELECT id, slug, display_name FROM projects WHERE id IN (${placeholders})`)
            .all(...projectIds) as Array<{ id: number; slug: string; display_name: string }>;
          for (const row of slugRows) {
            slugMap.set(row.id, row.slug);
          }
        }

        console.log(`\n  ${bold("PAI Memory Index — Global Status")}\n`);
        console.log(`  ${bold("Total files:")}   ${globalFiles.n}   ${bold("Total chunks:")}  ${globalChunks.n}`);
        console.log(`  ${bold("Last indexed:")}  ${lastUpdate.last_at ? fmtDate(lastUpdate.last_at) : dim("never")}`);

        if (projectStats.length > 0) {
          console.log();
          const rows = projectStats.map((p) => [
            chalk.cyan(slugMap.get(p.project_id) ?? String(p.project_id)),
            String(p.files),
            String(p.chunks),
            p.last_at ? fmtDate(p.last_at) : dim("never"),
          ]);
          console.log(renderTable(["Project", "Files", "Chunks", "Last Indexed"], rows));
        } else {
          console.log(dim("\n  No projects indexed yet. Run `pai memory index --all` to start."));
        }
        console.log();
      }
    });

  // -------------------------------------------------------------------------
  // pai memory settings [key] [value]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("settings [key] [value]")
    .description("View or modify search settings in ~/.config/pai/config.json")
    .action((key: string | undefined, value: string | undefined) => {
      const config = loadConfig();
      const search = config.search;

      if (!key) {
        console.log(`\n  ${bold("PAI Memory — Search Settings")}\n`);
        console.log(`  ${bold("mode:")}             ${search.mode}`);
        console.log(`  ${bold("rerank:")}           ${search.rerank}`);
        console.log(`  ${bold("recencyBoostDays:")} ${search.recencyBoostDays}`);
        console.log(`  ${bold("defaultLimit:")}     ${search.defaultLimit}`);
        console.log(`  ${bold("snippetLength:")}    ${search.snippetLength}`);
        console.log();
        console.log(dim(`  Config file: ${CONFIG_FILE}`));
        console.log(dim(`  Edit directly or use: pai memory settings <key> <value>`));
        console.log();
        return;
      }

      if (!value) {
        const val = (search as unknown as Record<string, unknown>)[key];
        if (val === undefined) {
          console.error(err(`Unknown setting: ${key}`));
          console.log(dim(`  Valid keys: mode, rerank, recencyBoostDays, defaultLimit, snippetLength`));
          process.exit(1);
        }
        console.log(String(val));
        return;
      }

      const validKeys = new Set(["mode", "rerank", "recencyBoostDays", "defaultLimit", "snippetLength"]);
      if (!validKeys.has(key)) {
        console.error(err(`Unknown setting: ${key}`));
        console.log(dim(`  Valid keys: ${[...validKeys].join(", ")}`));
        process.exit(1);
      }

      let fileConfig: Record<string, unknown> = {};
      if (existsSync(CONFIG_FILE)) {
        try {
          fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
        } catch {
          console.error(err(`Could not parse ${CONFIG_FILE}`));
          process.exit(1);
        }
      }

      if (!fileConfig.search || typeof fileConfig.search !== "object") {
        fileConfig.search = {};
      }

      let parsed: string | number | boolean;
      if (key === "mode") {
        if (!["keyword", "semantic", "hybrid"].includes(value)) {
          console.error(err(`Invalid mode: ${value}. Must be keyword, semantic, or hybrid.`));
          process.exit(1);
        }
        parsed = value;
      } else if (key === "rerank") {
        parsed = value === "true" || value === "1" || value === "on";
      } else {
        parsed = parseInt(value, 10);
        if (isNaN(parsed)) {
          console.error(err(`Invalid number: ${value}`));
          process.exit(1);
        }
      }

      (fileConfig.search as Record<string, unknown>)[key] = parsed;

      try {
        ensureConfigDir();
        writeFileSync(CONFIG_FILE, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
        console.log(ok(`Set search.${key} = ${parsed}`));
        console.log(dim(`  Restart daemon to apply: pai daemon restart`));
      } catch (e) {
        console.error(err(`Could not write config: ${e}`));
        process.exit(1);
      }
    });
}
