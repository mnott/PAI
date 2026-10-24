/**
 * Postgres file-path bookkeeping (pai_files / pai_chunks): counting and
 * renaming paths after session cleanup moves Notes/*.md into YYYY/MM/.
 * Delegated from PostgresBackend.
 */

import type { Pool } from "pg";

export async function countFilesWithPaths(pool: Pool, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const result = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM pai_files WHERE path = ANY($1)",
    [paths]
  );
  return parseInt(result.rows[0]?.n ?? "0", 10);
}

export async function renameFilePaths(
  pool: Pool,
  moves: Array<{ oldPath: string; newPath: string }>
): Promise<number> {
  if (moves.length === 0) return 0;
  const client = await pool.connect();
  let filesUpdated = 0;
  try {
    await client.query("BEGIN");
    for (const { oldPath, newPath } of moves) {
      const r = await client.query("UPDATE pai_files SET path = $1 WHERE path = $2", [newPath, oldPath]);
      filesUpdated += r.rowCount ?? 0;
      await client.query("UPDATE pai_chunks SET path = $1 WHERE path = $2", [newPath, oldPath]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return filesUpdated;
}
