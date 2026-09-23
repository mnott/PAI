/**
 * Proof for docs/design/postgres-only.md unit 8: `runSessionStopHook` /
 * `runPreCompactHook` reproduce the effects of the old sqlite3-CLI SQL in
 * src/hooks/session-stop.sh and src/hooks/pre-compact.sh, against both a
 * temp SQLite file and a scratch Postgres database (never the real ones).
 *
 * Old SQL, session-stop.sh:
 *   SELECT id FROM projects WHERE slug = ? LIMIT 1
 *   SELECT id FROM sessions WHERE project_id = ? AND status IN ('open','compacted')
 *     ORDER BY created_at DESC LIMIT 1
 *   UPDATE sessions SET status = 'completed', closed_at = <now ms> WHERE id = ?
 *
 * Old SQL, pre-compact.sh:
 *   SELECT id FROM projects WHERE slug = ? LIMIT 1
 *   SELECT id FROM sessions WHERE project_id = ? AND status = 'open'
 *     ORDER BY created_at DESC LIMIT 1
 *   UPDATE sessions SET status = 'compacted' WHERE id = ?              (if a session matched)
 *   INSERT INTO compaction_log (project_id, session_id, trigger, files_written, created_at)
 *     VALUES (?, ?, 'precompact', '', <now ms>)                        (session_id NULL if none matched)
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import pg from "pg";
import type { Pool as PgPool } from "pg";
import { initializeSchema } from "../../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../../storage/registry-sqlite.js";
import { PostgresRegistryBackend } from "../../storage/registry-postgres.js";
import { PostgresBackend } from "../../storage/postgres/backend.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";
import { loadConfig } from "../../daemon/config.js";
import { runSessionStopHook, runPreCompactHook } from "./hooks-db.js";

const { Pool } = pg;

interface Fixture {
  backend: RegistryBackend;
  cleanup: () => Promise<void>;
}

async function sqliteFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "pai-hooks-db-"));
  const db = new DatabaseCtor(join(dir, "registry.db"));
  initializeSchema(db);
  return {
    backend: new SQLiteRegistryBackend(db),
    cleanup: async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postgresFixture(): Promise<Fixture | null> {
  const base = loadConfig().postgres?.connectionString;
  if (!base) return null;

  const dbName = `pai_test_hooksdb_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";

  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  const pool = new Pool({ connectionString: scratch.toString(), max: 1 });
  try {
    const { readFileSync } = await import("node:fs");
    const initSql = readFileSync(new URL("../../../docker/init.sql", import.meta.url), "utf-8");
    await pool.query(initSql);
    const runMigrations = (PostgresBackend as unknown as { runMigrations(p: PgPool): Promise<void> })
      .runMigrations;
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  const backend = new PostgresRegistryBackend({ connectionString: scratch.toString() });
  return {
    backend,
    cleanup: async () => {
      try {
        await backend.close();
      } catch {
        // ignore
      }
      const admin2 = new Pool({ connectionString: admin.toString(), max: 1 });
      try {
        await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin2.end();
      }
    },
  };
}

async function seedProjectAndSession(
  backend: RegistryBackend,
  opts: { slug: string; sessionStatus: "open" | "completed" | "compacted"; createdAt: number }
): Promise<{ projectId: number; sessionId: number }> {
  const project = await backend.createProject({
    slug: opts.slug,
    displayName: opts.slug,
    rootPath: `/tmp/${opts.slug}`,
    encodedDir: `-tmp-${opts.slug}`,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
  const session = await backend.createSession({
    projectId: project.id,
    number: 1,
    date: "2026-09-22",
    slug: "s1",
    title: "S1",
    filename: "0001.md",
    status: opts.sessionStatus,
    createdAt: opts.createdAt,
  });
  return { projectId: project.id, sessionId: session.id };
}

for (const [label, makeFixture] of [
  ["sqlite", sqliteFixture],
  ["postgres", postgresFixture],
] as const) {
  describe(`hooks-db (${label})`, () => {
    let fixture: Fixture | null = null;

    afterEach(async () => {
      if (fixture) await fixture.cleanup();
      fixture = null;
    });

    async function getBackend(): Promise<RegistryBackend | null> {
      fixture = await makeFixture();
      return fixture?.backend ?? null;
    }

    it("session-stop: marks the latest open/compacted session completed and sets closed_at", async () => {
      const backend = await getBackend();
      if (!backend) return; // postgres not configured in this environment
      const { sessionId } = await seedProjectAndSession(backend, {
        slug: "proj-a",
        sessionStatus: "open",
        createdAt: 1000,
      });

      await runSessionStopHook(backend, "proj-a");

      const row = await backend.getSessionById(sessionId);
      expect(row?.status).toBe("completed");
      expect(row?.closed_at).toBeGreaterThan(0);
    });

    it("session-stop: also completes a 'compacted' session (status IN ('open','compacted'))", async () => {
      const backend = await getBackend();
      if (!backend) return;
      const { sessionId } = await seedProjectAndSession(backend, {
        slug: "proj-b",
        sessionStatus: "compacted",
        createdAt: 1000,
      });

      await runSessionStopHook(backend, "proj-b");

      const row = await backend.getSessionById(sessionId);
      expect(row?.status).toBe("completed");
    });

    it("session-stop: no matching project or no open/compacted session is a silent no-op", async () => {
      const backend = await getBackend();
      if (!backend) return;
      await expect(runSessionStopHook(backend, "does-not-exist")).resolves.toBeUndefined();

      const { sessionId } = await seedProjectAndSession(backend, {
        slug: "proj-c",
        sessionStatus: "completed",
        createdAt: 1000,
      });
      await runSessionStopHook(backend, "proj-c");
      const row = await backend.getSessionById(sessionId);
      expect(row?.status).toBe("completed"); // unchanged, no open/compacted session existed
    });

    it("pre-compact: marks the latest open session compacted and appends a compaction_log row", async () => {
      const backend = await getBackend();
      if (!backend) return;
      const { projectId, sessionId } = await seedProjectAndSession(backend, {
        slug: "proj-d",
        sessionStatus: "open",
        createdAt: 1000,
      });

      await runPreCompactHook(backend, "proj-d");

      const row = await backend.getSessionById(sessionId);
      expect(row?.status).toBe("compacted");
      expect(await backend.countCompactionLogsForProject(projectId)).toBe(1);
    });

    it("pre-compact: still logs (with a null session_id) when no open session exists", async () => {
      const backend = await getBackend();
      if (!backend) return;
      const { projectId } = await seedProjectAndSession(backend, {
        slug: "proj-e",
        sessionStatus: "completed",
        createdAt: 1000,
      });

      await runPreCompactHook(backend, "proj-e");

      expect(await backend.countCompactionLogsForProject(projectId)).toBe(1);
    });

    it("pre-compact: unknown project slug is a silent no-op", async () => {
      const backend = await getBackend();
      if (!backend) return;
      await expect(runPreCompactHook(backend, "does-not-exist")).resolves.toBeUndefined();
    });
  });
}
