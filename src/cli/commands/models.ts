/** `pai models`: one inventory of every local model runtime, its models and users. */

import { colorEnabled, makeStyle, renderTable } from "../help.js";
import type { CommandDef } from "../define.js";
import { computeInventory, currentInventory, inventoryText, readInventoryInput } from "../../workers/model-inventory.js";

export const modelsCommand: CommandDef = {
  name: "models",
  summary: "Every local model runtime, its models, memory and users",
  description:
    "One table of what runs on this machine: runtime, status, model, kind, memory, who uses it and the port. " +
    "Covers the loopback worker providers (Strata, vllm-mlx, llama-server), ollama and Docker Model Runner. " +
    "Users are PAI's embedding backend, worker providers and consumers declared under models.consumers in config.yaml. " +
    "A duplicates hint appears when two runtimes serve the same kind of job. Read-only: status endpoints only, no model is loaded. " +
    "Uses the daemon's 30 s cache; --fresh probes now.",
  options: [
    { name: "fresh", type: "boolean", summary: "Probe now instead of reading the daemon's cache" },
    { name: "json", type: "boolean", summary: "Print the inventory as JSON" },
  ],
  examples: ["pai models", "pai models --fresh --json"],
  seeAlso: ["pai worker local"],
  async run(ctx) {
    const inv = ctx.opts.fresh ? await computeInventory(readInventoryInput()) : await currentInventory();
    if (ctx.opts.json) return void process.stdout.write(JSON.stringify(inv, null, 2) + "\n");
    const st = makeStyle(colorEnabled());
    process.stdout.write(inventoryText(inv, (h, r) => renderTable(h, r, st)) + "\n");
  },
};
