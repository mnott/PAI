/** Memory embedding backend commands: detect, use, provision, and reembed. */

import type { Command } from "commander";
import { getStorageBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../utils.js";
import { loadConfig } from "../../../daemon/config.js";
import { setConfigValueOp } from "../../../config/main-config-ops.js";
import { BACKEND_IDS, OLLAMA_ID, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL, createBackend, detectBackends } from "../../../memory/backends/index.js";
import { provisionOllama } from "../../../memory/backends/ollama-provision.js";
import { measureThroughput } from "../../../memory/embedding-gate.js";
import { reembedIndex } from "../../../memory/reembed.js";

function fail(e: unknown): void {
  console.error(err(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}

export function registerBackendCommands(memoryCmd: Command): void {
  const backendCmd = memoryCmd
    .command("backend")
    .description("Embedding backends: detect, use, provision (an index is bound to the backend that embedded it)");

  backendCmd
    .command("detect")
    .description("Probe the available embedding backends (ollama, then transformers-cpu) and recommend the fastest")
    .action(async () => {
      try {
        const cfg = loadConfig();
        const { results, recommended } = await detectBackends(cfg);
        for (const r of results) {
          console.log(`  ${r.ok ? ok(r.id) : dim(r.id)}  ${r.ok ? "available" : "unavailable"}: ${r.reason}`);
        }
        console.log(`\nConfigured: ${bold(cfg.embedding?.backend ?? "transformers-cpu-q8")}`);
        console.log(recommended ? `Recommended: ${bold(recommended)}` : "Recommended: none available");
        if (recommended && recommended !== cfg.embedding?.backend) {
          console.log(dim(`  Switch with \`pai memory backend use ${recommended}\` (an existing index also needs \`pai memory reembed\`).`));
        }
      } catch (e) {
        fail(e);
      }
    });

  backendCmd
    .command("use <id>")
    .description(`Write the embedding backend to config (${BACKEND_IDS.join(" | ")}); does not touch the index`)
    .option("--model <name>", "Model name on the backend (ollama: server-side model name)")
    .action(async (id: string, opts: { model?: string }) => {
      try {
        const b = createBackend(id, loadConfig(), opts.model); // validates the id
        setConfigValueOp("embedding.backend", id);
        if (opts.model) setConfigValueOp("embedding.model", opts.model, { force: true });
        console.log(ok(`embedding.backend = ${id}`) + (opts.model ? ` (model ${b.model})` : ""));
        const avail = await b.available();
        if (!avail.ok) console.log(dim(`  Note: not available right now: ${avail.reason}`));
        console.log(dim("  If the index already holds vectors from another backend, run `pai memory reembed`."));
      } catch (e) {
        fail(e);
      }
    });

  backendCmd
    .command("provision <backend>")
    .description("Provision a backend's model. ollama: download the F16 GGUF of arctic-embed-m-v1.5 and `ollama create` it")
    .action(async (name: string) => {
      try {
        if (name !== "ollama") throw new Error(`Cannot provision "${name}"; only "ollama" needs provisioning`);
        const cfg = loadConfig();
        await provisionOllama({
          baseUrl: cfg.embedding?.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL,
          model: cfg.embedding?.model ?? OLLAMA_DEFAULT_MODEL,
        });
        console.log(ok("Done.") + dim(`  Use it with \`pai memory backend use ${OLLAMA_ID}\`.`));
      } catch (e) {
        fail(e);
      }
    });

  memoryCmd
    .command("reembed")
    .description("Switch the index to an embedding backend: clears all vectors (batched, resumable); `pai memory embed` refills")
    .option("--backend <id>", "Target backend (default: the configured one); also written to config")
    .option("--yes", "Confirm; without it only the plan is printed")
    .action(async (opts: { backend?: string; yes?: boolean }) => {
      try {
        const cfg = loadConfig();
        const id = opts.backend ?? cfg.embedding?.backend ?? "transformers-cpu-q8";
        const target = createBackend(id, cfg);
        const avail = await target.available();
        if (!avail.ok) throw new Error(`${id} is not available: ${avail.reason}`);

        const storage = await getStorageBackend();
        const { chunks } = await storage.getStats();
        // ponytail: synthetic ~400-token texts; real chunk mix shifts the ETA somewhat.
        const probe = Array.from({ length: 32 }, () => "memory index chunk embedding vector query ".repeat(40));
        const cps = await measureThroughput(target, probe);
        const eta = cps > 0 ? Math.round(chunks / cps / 60) : NaN;
        console.log(`Index: ${bold(String(chunks))} chunks. Backend ${bold(id)} runs ~${cps.toFixed(1)} chunks/s: ETA ~${eta} min.`);

        if (!opts.yes) {
          console.error(err("Refusing without --yes: this clears every stored vector (keyword search keeps working while it refills)."));
          process.exitCode = 1;
          return;
        }
        const cleared = await reembedIndex(storage, target, {
          onBatch: (n) => process.stdout.write(`\r  ${n} vectors cleared...`),
        });
        process.stdout.write("\r");
        if (opts.backend && opts.backend !== cfg.embedding?.backend) setConfigValueOp("embedding.backend", id);
        console.log(ok(`Cleared ${cleared} vectors; index bound to ${id} (${target.model}).`));
        console.log(dim("  Refill with `pai memory embed --background` (the daemon pass also does it)."));
      } catch (e) {
        fail(e);
      }
    });
}
