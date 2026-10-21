/** Memory embedding backend commands: detect, use, provision, and reembed. */

import { getStorageBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../lib/utils.js";
import { loadConfig } from "../../../daemon/config.js";
import { setConfigValueOp } from "../../../config/main-config-ops.js";
import { BACKEND_IDS, OLLAMA_ID, OLLAMA_DEFAULT_MODEL, ollamaDefaultUrl, createBackend, detectBackends } from "../../../memory/backends/index.js";
import { provisionOllama } from "../../../memory/backends/ollama-provision.js";
import { measureThroughput } from "../../../memory/embedding-gate.js";
import { reembedIndex } from "../../../memory/reembed.js";

function fail(e: unknown): void {
  console.error(err(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}

export async function memoryBackendDetectCmd(): Promise<number> {
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
    return 0;
  } catch (e) {
    fail(e);
    return 1;
  }
}

export async function memoryBackendUseCmd(id: string, opts: { model?: string }): Promise<number> {
  try {
    const b = createBackend(id, loadConfig(), opts.model); // validates the id
    setConfigValueOp("embedding.backend", id);
    if (opts.model) setConfigValueOp("embedding.model", opts.model, { force: true });
    console.log(ok(`embedding.backend = ${id}`) + (opts.model ? ` (model ${b.model})` : ""));
    const avail = await b.available();
    if (!avail.ok) console.log(dim(`  Note: not available right now: ${avail.reason}`));
    console.log(dim("  If the index already holds vectors from another backend, run `pai memory reembed`."));
    return 0;
  } catch (e) {
    fail(e);
    return 1;
  }
}

export async function memoryBackendProvisionCmd(backend: string): Promise<number> {
  try {
    if (backend !== "ollama") throw new Error(`Cannot provision "${backend}"; only "ollama" needs provisioning`);
    const cfg = loadConfig();
    await provisionOllama({
      baseUrl: cfg.embedding?.ollama?.baseUrl ?? ollamaDefaultUrl(),
      model: cfg.embedding?.model ?? OLLAMA_DEFAULT_MODEL,
    });
    console.log(ok("Done.") + dim(`  Use it with \`pai memory backend use ${OLLAMA_ID}\`.`));
    return 0;
  } catch (e) {
    fail(e);
    return 1;
  }
}

export async function memoryReembedCmd(opts: { backend?: string; yes?: boolean }): Promise<number> {
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
      return 1;
    }
    const cleared = await reembedIndex(storage, target, {
      onBatch: (n) => process.stdout.write(`\r  ${n} vectors cleared...`),
    });
    process.stdout.write("\r");
    if (opts.backend && opts.backend !== cfg.embedding?.backend) setConfigValueOp("embedding.backend", id);
    console.log(ok(`Cleared ${cleared} vectors; index bound to ${id} (${target.model}).`));
    console.log(dim("  Refill with `pai memory embed --background` (the daemon pass also does it)."));
    return 0;
  } catch (e) {
    fail(e);
    return 1;
  }
}
