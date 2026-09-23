/** Memory status and settings commands for the PAI memory index. */

import type { Command } from "commander";
import { dim, bold, ok, err } from "../../utils.js";
import { loadConfig, paiConfigFilePath, readMainConfigRaw, writeMainConfigRaw } from "../../../daemon/config.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";

export function registerStatsCommands(memoryCmd: Command): void {

  // -------------------------------------------------------------------------
  // pai memory status [project-slug]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("status [project-slug]")
    .description("Show memory index statistics")
    .action(async (projectSlug: string | undefined) => {
      const backend = await getStorageBackend();
      const backendType = loadConfig().storageBackend;

      if (projectSlug) {
        const registry = await getRegistryBackend();
        const project = await registry.getProjectBySlug(projectSlug);

        if (!project) {
          console.error(err(`Project not found: ${projectSlug}`));
          process.exitCode = 1;
          return;
        }

        // StorageBackend has no per-project file/chunk/tier breakdown today
        // (only the global getStats() total) — see worker report for the
        // missing method (getMemoryStats(projectId?) with per-tier counts
        // and last-indexed timestamp).
        console.log(`\n  ${bold(project.display_name)} ${dim(`(${project.slug})`)}\n`);
        console.log(dim(`  Per-project breakdown is not available via the storage backend yet.`));
        console.log(dim(`  Authoritative counts:  ${bold("pai daemon status")}`));
        console.log();

      } else {
        const stats = await backend.getStats();

        console.log(`\n  ${bold("PAI Memory Index — Global Status")}\n`);
        console.log(`  ${bold("Storage backend:")} ${backendType}`);
        console.log(`  ${bold("Total files:")}   ${stats.files}   ${bold("Total chunks:")}  ${stats.chunks}`);
        console.log();
        console.log(dim(`  Per-project breakdown is not available via the storage backend yet.`));
        console.log(dim(`  Authoritative counts:  ${bold("pai daemon status")}`));
        console.log();
      }
    });

  // -------------------------------------------------------------------------
  // pai memory settings [key] [value]
  // -------------------------------------------------------------------------

  memoryCmd
    .command("settings [key] [value]")
    .description("View or modify search settings in the PAI config file (`pai config path`)")
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
        console.log(dim(`  Config file: ${paiConfigFilePath()}`));
        console.log(dim(`  Edit directly or use: pai memory settings <key> <value>`));
        console.log();
        return;
      }

      if (!value) {
        const val = (search as unknown as Record<string, unknown>)[key];
        if (val === undefined) {
          console.error(err(`Unknown setting: ${key}`));
          console.log(dim(`  Valid keys: mode, rerank, recencyBoostDays, defaultLimit, snippetLength`));
          process.exitCode = 1;
          return;
        }
        console.log(String(val));
        return;
      }

      const validKeys = new Set(["mode", "rerank", "recencyBoostDays", "defaultLimit", "snippetLength"]);
      if (!validKeys.has(key)) {
        console.error(err(`Unknown setting: ${key}`));
        console.log(dim(`  Valid keys: ${[...validKeys].join(", ")}`));
        process.exitCode = 1;
        return;
      }

      let fileConfig: Record<string, unknown>;
      try {
        fileConfig = readMainConfigRaw();
      } catch (e) {
        console.error(err(`Could not read config: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
        return;
      }

      if (!fileConfig.search || typeof fileConfig.search !== "object") {
        fileConfig.search = {};
      }

      let parsed: string | number | boolean;
      if (key === "mode") {
        if (!["keyword", "semantic", "hybrid"].includes(value)) {
          console.error(err(`Invalid mode: ${value}. Must be keyword, semantic, or hybrid.`));
          process.exitCode = 1;
          return;
        }
        parsed = value;
      } else if (key === "rerank") {
        parsed = value === "true" || value === "1" || value === "on";
      } else {
        parsed = parseInt(value, 10);
        if (isNaN(parsed)) {
          console.error(err(`Invalid number: ${value}`));
          process.exitCode = 1;
          return;
        }
      }

      (fileConfig.search as Record<string, unknown>)[key] = parsed;

      try {
        writeMainConfigRaw(fileConfig);
        console.log(ok(`Set search.${key} = ${parsed}`));
        console.log(dim(`  Restart daemon to apply: pai daemon restart`));
      } catch (e) {
        console.error(err(`Could not write config: ${e}`));
        process.exitCode = 1;
      }
    });
}
