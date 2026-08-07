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

interface Row {
  label: string;
  chunks: number;
  embedded: number;
}

interface ChurnRow {
  day: string;
  chunks: number;
  embedded: number;
}

/** A backend that can answer aggregate SQL. Both concrete backends can. */
interface Queryable {
  backendType: "sqlite" | "postgres";
  getPool?: () => { query: (sql: string) => Promise<{ rows: unknown[] }> };
  getSqliteDb?: () => { prepare: (sql: string) => { all: () => unknown[] } };
}

/**
 * Run one aggregate query against whichever backend is configured.
 *
 * The two dialects differ only in the epoch conversion, so the SQL is passed in
 * per-dialect rather than abstracted — an abstraction over four reporting
 * queries would cost more than it saves.
 */
async function queryRows(
  backend: Queryable,
  pgSql: string,
  sqliteSql: string
): Promise<Record<string, unknown>[]> {
  if (backend.backendType === "postgres" && backend.getPool) {
    const res = await backend.getPool().query(pgSql);
    return res.rows as Record<string, unknown>[];
  }
  if (backend.getSqliteDb) {
    return backend.getSqliteDb().prepare(sqliteSql).all() as Record<string, unknown>[];
  }
  return [];
}

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
  const q = backend as unknown as Queryable;
  const limit = opts.limit ?? 8;

  // ---- composition -------------------------------------------------------
  const comp = (await queryRows(
    q,
    `SELECT source, tier, COUNT(*) AS chunks, COUNT(embedding) AS embedded
       FROM pai_chunks GROUP BY source, tier ORDER BY COUNT(*) DESC`,
    `SELECT source, tier, COUNT(*) AS chunks,
            SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM memory_chunks GROUP BY source, tier ORDER BY COUNT(*) DESC`
  )) as Array<{ source: string; tier: string; chunks: unknown; embedded: unknown }>;

  if (comp.length === 0) {
    console.log();
    console.log(warn(`  Nothing indexed yet, or the backend is unreachable.`));
    console.log(dim(`  Backend: ${q.backendType}`));
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
      dim(`backend: ${q.backendType}`)
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
  const paths = (await queryRows(
    q,
    `SELECT path, COUNT(*) AS chunks FROM pai_chunks GROUP BY path`,
    `SELECT path, COUNT(*) AS chunks FROM memory_chunks GROUP BY path`
  )) as Array<{ path: string; chunks: unknown }>;

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
  const churn = (await queryRows(
    q,
    `SELECT to_char(to_timestamp(updated_at/1000),'YYYY-MM-DD') AS day,
            COUNT(*) AS chunks, COUNT(embedding) AS embedded
       FROM pai_chunks GROUP BY day ORDER BY day DESC LIMIT 10`,
    `SELECT date(updated_at/1000,'unixepoch') AS day, COUNT(*) AS chunks,
            SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM memory_chunks GROUP BY day ORDER BY day DESC LIMIT 10`
  )) as unknown as ChurnRow[];

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

