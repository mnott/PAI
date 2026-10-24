/** Memory embed command: generate embeddings for un-embedded chunks. */

import type { StorageBackend } from "../../../storage/interface.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../lib/utils.js";
import { reexecBackground } from "../../../daemon/pass-priority.js";
import { retryTransient } from "../../../memory/indexer/retry.js";
import { DEFAULT_EMBED_MAX_MINUTES } from "../../../memory/embed-pass.js";
import { configuredEmbedConcurrency, runEmbedPipeline } from "../../../memory/embed-pipeline.js";
import { CliError } from "../../define.js";
import { jobProgressFromEnv, type ProgressWriter } from "../../../memory/job-progress.js";
import { acquireRun, readRun, type RunHandle, type RunOutcome } from "../../../memory/run-state.js";

// ---------------------------------------------------------------------------
// Shared embed runner (used by both index --embed and embed sub-command)
// ---------------------------------------------------------------------------

/** Rows fetched per DB round-trip. Keeps memory flat regardless of backlog size. */
const DEFAULT_PAGE_SIZE = 500;

/** The CLI's progress line: chunks embedded so far over the backlog at start. */
export function embedProgressLine(done: number, backlog: number): string {
  return `${done} / ${backlog} chunks embedded...`;
}

export async function runEmbed(
  backend: StorageBackend,
  projectId?: number,
  projectSlug?: string,
  batchSize = 50,
  pageSize = DEFAULT_PAGE_SIZE,
  /** Wall-clock budget in ms; undefined = unlimited. Checked between batches. */
  maxMillis?: number,
  /** Progress marker of this run (cockpit Memory section). */
  run?: RunHandle,
  /** Checked between batches; true ends the run cleanly (SIGTERM from the cockpit's stop). */
  shouldStop?: () => boolean,
  /** Progress into the cockpit job record (embed command only). */
  progressArg?: ProgressWriter | null,
): Promise<{ done: number; budgetHit: boolean; stopped: boolean }> {
  const label = projectSlug ? `project ${projectSlug}` : "all projects";
  console.log(dim(`Generating embeddings for ${label} (this may take a while on first run)...`));

  const { serializeEmbedding } = await import("../../../memory/embeddings.js");
  const { gateBackend } = await import("../../../memory/embedding-gate.js");

  const jobProgress = progressArg === undefined ? jobProgressFromEnv("embed") : progressArg;
  const gate = await gateBackend(backend, { record: true });
  if (!gate.ok) {
    console.error(err(gate.reason));
    jobProgress?.finish();
    process.exitCode = 1;
    return { done: 0, budgetHit: false, stopped: false };
  }
  const embedder = gate.backend;

  // The backlog at start: chunks without a vector, not the index's total chunk count. Only a
  // single project has no such count, so its progress line falls back to the project's chunks.
  const backlog =
    projectId !== undefined
      ? (await backend.getProjectStats(projectId)).chunks
      : await backend.countUnembeddedChunks();
  run?.setBacklog(backlog);
  jobProgress?.update({ phase: "embed", unit: "chunks", done: 0, total: backlog });

  const concurrency = configuredEmbedConcurrency();
  const r = await runEmbedPipeline<{ id: string; text: string; project_id: number; path: string }>({
    fetchPage: (last) =>
      retryTransient(() => backend.getUnembeddedChunkIds(projectId, pageSize, last ? { projectId: last.project_id, id: last.id } : null)),
    embed: (texts) => retryTransient(() => embedder.embed(texts)),
    write: (batch, vecs) =>
      retryTransient(() => backend.updateEmbeddings(batch.map((row, j) => ({ id: row.id, embedding: serializeEmbedding(vecs[j]) })))),
    batchSize,
    concurrency,
    shouldStop,
    deadline: maxMillis === undefined ? undefined : Date.now() + maxMillis,
    onBatch: (_, n) => {
      run?.progress(n);
      jobProgress?.update({ done: n });
      process.stdout.write(`\r  ${embedProgressLine(n, backlog)}`);
    },
  });
  const done = r.done;
  const budgetHit = r.end === "budget";
  const stopped = r.end === "stopped";

  jobProgress?.finish();
  process.stdout.write("\r");
  if (stopped) {
    console.log(ok(`Stopped.`) + `  ${bold(String(done))} chunks embedded; run again to continue`);
  } else if (budgetHit) {
    console.log(ok(`Time budget reached.`) + `  ${bold(String(done))} chunks embedded; run again to continue (or --all for no limit)`);
  } else {
    console.log(ok(`Done.`) + `  ${bold(String(done))} chunks embedded`);
  }
  return { done, budgetHit, stopped };
}

// ---------------------------------------------------------------------------
// New command function
// ---------------------------------------------------------------------------

export async function memoryEmbedCmd(projectSlug: string | undefined, opts: { batchSize?: number; maxMinutes?: number; all?: boolean; background?: boolean }): Promise<number> {
  // Always low priority: a hand-run pass over a big backlog must not slow the machine.
  reexecBackground();
  const maxMillis = opts.all ? undefined : (opts.maxMinutes ?? DEFAULT_EMBED_MAX_MINUTES) * 60_000;
  let backend: StorageBackend;
  try {
    backend = await getStorageBackend();
  } catch (e) {
    console.error(err(`Failed to open storage backend: ${e}`));
    return 1;
  }

  const held = readRun();
  if (held) {
    console.error(err(`${held.kind} already running (started by ${held.by}, pid ${held.pid})`));
    return 1;
  }
  const run = acquireRun("embed");
  if (!run) {
    console.error(err("another memory run just started"));
    return 1;
  }
  let result: { outcome: RunOutcome; reason?: string } | undefined;
  const jobProgress = jobProgressFromEnv("embed");
  const settle = (r: { done: number; budgetHit: boolean; stopped: boolean }): void => {
    result = r.stopped ? { outcome: "stopped", reason: "stopped on request" } : r.budgetHit ? { outcome: "budget", reason: "time budget reached" } : process.exitCode === 1 ? { outcome: "failed", reason: "embedding backend not usable" } : { outcome: "done" };
  };
  // the cockpit's stop sends SIGTERM: finish the batch in hand, then end like a spent budget
  let stop = false;
  const onTerm = (): void => { stop = true; };
  process.on("SIGTERM", onTerm);
  try {
    if (projectSlug) {
      const registry = await getRegistryBackend();
      const project = await registry.getProjectBySlug(projectSlug);

      if (!project) {
        console.error(err(`Project not found: ${projectSlug}`));
        return 1;
      }

      settle(await runEmbed(backend, project.id, project.slug, opts.batchSize ?? 25, undefined, maxMillis, run, () => stop, jobProgress));
    } else {
      settle(await runEmbed(backend, undefined, undefined, opts.batchSize ?? 25, undefined, maxMillis, run, () => stop, jobProgress));
    }
  } finally {
    process.off("SIGTERM", onTerm);
    jobProgress?.finish();
    run.release(result);
  }

  return 0;
}
