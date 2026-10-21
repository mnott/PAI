/** Memory embed command: generate embeddings for un-embedded chunks. */

import type { StorageBackend } from "../../../storage/interface.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../lib/utils.js";
import { reexecBackground } from "../../../daemon/pass-priority.js";
import { retryTransient } from "../../../memory/indexer/retry.js";
import { DEFAULT_EMBED_MAX_MINUTES } from "../../../memory/embed-pass.js";
import { CliError } from "../../define.js";
import { acquireRun, readRun, type RunHandle } from "../../../memory/run-state.js";

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
): Promise<{ done: number; budgetHit: boolean }> {
  const label = projectSlug ? `project ${projectSlug}` : "all projects";
  console.log(dim(`Generating embeddings for ${label} (this may take a while on first run)...`));

  const { serializeEmbedding } = await import("../../../memory/embeddings.js");
  const { gateBackend } = await import("../../../memory/embedding-gate.js");

  const gate = await gateBackend(backend, { record: true });
  if (!gate.ok) {
    console.error(err(gate.reason));
    process.exitCode = 1;
    return { done: 0, budgetHit: false };
  }
  const embedder = gate.backend;

  // The backlog at start: chunks without a vector, not the index's total chunk count. Only a
  // single project has no such count, so its progress line falls back to the project's chunks.
  const backlog =
    projectId !== undefined
      ? (await backend.getProjectStats(projectId)).chunks
      : await backend.countUnembeddedChunks();
  run?.setBacklog(backlog);

  let done = 0;
  let budgetHit = false;
  let stopped = false;
  const deadline = maxMillis === undefined ? Infinity : Date.now() + maxMillis;
  let after: { projectId: number; id: string } | null = null;

  while (true) {
    const page = await retryTransient(() => backend.getUnembeddedChunkIds(projectId, pageSize, after));
    if (page.length === 0) break;

    for (let i = 0; i < page.length; i += batchSize) {
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
      if (Date.now() >= deadline) {
        budgetHit = true;
        break;
      }
      const batch = page.slice(i, i + batchSize);
      const vecs = await retryTransient(() => embedder.embed(batch.map((r) => r.text)));
      await Promise.all(
        batch.map((row, j) =>
          retryTransient(() => backend.updateEmbedding(row.id, serializeEmbedding(vecs[j])))
        )
      );
      done += batch.length;
      run?.progress(done);
      process.stdout.write(`\r  ${embedProgressLine(done, backlog)}`);
    }

    if (budgetHit || stopped) break;
    const last = page[page.length - 1];
    after = { projectId: last.project_id, id: last.id };
  }

  process.stdout.write("\r");
  if (stopped) {
    console.log(ok(`Stopped.`) + `  ${bold(String(done))} chunks embedded; run again to continue`);
  } else if (budgetHit) {
    console.log(ok(`Time budget reached.`) + `  ${bold(String(done))} chunks embedded; run again to continue (or --all for no limit)`);
  } else {
    console.log(ok(`Done.`) + `  ${bold(String(done))} chunks embedded`);
  }
  return { done, budgetHit };
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

      await runEmbed(backend, project.id, project.slug, opts.batchSize ?? 25, undefined, maxMillis, run, () => stop);
    } else {
      await runEmbed(backend, undefined, undefined, opts.batchSize ?? 25, undefined, maxMillis, run, () => stop);
    }
  } finally {
    process.off("SIGTERM", onTerm);
    run.release();
  }

  return 0;
}
