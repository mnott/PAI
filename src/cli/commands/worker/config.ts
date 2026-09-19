/**
 * `pai worker config` — manage workers.yaml itself (as opposed to
 * `pai worker providers`/`classes`, which manage what is inside it).
 */

import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { CONFIG_FILE } from "../../../daemon/config.js";
import { WorkersConfigError } from "../../../workers/config.js";
import {
  initWorkersYaml,
  migrateWorkersToYaml,
  parseWorkersYamlDocument,
  workersYamlPath,
} from "../../../workers/workers-config.js";
import { describeProviders } from "../../../workers/providers.js";
import { readWorkersSection } from "../../../workers/config.js";
import { ok, err, dim } from "../../utils.js";

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(err("pai worker: ") + msg);
  process.exitCode = 1;
}

export function registerWorkerConfigCommands(workerCmd: Command): void {
  const configCmd = workerCmd
    .command("config")
    .description("workers.yaml itself: path, init, migrate, check");

  configCmd
    .command("path")
    .description("Print the resolved workers.yaml path")
    .action(() => {
      console.log(workersYamlPath(CONFIG_FILE));
    });

  configCmd
    .command("init")
    .description("Write the commented starter workers.yaml (refuses if one already exists)")
    .action(() => {
      try {
        const path = initWorkersYaml(CONFIG_FILE);
        console.log(ok(`wrote ${path}`));
      } catch (e) {
        fail(e);
      }
    });

  configCmd
    .command("migrate")
    .description(
      "Move providers/classes/mcp_sets/active out of the JSON config into workers.yaml.\n" +
        "Backs the JSON section up to workers.json.migrated-<date> next to it."
    )
    .option("--force", "Overwrite an existing workers.yaml")
    .option("--dry-run", "Print the would-be workers.yaml without writing anything")
    .action((opts: { force?: boolean; dryRun?: boolean }) => {
      try {
        const r = migrateWorkersToYaml(CONFIG_FILE, { force: opts.force, dryRun: opts.dryRun });
        if (r.dryRun) {
          console.log(dim(`# would write ${r.yamlPath}:`));
          console.log(r.yamlText);
          return;
        }
        console.log(ok(`wrote ${r.yamlPath}`));
        console.log(`  JSON workers section backed up to ${r.backupPath}`);
        console.log();
        const { workers } = readWorkersSection(CONFIG_FILE);
        for (const line of describeProviders(workers)) console.log(`  ${line}`);
      } catch (e) {
        fail(e);
      }
    });

  configCmd
    .command("check [path]")
    .description("Validate workers.yaml (or the file at [path]); exits non-zero with file:line on error")
    .action((path: string | undefined) => {
      try {
        const target = path ?? workersYamlPath(CONFIG_FILE);
        if (!existsSync(target)) {
          console.log(dim(`no workers.yaml at ${target} — JSON config fallback is in effect`));
          return;
        }
        const text = readFileSync(target, "utf8");
        const doc = parseDocument(text);
        if (doc.errors.length) {
          throw new WorkersConfigError(`${target}: ${doc.errors[0]!.message}`);
        }
        const data = parseWorkersYamlDocument(doc, target);
        console.log(
          ok(
            `${target} OK — ${Object.keys(data.providers).length} provider(s), ` +
              `${Object.keys(data.classes).length} class(es)`
          )
        );
      } catch (e) {
        fail(e);
      }
    });
}
