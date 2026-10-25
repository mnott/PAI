/** `pai models`: one inventory of every local model runtime, its models and users. */

import { colorEnabled, makeStyle, renderTable } from "../help.js";
import type { CommandDef } from "../define.js";
import { computeInventory, currentInventory, inventoryText, readInventoryInput } from "../../workers/model-inventory.js";
import { readRuntimeCommands } from "../../workers/model-runtimes.js";

export const modelsCommand: CommandDef = {
  name: "models",
  summary: "Every local model runtime, its models, memory and users; start/stop a runtime",
  description:
    "One table of what runs on this machine: runtime, status, model, kind, memory, who uses it and the port. " +
    "Covers the loopback worker providers (Strata, vllm-mlx, llama-server), ollama and Docker Model Runner. " +
    "Users are PAI's embedding backend, worker providers and consumers declared under models.consumers in config.yaml. " +
    "A disabled provider (workers.yaml provider enabled:false) is not listed at all. " +
    "A duplicates hint appears only when the same model id runs on two runtimes. The table is read-only: status endpoints only, no model is loaded. " +
    "Uses the daemon's 30 s cache; --fresh probes now. " +
    "`pai models start|stop <runtime>` runs the commands configured under models.runtimes.<runtime> " +
    "(start/stop/ready) and logs the output to <PAI home>/logs/local/<runtime>.log; a runtime without configured commands cannot be started here. " +
    "`pai models add <hf-id|path>` registers a new local model: it resolves the weights (HF ids are downloaded only with --download), " +
    "picks the runtime by format (MLX: mlx_lm.server; GGUF: llama-server if installed, else refused with the reason), assigns a free port " +
    "and writes a DISABLED registry entry (workers.yaml) with location, start, health and port filled. It never enables or routes to the model. " +
    "--try then starts it, waits for health, runs one 16-token completion, stops it and reports tok/s and memory.",
  args: [
    { name: "OP", summary: "start | stop | add (omit for the inventory table)" },
    { name: "RUNTIME", summary: "start/stop: the runtime (a name under models.runtimes); add: the HF id or weights path" },
  ],
  options: [
    { name: "fresh", type: "boolean", summary: "Probe now instead of reading the daemon's cache" },
    { name: "json", type: "boolean", summary: "Print the inventory as JSON" },
    { name: "name", type: "string", summary: "add: registry name of the new model (default: from the id or path)" },
    { name: "download", type: "boolean", summary: "add: fetch an HF id that is not on disk (otherwise the weights must exist locally)" },
    { name: "try", type: "boolean", summary: "add: smoke test (start, health, one 16-token completion, stop; reports tok/s and memory)" },
    { name: "force", type: "boolean", summary: "stop: run the stop command even when the server on the port belongs to another runtime" },
    { name: "model", type: "string", summary: "start/stop: the model to load or unload (docker model run|unload)" },
  ],
  examples: ["pai models add mlx-community/Qwen3-4B-4bit --try", "pai models add ~/models/x.gguf --name x", "pai models", "pai models --fresh --json", "pai models start ollama", "pai models stop docker-model-runner --model e5"],
  seeAlso: ["pai worker local"],
  async run(ctx) {
    const words = [ctx.args.OP, ctx.args.RUNTIME].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (words[0] === "add") {
      const source = words[1];
      if (!source) throw new Error("usage: pai models add <hf-id|path> [--name n] [--download] [--try]");
      const { addModel } = await import("./models-add.js");
      const r = await addModel({ source, name: typeof ctx.opts.name === "string" ? ctx.opts.name : undefined, download: !!ctx.opts.download, try: !!ctx.opts.try });
      process.stdout.write(r.message + "\n");
      if (!r.ok) process.exitCode = 1;
      return;
    }
    const op = words[0] === "start" || words[0] === "stop" ? words[0] : "";
    if (op) {
      const runtime = words[1];
      if (!runtime) throw new Error(`usage: pai models ${op} <runtime> (configured: ${Object.keys(readRuntimeCommands()).join(", ") || "none"})`);
      const { defaultDeps, runtimeStartStop } = await import("../../router/cockpit-actions.js");
      const r = await runtimeStartStop(runtime, op, defaultDeps(), { model: typeof ctx.opts.model === "string" ? ctx.opts.model : undefined, force: !!ctx.opts.force });
      process.stdout.write(r.message + "\n");
      if (!r.ok) process.exitCode = 1;
      return;
    }
    const inv = ctx.opts.fresh ? await computeInventory(readInventoryInput()) : await currentInventory();
    if (ctx.opts.json) return void process.stdout.write(JSON.stringify(inv, null, 2) + "\n");
    const st = makeStyle(colorEnabled());
    process.stdout.write(inventoryText(inv, (h, r) => renderTable(h, r, st)) + "\n");
  },
};
