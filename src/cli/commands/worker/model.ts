/**
 * `pai worker model` — the model ids a provider runs on.
 *
 * Reads and writes workers.providers.<name>.models.{default,fast} through the
 * same functions the MCP worker_model tool uses, so CLI and chat agree on
 * what a set means.
 */

import type { Command } from "commander";
import { WorkersConfigError, readWorkersSection } from "../../../workers/config.js";
import {
  describeModels,
  resolveProviderName,
  setProviderModel,
  type ModelSlot,
} from "../../../workers/providers.js";
import { ok, err, dim } from "../../utils.js";

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(err("pai worker: ") + msg);
  process.exitCode = 1;
}

export function registerWorkerModelCommand(workerCmd: Command): void {
  workerCmd
    .command("model [what] [model]")
    .description(
      "Model ids per provider: no args lists them,\n" +
        "`model <model-id>` sets the active provider's default model,\n" +
        "`model fast <model-id>` its fast model. --provider targets another provider."
    )
    .option("--provider <name>", "Provider to read or change (default: the active one)")
    .action((what: string | undefined, model: string | undefined, opts: { provider?: string }) => {
      try {
        const { workers } = readWorkersSection();
        if (what === undefined) {
          for (const line of describeModels(workers)) console.log(`  ${line}`);
          return;
        }
        let slot: ModelSlot = "default";
        let id = what;
        if (what === "fast") {
          slot = "fast";
          const name = resolveProviderName(workers, opts.provider);
          if (model === undefined) {
            const p = workers.providers[name];
            if (p) console.log(`  ${name} fast ${p.models.fast ?? "(none)"}`);
            return;
          }
          id = model;
        } else if (model !== undefined) {
          throw new WorkersConfigError(
            `unexpected second argument "${model}" — usage: model [fast] <model-id>`
          );
        }
        const name = resolveProviderName(workers, opts.provider);
        const fresh = setProviderModel(name, slot, id);
        const p = fresh.providers[name];
        if (p) {
          console.log(ok(`${name} ${slot} model: ${slot === "fast" ? p.models.fast : p.models.default}`));
          console.log(dim(`  default ${p.models.default}  fast ${p.models.fast ?? "(none)"}`));
        }
      } catch (e) {
        fail(e);
      }
    });
}
