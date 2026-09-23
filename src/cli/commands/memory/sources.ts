/**
 * `pai memory sources` — what the indexer is actually taking in.
 *
 * The index had grown to ~1.5M chunks against a vault of ~2,700 notes, and
 * nothing in the CLI could show why. `memory status` refuses to report at all
 * when the backend is not SQLite, and `daemon status` gives three totals with no
 * composition — so answering "what is it indexing, and why is it re-indexing"
 * meant hand-writing aggregate SQL against the container.
 *
 * The cause, when it was finally measured, was visible in one breakdown: the
 * vault indexer follows symlinks out of the vault into cloud-synced trees, and
 * those trees have mtimes rewritten by the sync client on content that has not
 * changed. Each rewrite re-chunks the file, and re-chunking assigns new chunk
 * ids, which discards the embeddings — so the embedder was re-doing work
 * indefinitely while never catching up.
 *
 * Hence the four sections below. Each one exists because it was needed:
 *   composition — the vault dwarfing everything else is the first clue
 *   roots       — where content enters from, which is how symlink leakage shows
 *   heaviest    — single files contributing thousands of chunks (attachments)
 *   churn       — chunks rewritten per day, which is what distinguishes a
 *                 backlog that will finish from a treadmill that never will
 */

import { ok, warn, dim, bold, header, renderTable } from "../../utils.js";
import type { StorageBackend } from "../../../storage/interface.js";

const num = (v: unknown): number => Number(v ?? 0);
const pct = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

/** Group the leading path segments, which is where content enters the index. */
export function rootOf(path: string, depth = 2): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= depth) return path;
  return parts.slice(0, depth).join("/") + "/…";
}

export async function cmdMemorySources(
  backend: StorageBackend,
  opts: { limit?: number } = {}
): Promise<void> {
  const limit = opts.limit ?? 8;

  const report = await backend.getMemorySourcesReport();
  const comp = report.composition;

  if (comp.length === 0) {
    console.log();
    console.log(warn(`  Nothing indexed yet, or the backend is unreachable.`));
    console.log(dim(`  Backend: ${backend.backendType}`));
    console.log();
    return;
  }

  const totalChunks = comp.reduce((s, r) => s + num(r.chunks), 0);
  const totalEmbedded = comp.reduce((s, r) => s + num(r.embedded), 0);

  console.log();
  console.log(header(`What the indexer has taken in`));
  console.log();
  console.log(
    `  ${bold(totalChunks.toLocaleString())} chunks   ` +
      `${totalEmbedded.toLocaleString()} embedded (${pct(totalEmbedded, totalChunks)})   ` +
      dim(`backend: ${backend.backendType}`)
  );
  console.log();

  console.log(
    renderTable(
      ["source / tier", "chunks", "share", "embedded"],
      comp.map((r) => [
        `${r.source} / ${r.tier}`,
        num(r.chunks).toLocaleString(),
        pct(num(r.chunks), totalChunks),
        `${num(r.embedded).toLocaleString()} (${pct(num(r.embedded), num(r.chunks))})`,
      ])
    )
  );

  // ---- where it enters from ---------------------------------------------
  const paths = report.paths;

  const byRoot = new Map<string, number>();
  for (const r of paths) {
    const k = rootOf(String(r.path ?? ""));
    byRoot.set(k, (byRoot.get(k) ?? 0) + num(r.chunks));
  }
  const roots = [...byRoot.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  console.log();
  console.log(header(`Where it comes from`));
  console.log(dim(`  A root you did not expect here is usually a symlink leading out of the vault.`));
  console.log();
  console.log(
    renderTable(
      ["root", "chunks", "share"],
      roots.map(([k, v]) => [k, v.toLocaleString(), pct(v, totalChunks)])
    )
  );

  // ---- heaviest single files -------------------------------------------
  const heaviest = [...paths]
    .sort((a, b) => num(b.chunks) - num(a.chunks))
    .slice(0, limit);

  console.log();
  console.log(header(`Heaviest single files`));
  console.log();
  console.log(
    renderTable(
      ["chunks", "path"],
      heaviest.map((r) => [num(r.chunks).toLocaleString(), tail(String(r.path ?? ""), 62)])
    )
  );

  // ---- churn ------------------------------------------------------------
  // The section that distinguishes a backlog from a treadmill. A day with a
  // large chunk count and a small embedded count means those chunks were
  // rewritten and their embeddings thrown away.
  const churn = report.churn;

  console.log();
  console.log(header(`Rewritten per day`));
  console.log(
    dim(`  Many chunks with few embedded means they were re-chunked and their`)
  );
  console.log(dim(`  embeddings discarded — work the embedder has to redo.`));
  console.log();
  console.log(
    renderTable(
      ["day", "chunks touched", "of those embedded"],
      churn.map((r) => [
        String(r.day),
        num(r.chunks).toLocaleString(),
        `${num(r.embedded).toLocaleString()} (${pct(num(r.embedded), num(r.chunks))})`,
      ])
    )
  );

  const missing = totalChunks - totalEmbedded;
  console.log();
  if (missing > 0) {
    console.log(`  ${bold(missing.toLocaleString())} chunks still need embedding.`);
  } else {
    console.log(ok(`  Everything indexed is embedded.`));
  }
  console.log();
}

/** Keep the informative end of a long path. */
function tail(s: string, n: number): string {
  return s.length <= n ? s : "…" + s.slice(-(n - 1));
}

