/**
 * The embed pipeline shared by `pai memory embed` (CLI and cockpit job) and the
 * daemon pass. Phases overlap instead of running one after another: the next
 * page of chunks is fetched while the current one is embedded, and up to
 * `concurrency` batches are in flight at once, each writing its vectors in one
 * bulk statement as soon as its embed call returns. Measured serial: ~25% of
 * the time in the model, the rest fetching, tokenizing and writing row by row.
 *
 * Stop semantics are unchanged: stop / budget / yield are checked before a
 * batch is taken, batches already in flight finish and are written, and the
 * unwritten rest stays NULL so a re-run resumes where this one ended.
 */

import { loadConfig } from "../daemon/config.js";

export type PipelineEnd = "done" | "budget" | "yielded" | "stopped";

export interface PipelineRow {
  id: string;
  text: string;
}

export interface PipelineDeps<R extends PipelineRow> {
  /** Next page after `last` (null = first page); empty = no more. Called one page ahead. */
  fetchPage: (last: R | null) => Promise<R[]>;
  embed: (texts: string[]) => Promise<Float32Array[]>;
  /** Store the vectors of one batch durably (one bulk statement). */
  write: (batch: R[], vecs: Float32Array[]) => Promise<void>;
  batchSize: number;
  /** Batches in flight at once (embed + write each). */
  concurrency: number;
  /** Checked before each batch is taken. */
  shouldStop?: () => boolean;
  /** Epoch ms after which no new batch is taken. */
  deadline?: number;
  now?: () => number;
  /** A string ends the run ("yielded") with that reason. */
  shouldYield?: () => string | null;
  /** After each batch is stored; `done` counts stored chunks. */
  onBatch?: (batch: R[], done: number) => void;
}

export interface PipelineResult {
  done: number;
  end: PipelineEnd;
  reason?: string;
}

export const DEFAULT_EMBED_CONCURRENCY = 3;

export async function runEmbedPipeline<R extends PipelineRow>(d: PipelineDeps<R>): Promise<PipelineResult> {
  const now = d.now ?? Date.now;
  let done = 0;
  let end: PipelineEnd = "done";
  let reason: string | undefined;
  let halted = false;
  let failure: { error: unknown } | null = null;

  let page: R[] = [];
  let pos = 0;
  let exhausted = false;
  let next: Promise<R[]> | null = null;

  const prefetch = (last: R | null): void => {
    next = d.fetchPage(last);
    next.catch(() => undefined); // surfaced when awaited
  };
  prefetch(null);

  /** Take the next batch (serialised by the caller), prefetching the page after the one now consumed. */
  async function take(): Promise<R[] | null> {
    if (pos >= page.length) {
      if (exhausted || !next) return null;
      page = await next;
      next = null;
      pos = 0;
      if (page.length === 0) {
        exhausted = true;
        return null;
      }
      prefetch(page[page.length - 1]);
    }
    const batch = page.slice(pos, pos + d.batchSize);
    pos += batch.length;
    return batch;
  }

  let taking: Promise<unknown> = Promise.resolve();
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted || failure) return;
      // takes are serialised so two workers never read the same page position
      let batch: R[] | null = null;
      const turn = taking.then(async () => {
        if (halted || failure) return;
        if (d.shouldStop?.()) { halted = true; end = "stopped"; return; }
        if (d.deadline !== undefined && now() >= d.deadline) { halted = true; end = "budget"; return; }
        const why = d.shouldYield?.() ?? null;
        if (why) { halted = true; end = "yielded"; reason = why; return; }
        batch = await take();
      });
      taking = turn.catch(() => undefined);
      try {
        await turn;
      } catch (error) {
        failure ??= { error };
        return;
      }
      if (!batch) return;
      const b: R[] = batch;
      try {
        const vecs = await d.embed(b.map((r) => r.text));
        await d.write(b, vecs);
        done += b.length;
        d.onBatch?.(b, done);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, d.concurrency) }, worker));
  if (next) (next as Promise<R[]>).catch(() => undefined);
  if (failure) throw (failure as { error: unknown }).error;
  return { done, end, ...(reason ? { reason } : {}) };
}

/** embedConcurrency from the main config, or the default when it is unset or unreadable. */
export function configuredEmbedConcurrency(): number {
  try {
    const n = Number(loadConfig().embedConcurrency);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : DEFAULT_EMBED_CONCURRENCY;
  } catch {
    return DEFAULT_EMBED_CONCURRENCY;
  }
}
