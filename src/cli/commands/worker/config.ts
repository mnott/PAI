/**
 * `pai worker config` — manage workers.yaml itself (as opposed to
 * `pai worker providers`/`classes`, which manage what is inside it).
 */

import type { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseDocument } from "yaml";
import { CONFIG_FILE } from "../../../daemon/config.js";
import { WorkersConfigError, expandHome } from "../../../workers/config.js";
import {
  inlineWorkersYamlKeys,
  initWorkersYaml,
  migrateWorkersToYaml,
  needsWorkersYamlRelocation,
  parseWorkersYamlDocument,
  relocateWorkersYaml,
  workersYamlLegacyNotice,
  workersYamlPath,
} from "../../../workers/workers-config.js";
import { describeProviders } from "../../../workers/providers.js";
import { readWorkersSection } from "../../../workers/config.js";
import { ok, err, warn, dim } from "../../utils.js";

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(err("pai worker: ") + msg);
  process.exitCode = 1;
}

export function registerWorkerConfigCommands(workerCmd: Command): void {
  const configCmd = workerCmd
    .command("config")
    .description("workers.yaml itself: path, init, migrate, check, inline-keys");

  configCmd
    .command("path")
    .description("Print the resolved workers.yaml path")
    .action(() => {
      console.log(workersYamlPath());
    });

  configCmd
    .command("init")
    .description("Write the commented starter workers.yaml (refuses if one already exists)")
    .action(() => {
      try {
        const path = initWorkersYaml();
        console.log(ok(`wrote ${path}`));
      } catch (e) {
        fail(e);
      }
    });

  configCmd
    .command("migrate")
    .description(
      "Two things this can mean, chosen from what is on disk:\n" +
        "  - workers.yaml still at an old location (~/.claude/workers.yaml or\n" +
        "    ~/.config/pai/workers.yaml): moved byte-for-byte to ~/.claude/pai/workers.yaml\n" +
        "    (no JSON involved); the old file is renamed to workers.yaml.migrated-<date>.\n" +
        "  - no workers.yaml yet: built from the JSON `workers` section, which is\n" +
        "    backed up to workers.json.migrated-<date> next to config.json."
    )
    .option("--force", "Overwrite an existing workers.yaml")
    .option("--dry-run", "Print the plan without writing anything")
    .action((opts: { force?: boolean; dryRun?: boolean }) => {
      try {
        if (needsWorkersYamlRelocation()) {
          const r = relocateWorkersYaml({ force: opts.force, dryRun: opts.dryRun });
          if (r.dryRun) {
            console.log(dim(`# would move ${r.fromPath} → ${r.toPath}`));
            return;
          }
          console.log(ok(`moved ${r.fromPath} → ${r.toPath}`));
          return;
        }
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
        const target = path ?? workersYamlPath();
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

        const both = Object.entries(data.providers)
          .filter(([, p]) => p.key && p.keyFile)
          .map(([name]) => name);
        if (both.length) {
          console.log(dim(`  note: ${both.join(", ")} — both key and key_file set; key wins`));
        }

        const mode = statSync(target).mode & 0o777;
        const hasKey = Object.values(data.providers).some((p) => p.key);
        if (hasKey && mode !== 0o600) {
          console.log(
            warn(
              `  warning: ${target} contains a key: field but is mode ${mode.toString(8)} — chmod 600 ${target}`
            )
          );
        }

        const legacyNotice = workersYamlLegacyNotice();
        if (legacyNotice) console.log(dim(`  ${legacyNotice}`));
      } catch (e) {
        fail(e);
      }
    });

  configCmd
    .command("inline-keys")
    .description("Move each provider's key_file contents inline as `key:` (quoted); key files are left on disk")
    .option("--dry-run", "Print the plan (provider names and key file paths, never key values); write nothing")
    .action((opts: { dryRun?: boolean }) => {
      try {
        const r = inlineWorkersYamlKeys({ dryRun: opts.dryRun });
        if (!r.inlined.length) {
          console.log(dim("no providers have a key_file without an inline key — nothing to do"));
          return;
        }
        for (const { provider, keyFilePath } of r.inlined) {
          console.log((r.dryRun ? dim("  would inline ") : ok("  inlined ")) + `${provider} (was ${keyFilePath})`);
        }
        if (r.dryRun) {
          console.log(dim("  dry run — nothing written"));
          return;
        }
        console.log(ok(`wrote ${r.yamlPath}`));
        console.log(dim("  key files left on disk — remove them yourself if you no longer need them:"));
        for (const { keyFilePath } of r.inlined) console.log(dim(`    ${expandHome(keyFilePath)}`));
      } catch (e) {
        fail(e);
      }
    });
}
