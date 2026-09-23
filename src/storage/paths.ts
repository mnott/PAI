/**
 * storage/paths.ts — the on-disk *.db path resolvers, re-exported from the
 * SQLite openers (src/storage/sqlite/federation-db.ts, registry-db.ts) so
 * that everything outside src/storage/ (config/pai-files.ts,
 * cli/commands/backup.ts, restore.ts, config.ts, workers/project-config.ts,
 * ...) can learn *where* the SQLite files live without importing
 * better-sqlite3 or openFederation/openRegistry directly — those imports are
 * what the boundary test (design doc §7) forbids outside src/storage/.
 */

export { federationDbPath, oldFederationPath } from "./sqlite/federation-db.js";
export { registryDbPath, oldRegistryPath } from "./sqlite/registry-db.js";

import { join } from "node:path";
import { homedir } from "node:os";
import { paiHomePath, migratePaiFile, type MigrateFileResult } from "../config/pai-home.js";

/**
 * The orphaned ~/.config/pai/federation.db (a 0-byte leftover — the live
 * federation DB has lived at ~/.pai/federation.db since the Postgres
 * migration, nothing in src/ reads this copy). Lives here rather than in
 * config/pai-files.ts so that file stays free of *.db path literals.
 */
export function oldOrphanFederationDbPath(): string {
  return join(homedir(), ".config", "pai", "federation.db");
}

export function migrateOrphanFederationDb(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath("federation.db"), [oldOrphanFederationDbPath()], opts);
}
