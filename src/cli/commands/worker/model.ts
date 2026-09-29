/**
 * `pai worker model` — the model ids a provider runs on, per capability.
 *
 * Reads and writes workers.providers.<name>.models.<capability> (default,
 * fast, image, …) through the same functions the MCP worker_model tool uses,
 * so CLI and chat agree on what a set means.
 */

import type { Command } from "commander";
import {
  WorkersConfigError,
  getProviderOrNative,
  isModelCapability,
  readWorkersSection,
  type ModelCapability,
} from "../../../workers/config.js";
import {
  describeModels,
  modelPrefsText,
  resolveProviderName,
  setProviderModel,
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
        "`model <model-id>` sets the active provider's default model (back-compat),\n" +
        "`model <capability>` shows one capability, `model <capability> <model-id>` sets it.\n" +
        "Capability names are open (default, fast, image, … — any ^[a-z][a-z0-9-]*$ name);\n" +
        "`pai worker capability` picks which provider serves one across the whole config.\n" +
        `--provider targets another provider.`
    )
    .option("--provider <name>", "Provider to read or change (default: the active one)")
    .option("--capability <name>", "Capability to set/show, with a model id as the only argument (same as the MCP tool)")
    .action((what: string | undefined, model: string | undefined, opts: { provider?: string; capability?: string }) => {
      try {
        const { workers } = readWorkersSection();
        if (opts.capability !== undefined) {
          if (!isModelCapability(opts.capability)) {
            throw new WorkersConfigError(`"${opts.capability}" is not a valid capability name`);
          }
          if (model !== undefined) throw new WorkersConfigError("with --capability pass only a model id");
          // rewrite into the positional form below
          model = what;
          what = opts.capability;
        }
        if (what === undefined) {
          for (const line of describeModels(workers)) console.log(`  ${line}`);
          return;
        }
        let capability: ModelCapability = "default";
        let id = what;
        if (isModelCapability(what)) {
          capability = what;
          if (model === undefined) {
            const name = resolveProviderName(workers, opts.provider);
            const p = getProviderOrNative(workers, name);
            if (p) console.log(`  ${name} ${capability} ${p.models[capability] ?? "(none)"}`);
            return;
          }
          id = model;
        } else if (model !== undefined) {
          throw new WorkersConfigError(
            `unexpected second argument "${model}" — usage: model [<capability>] <model-id>`
          );
        }
        const name = resolveProviderName(workers, opts.provider);
        const fresh = setProviderModel(name, capability, id);
        const p = getProviderOrNative(fresh, name);
        if (p) {
          console.log(ok(`${name} ${capability} model: ${p.models[capability]}`));
          console.log(dim(`  ${modelPrefsText(p)}`));
        }
      } catch (e) {
        fail(e);
      }
    });
}
