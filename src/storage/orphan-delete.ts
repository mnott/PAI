/**
 * orphan-delete.ts — the `repair-orphans --delete` engine.
 *
 * Orphans (project_id not in `projects`) are deletable when a vectored twin
 * exists under a current project: by path for ids a projects_backup_* table maps
 * to a current project, by hash for ids nothing maps (the live table was wiped
 * before any backup existed, 2026-10-24: 2.79M stale copies, a 15-minute
 * correlated COUNT). `includeStale` also takes the unmapped rows without twin.
 * Every execute first writes the doomed rows to <PAI home>/backups and checks the
 * row counts; a mismatch aborts before any DELETE. Deletes run in batches per old
 * project id, so there is no huge transaction.
 */

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { join } from "node:path";
import type { Pool } from "pg";

type Table = "pai_chunks" | "pai_files";
type Querier = Pick<Pool, "query">;

/** Rows of one old project id that are to be deleted from one table. */
export interface DeleteTarget {
  oldId: number;
  table: Table;
  /** WHERE clause using `$1..$n` of `args`, columns unqualified or qualified by the table name. */
  where: string;
  args: unknown[];
  /** Rows expected to match, from the planning counts. */
  expected: number;
}

export interface DeleteOutcome {
  /** Rows deleted per target, in the order of the targets given. */
  deleted: number[];
  /** Backup files written (execute only). */
  backups: string[];
}

export interface DeleteOpts {
  dryRun: boolean;
  backupDir: string;
  /** Timestamp used in the backup file names. */
  ts: number;
  batchSize?: number;
  log?: (msg: string) => void;
}

const BATCH = 10_000;
const PAGE = 2_000;

/** A current (registered) project id. */
const CURRENT = "SELECT id FROM projects";

/** Twin of an unmapped chunk: same hash, vectored, under a current project (idx_pc_hash_embedded). */
export const CHUNK_HASH_TWIN =
  `EXISTS (SELECT 1 FROM pai_chunks t WHERE t.hash = pai_chunks.hash AND t.embedding IS NOT NULL AND t.project_id IN (${CURRENT}))`;
/** Twin of an unmapped file: same hash under a current project (uncorrelated, hashed once per statement). */
export const FILE_HASH_TWIN = `hash IN (SELECT hash FROM pai_files WHERE project_id IN (${CURRENT}))`;

/**
 * Per old id, how many chunks/files have a hash twin under a current project.
 * One hash join per table instead of a correlated subquery per row.
 */
export async function countHashTwins(
  pool: Querier,
  ids: number[]
): Promise<{ chunks: Map<number, number>; files: Map<number, number> }> {
  const out = { chunks: new Map<number, number>(), files: new Map<number, number>() };
  if (ids.length === 0) return out;
  const chunks = await pool.query(
    `SELECT c.project_id, COUNT(*) AS n FROM pai_chunks c
       JOIN (SELECT DISTINCT hash FROM pai_chunks WHERE embedding IS NOT NULL AND project_id IN (${CURRENT})) t ON t.hash = c.hash
      WHERE c.project_id = ANY($1::int[]) GROUP BY c.project_id`,
    [ids]
  );
  for (const r of chunks.rows) out.chunks.set(Number(r.project_id), Number(r.n));
  const files = await pool.query(
    `SELECT f.project_id, COUNT(*) AS n FROM pai_files f
       JOIN (SELECT DISTINCT hash FROM pai_files WHERE project_id IN (${CURRENT})) t ON t.hash = f.hash
      WHERE f.project_id = ANY($1::int[]) GROUP BY f.project_id`,
    [ids]
  );
  for (const r of files.rows) out.files.set(Number(r.project_id), Number(r.n));
  return out;
}

function tag(t: Table): string {
  return t === "pai_chunks" ? "chunks" : "files";
}

/** Writes every target's rows to <backupDir>/orphans-<ts>-{chunks,files}.copy.gz (one JSON row per line). */
async function writeBackups(pool: Querier, targets: DeleteTarget[], opts: DeleteOpts): Promise<Map<Table, { file: string; rows: number }>> {
  mkdirSync(opts.backupDir, { recursive: true });
  const result = new Map<Table, { file: string; rows: number }>();
  for (const table of ["pai_chunks", "pai_files"] as Table[]) {
    const file = join(opts.backupDir, `orphans-${opts.ts}-${tag(table)}.copy.gz`);
    const gz = createGzip();
    const out = createWriteStream(file);
    gz.pipe(out);
    const key = table === "pai_chunks" ? "id" : "path";
    let rows = 0;
    for (const t of targets.filter((x) => x.table === table)) {
      let last = "";
      for (;;) {
        const n = t.args.length;
        const page = await pool.query(
          `SELECT ${key} AS k, row_to_json(${table})::text AS j FROM ${table}
            WHERE (${t.where}) AND ${key} > $${n + 1} ORDER BY ${key} LIMIT ${PAGE}`,
          [...t.args, last]
        );
        for (const r of page.rows) {
          if (!gz.write(`${r.j}\n`)) await once(gz, "drain");
          rows++;
        }
        if (page.rows.length < PAGE) break;
        last = page.rows[page.rows.length - 1].k;
      }
    }
    gz.end();
    await once(out, "finish");
    result.set(table, { file, rows });
  }
  return result;
}

async function countLines(file: string): Promise<number> {
  let n = 0;
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.length > 0) n++;
  return n;
}

/** Back up the rows, then check the written files hold exactly the planned counts. Throws on any difference. */
export async function backupAndVerify(pool: Querier, targets: DeleteTarget[], opts: DeleteOpts): Promise<string[]> {
  const written = await writeBackups(pool, targets, opts);
  for (const [table, { file, rows }] of written) {
    const expected = targets.filter((t) => t.table === table).reduce((s, t) => s + t.expected, 0);
    const onDisk = await countLines(file);
    if (rows !== expected || onDisk !== rows) {
      throw new Error(
        `orphan backup of ${table} does not match: planned ${expected} rows, read ${rows}, file holds ${onDisk} (${file}); nothing deleted`
      );
    }
    opts.log?.(`backup ${file}: ${rows} ${tag(table)} verified`);
  }
  return [...written.values()].map((w) => w.file);
}

/** Delete one target in batches (by ctid, so no huge transaction); returns rows deleted. */
async function deleteTarget(pool: Querier, t: DeleteTarget, opts: DeleteOpts): Promise<number> {
  const size = opts.batchSize ?? BATCH;
  const n = t.args.length;
  let total = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM ${t.table} WHERE ctid IN (SELECT ctid FROM ${t.table} WHERE ${t.where} LIMIT $${n + 1})`,
      [...t.args, size]
    );
    const got = r.rowCount ?? 0;
    total += got;
    if (got > 0) opts.log?.(`project ${t.oldId}: deleted ${total}/${t.expected} ${tag(t.table)}`);
    if (got < size) return total;
  }
}

/** Back up, then delete, every target. A dry run only reports what the targets expect. */
export async function runDelete(pool: Querier, targets: DeleteTarget[], opts: DeleteOpts): Promise<DeleteOutcome> {
  if (opts.dryRun) return { deleted: targets.map((t) => t.expected), backups: [] };
  const backups = await backupAndVerify(pool, targets, opts);
  const deleted: number[] = [];
  for (const t of targets) deleted.push(await deleteTarget(pool, t, opts));
  return { deleted, backups };
}
