/**
 * merge.ts — pure types and error class shared by the merge implementations.
 *
 * The actual SQLite implementation (planMerge/applyMerge, taking a raw
 * better-sqlite3 Database) lives in src/storage/sqlite/registry-merge.ts —
 * moved there so nothing outside src/storage/ imports better-sqlite3. The
 * Postgres implementation lives in src/storage/registry-postgres.ts. Both are
 * reached through RegistryBackend.planProjectMerge/applyProjectMerge
 * (src/storage/registry-interface.ts), never directly.
 *
 * See src/storage/sqlite/registry-merge.ts for the "why one function" design
 * rationale (five tables reference a project, foreign_keys is off).
 */

export interface MergePlan {
  fromId: number;
  fromSlug: string;
  intoId: number;
  intoSlug: string;
  /** Sessions to move, with the numbers they will be given. */
  sessions: { id: number; from: number; to: number }[];
  tags: number;
  aliases: number;
  compactions: number;
  links: number;
  /** The losing slug is kept as an alias, so `pai <old-name>` still resolves. */
  aliasToAdd?: string;
}

export class MergeError extends Error {}
