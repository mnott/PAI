/**
 * Vault storage operations for the Postgres backend.
 * All functions take a `pool` parameter — called from PostgresBackend methods.
 */

import type { Pool } from "pg";
import type {
  VaultFileRow, VaultAliasRow, VaultLinkRow, VaultHealthRow, VaultNameEntry,
} from "../interface.js";

// ---------------------------------------------------------------------------
// Vault files
// ---------------------------------------------------------------------------

export async function upsertVaultFile(pool: Pool, file: VaultFileRow): Promise<void> {
  await pool.query(
    `INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (vault_path) DO UPDATE SET
       inode = EXCLUDED.inode, device = EXCLUDED.device,
       hash = EXCLUDED.hash, title = EXCLUDED.title,
       indexed_at = EXCLUDED.indexed_at`,
    [file.vaultPath, file.inode, file.device, file.hash, file.title, file.indexedAt]
  );
}

export async function deleteVaultFile(pool: Pool, vaultPath: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM vault_links WHERE source_path = $1", [vaultPath]);
    await client.query("DELETE FROM vault_health WHERE vault_path = $1", [vaultPath]);
    await client.query("DELETE FROM vault_name_index WHERE vault_path = $1", [vaultPath]);
    await client.query("DELETE FROM vault_aliases WHERE vault_path = $1 OR canonical_path = $1", [vaultPath]);
    await client.query("DELETE FROM vault_files WHERE vault_path = $1", [vaultPath]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

type VaultFileDbRow = { vault_path: string; inode: string; device: string; hash: string; title: string | null; indexed_at: string };

function mapVaultFileRow(row: VaultFileDbRow): VaultFileRow {
  return {
    vaultPath: row.vault_path,
    inode: Number(row.inode),
    device: Number(row.device),
    hash: row.hash,
    title: row.title,
    indexedAt: Number(row.indexed_at),
  };
}

export async function getVaultFile(pool: Pool, vaultPath: string): Promise<VaultFileRow | null> {
  const r = await pool.query<VaultFileDbRow>(
    "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE vault_path = $1",
    [vaultPath]
  );
  return r.rows.length === 0 ? null : mapVaultFileRow(r.rows[0]);
}

export async function getVaultFileByInode(pool: Pool, inode: number, device: number): Promise<VaultFileRow | null> {
  const r = await pool.query<VaultFileDbRow>(
    "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE inode = $1 AND device = $2 LIMIT 1",
    [inode, device]
  );
  return r.rows.length === 0 ? null : mapVaultFileRow(r.rows[0]);
}

export async function getAllVaultFiles(pool: Pool): Promise<VaultFileRow[]> {
  const r = await pool.query<VaultFileDbRow>("SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files");
  return r.rows.map(mapVaultFileRow);
}

export async function getRecentVaultFiles(pool: Pool, sinceMs: number): Promise<VaultFileRow[]> {
  const r = await pool.query<VaultFileDbRow>(
    "SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE indexed_at > $1",
    [sinceMs]
  );
  return r.rows.map(mapVaultFileRow);
}

export async function countVaultFiles(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM vault_files");
  return parseInt(r.rows[0]?.n ?? "0", 10);
}

export async function countVaultFilesWithPrefix(pool: Pool, prefix: string): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM vault_files WHERE vault_path LIKE $1", [`${prefix}%`]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function countVaultFilesAfter(pool: Pool, sinceMs: number): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM vault_files WHERE indexed_at > $1", [sinceMs]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function getVaultFilesByPaths(pool: Pool, paths: string[]): Promise<VaultFileRow[]> {
  if (paths.length === 0) return [];
  const placeholders = paths.map((_, i) => `$${i + 1}`).join(", ");
  const r = await pool.query<VaultFileDbRow>(
    `SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE vault_path IN (${placeholders})`,
    paths
  );
  return r.rows.map(mapVaultFileRow);
}

export async function getVaultFilesByPathsAfter(pool: Pool, paths: string[], sinceMs: number): Promise<VaultFileRow[]> {
  if (paths.length === 0) return [];
  const placeholders = paths.map((_, i) => `$${i + 1}`).join(", ");
  const r = await pool.query<VaultFileDbRow>(
    `SELECT vault_path, inode, device, hash, title, indexed_at FROM vault_files WHERE vault_path IN (${placeholders}) AND indexed_at >= $${paths.length + 1} ORDER BY indexed_at ASC`,
    [...paths, sinceMs]
  );
  return r.rows.map(mapVaultFileRow);
}

export async function getAllVaultFilePaths(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>("SELECT vault_path FROM vault_files");
  return r.rows.map(row => row.vault_path);
}

export async function getVaultFilePathsWithPrefix(pool: Pool, prefix: string): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vault_path FROM vault_files WHERE vault_path LIKE $1",
    [`${prefix}%`]
  );
  return r.rows.map(row => row.vault_path);
}

export async function getVaultFilePathsAfter(pool: Pool, sinceMs: number): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vault_path FROM vault_files WHERE indexed_at > $1",
    [sinceMs]
  );
  return r.rows.map(row => row.vault_path);
}

// ---------------------------------------------------------------------------
// Vault aliases
// ---------------------------------------------------------------------------

export async function upsertVaultAliases(pool: Pool, aliases: VaultAliasRow[]): Promise<void> {
  if (aliases.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const a of aliases) {
      await client.query(
        `INSERT INTO vault_aliases (vault_path, canonical_path, inode, device)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault_path) DO UPDATE SET
           canonical_path = EXCLUDED.canonical_path,
           inode = EXCLUDED.inode, device = EXCLUDED.device`,
        [a.vaultPath, a.canonicalPath, a.inode, a.device]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteVaultAliases(pool: Pool, canonicalPath: string): Promise<void> {
  await pool.query("DELETE FROM vault_aliases WHERE canonical_path = $1", [canonicalPath]);
}

export async function getVaultAlias(pool: Pool, vaultPath: string): Promise<{ canonicalPath: string } | null> {
  const r = await pool.query<{ canonical_path: string }>(
    "SELECT canonical_path FROM vault_aliases WHERE vault_path = $1",
    [vaultPath]
  );
  return r.rows.length > 0 ? { canonicalPath: r.rows[0].canonical_path } : null;
}

// ---------------------------------------------------------------------------
// Vault links
// ---------------------------------------------------------------------------

type VaultLinkDbRow = { source_path: string; target_raw: string; target_path: string | null; link_type: string; line_number: number };

function mapVaultLinkRow(row: VaultLinkDbRow): VaultLinkRow {
  return {
    sourcePath: row.source_path,
    targetRaw: row.target_raw,
    targetPath: row.target_path,
    linkType: row.link_type,
    lineNumber: row.line_number,
  };
}

export async function replaceLinksForSources(pool: Pool, sourcePaths: string[], links: VaultLinkRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (sourcePaths.length > 0) {
      await client.query(
        "DELETE FROM vault_links WHERE source_path = ANY($1::text[])",
        [sourcePaths]
      );
    }
    for (let i = 0; i < links.length; i += 500) {
      const batch = links.slice(i, i + 500);
      const values: string[] = [];
      const params: (string | number | null)[] = [];
      let idx = 1;
      for (const l of batch) {
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        params.push(l.sourcePath, l.targetRaw, l.targetPath, l.linkType, l.lineNumber);
      }
      await client.query(
        `INSERT INTO vault_links (source_path, target_raw, target_path, link_type, line_number)
         VALUES ${values.join(", ")}
         ON CONFLICT (source_path, target_raw, line_number) DO UPDATE SET
           target_path = EXCLUDED.target_path, link_type = EXCLUDED.link_type`,
        params
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getLinksFromSource(pool: Pool, sourcePath: string): Promise<VaultLinkRow[]> {
  const r = await pool.query<VaultLinkDbRow>(
    "SELECT source_path, target_raw, target_path, link_type, line_number FROM vault_links WHERE source_path = $1",
    [sourcePath]
  );
  return r.rows.map(mapVaultLinkRow);
}

export async function getLinksToTarget(pool: Pool, targetPath: string): Promise<VaultLinkRow[]> {
  const r = await pool.query<VaultLinkDbRow>(
    "SELECT source_path, target_raw, target_path, link_type, line_number FROM vault_links WHERE target_path = $1",
    [targetPath]
  );
  return r.rows.map(mapVaultLinkRow);
}

export async function getVaultLinkGraph(pool: Pool): Promise<Array<{ source_path: string; target_path: string }>> {
  const r = await pool.query<{ source_path: string; target_path: string }>(
    "SELECT source_path, target_path FROM vault_links WHERE target_path IS NOT NULL"
  );
  return r.rows;
}

export async function getDeadLinks(pool: Pool): Promise<Array<{ sourcePath: string; targetRaw: string }>> {
  const r = await pool.query<{ source_path: string; target_raw: string }>(
    "SELECT source_path, target_raw FROM vault_links WHERE target_path IS NULL"
  );
  return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw }));
}

export async function getDeadLinksWithLineNumbers(pool: Pool): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> {
  const r = await pool.query<{ source_path: string; target_raw: string; line_number: number }>(
    "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL"
  );
  return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw, lineNumber: row.line_number }));
}

export async function getDeadLinksWithPrefix(pool: Pool, prefix: string): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> {
  const r = await pool.query<{ source_path: string; target_raw: string; line_number: number }>(
    "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL AND source_path LIKE $1",
    [`${prefix}%`]
  );
  return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw, lineNumber: row.line_number }));
}

export async function getDeadLinksAfter(pool: Pool, sinceMs: number): Promise<Array<{ sourcePath: string; targetRaw: string; lineNumber: number }>> {
  const r = await pool.query<{ source_path: string; target_raw: string; line_number: number }>(
    "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL AND source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > $1)",
    [sinceMs]
  );
  return r.rows.map(row => ({ sourcePath: row.source_path, targetRaw: row.target_raw, lineNumber: row.line_number }));
}

export async function countVaultLinksWithPrefix(pool: Pool, prefix: string): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM vault_links WHERE source_path LIKE $1", [`${prefix}%`]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function countVaultLinksAfter(pool: Pool, sinceMs: number): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM vault_links WHERE source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > $1)",
    [sinceMs]
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function getVaultLinksFromPaths(pool: Pool, sourcePaths: string[]): Promise<VaultLinkRow[]> {
  if (sourcePaths.length === 0) return [];
  const placeholders = sourcePaths.map((_, i) => `$${i + 1}`).join(", ");
  const r = await pool.query<VaultLinkDbRow>(
    `SELECT source_path, target_raw, target_path, link_type, line_number FROM vault_links WHERE source_path IN (${placeholders}) AND target_path IS NOT NULL`,
    sourcePaths
  );
  return r.rows.map(mapVaultLinkRow);
}

export async function getVaultLinkEdges(pool: Pool): Promise<Array<{ source: string; target: string }>> {
  const r = await pool.query<{ source: string; target: string }>(
    "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL"
  );
  return r.rows;
}

export async function getVaultLinkEdgesWithPrefix(pool: Pool, prefix: string): Promise<Array<{ source: string; target: string }>> {
  const r = await pool.query<{ source: string; target: string }>(
    "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL AND source_path LIKE $1",
    [`${prefix}%`]
  );
  return r.rows;
}

export async function getVaultLinkEdgesAfter(pool: Pool, sinceMs: number): Promise<Array<{ source: string; target: string }>> {
  const r = await pool.query<{ source: string; target: string }>(
    "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL AND source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > $1)",
    [sinceMs]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Vault health
// ---------------------------------------------------------------------------

type VaultHealthDbRow = { vault_path: string; inbound_count: number; outbound_count: number; dead_link_count: number; is_orphan: number; computed_at: string };

function mapVaultHealthRow(row: VaultHealthDbRow): VaultHealthRow {
  return {
    vaultPath: row.vault_path,
    inboundCount: row.inbound_count,
    outboundCount: row.outbound_count,
    deadLinkCount: row.dead_link_count,
    isOrphan: row.is_orphan === 1,
    computedAt: Number(row.computed_at),
  };
}

export async function upsertVaultHealth(pool: Pool, rows: VaultHealthRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const h of rows) {
      await client.query(
        `INSERT INTO vault_health (vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vault_path) DO UPDATE SET
           inbound_count = EXCLUDED.inbound_count,
           outbound_count = EXCLUDED.outbound_count,
           dead_link_count = EXCLUDED.dead_link_count,
           is_orphan = EXCLUDED.is_orphan,
           computed_at = EXCLUDED.computed_at`,
        [h.vaultPath, h.inboundCount, h.outboundCount, h.deadLinkCount, h.isOrphan ? 1 : 0, h.computedAt]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getVaultHealth(pool: Pool, vaultPath: string): Promise<VaultHealthRow | null> {
  const r = await pool.query<VaultHealthDbRow>(
    "SELECT vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at FROM vault_health WHERE vault_path = $1",
    [vaultPath]
  );
  return r.rows.length === 0 ? null : mapVaultHealthRow(r.rows[0]);
}

export async function getOrphans(pool: Pool): Promise<VaultHealthRow[]> {
  const r = await pool.query<VaultHealthDbRow>(
    "SELECT vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at FROM vault_health WHERE is_orphan = 1"
  );
  return r.rows.map(row => ({ ...mapVaultHealthRow(row), isOrphan: true }));
}

export async function getOrphansWithPrefix(pool: Pool, prefix: string): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vault_path FROM vault_health WHERE is_orphan = 1 AND vault_path LIKE $1",
    [`${prefix}%`]
  );
  return r.rows.map(row => row.vault_path);
}

export async function getOrphansAfter(pool: Pool, sinceMs: number): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vh.vault_path FROM vault_health vh JOIN vault_files vf ON vh.vault_path = vf.vault_path WHERE vh.is_orphan = 1 AND vf.indexed_at > $1",
    [sinceMs]
  );
  return r.rows.map(row => row.vault_path);
}

export async function getLowConnectivity(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vault_path FROM vault_health WHERE inbound_count + outbound_count <= 1"
  );
  return r.rows.map(row => row.vault_path);
}

export async function getLowConnectivityWithPrefix(pool: Pool, prefix: string): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vault_path FROM vault_health WHERE inbound_count + outbound_count <= 1 AND vault_path LIKE $1",
    [`${prefix}%`]
  );
  return r.rows.map(row => row.vault_path);
}

export async function getLowConnectivityAfter(pool: Pool, sinceMs: number): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vh.vault_path FROM vault_health vh JOIN vault_files vf ON vh.vault_path = vf.vault_path WHERE vh.inbound_count + vh.outbound_count <= 1 AND vf.indexed_at > $1",
    [sinceMs]
  );
  return r.rows.map(row => row.vault_path);
}

// ---------------------------------------------------------------------------
// Vault name index
// ---------------------------------------------------------------------------

export async function upsertNameIndex(pool: Pool, entries: VaultNameEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      await client.query(
        `INSERT INTO vault_name_index (name, vault_path)
         VALUES ($1, $2) ON CONFLICT (name, vault_path) DO NOTHING`,
        [e.name, e.vaultPath]
      );
    }
    await client.query("COMMIT");
  } catch (e_) {
    await client.query("ROLLBACK");
    throw e_;
  } finally {
    client.release();
  }
}

export async function replaceNameIndex(pool: Pool, entries: VaultNameEntry[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM vault_name_index");
    for (let i = 0; i < entries.length; i += 500) {
      const batch = entries.slice(i, i + 500);
      const values: string[] = [];
      const params: string[] = [];
      let idx = 1;
      for (const e of batch) {
        values.push(`($${idx++}, $${idx++})`);
        params.push(e.name, e.vaultPath);
      }
      await client.query(
        `INSERT INTO vault_name_index (name, vault_path) VALUES ${values.join(", ")}`,
        params
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function resolveVaultName(pool: Pool, name: string): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT vault_path FROM vault_name_index WHERE name = $1",
    [name]
  );
  return r.rows.map(row => row.vault_path);
}

export async function searchVaultNameIndex(pool: Pool, query: string, limit = 100): Promise<string[]> {
  const r = await pool.query<{ vault_path: string }>(
    "SELECT DISTINCT vault_path FROM vault_name_index WHERE lower(name) LIKE lower($1) LIMIT $2",
    [`%${query}%`, limit]
  );
  return r.rows.map(row => row.vault_path);
}
