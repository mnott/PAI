import { describe, it, expect } from "vitest";
import pg from "pg";
import { loadConfig } from "../../daemon/config.js";
import { storeObservation, querySessionObservations, __resetTablesEnsured } from "./observations.js";

/**
 * Provenance columns on pai_observations: the schema DDL plus the
 * source/fidelity migration live in this module (ensureObservationTables).
 * Running the ensure path twice on a scratch database must not throw and must
 * leave exactly one of each column — the idempotency proof, in the style of
 * kg-and-registry-ddl.test.ts.
 *
 * Runs against a scratch database on the same Postgres server as configured
 * PAI, created and dropped here — never touches the real database.
 */

const { Pool } = pg;

function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
  const base = loadConfig().postgres?.connectionString;
  if (!base) {
    throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
  }
  const dbName = `pai_test_obsprov_${Math.random().toString(36).slice(2, 10)}`;
  const scratch = new URL(base);
  scratch.pathname = `/${dbName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
}

describe("pai_observations provenance columns (source/fidelity)", () => {
  it("creates source + fidelity, idempotently across two ensure passes", async () => {
    const { scratchUrl, adminUrl, dbName } = scratchTargets();

    try {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }

      const pool = new Pool({ connectionString: scratchUrl, max: 1 });
      try {
        // Pass 1: fresh database — DDL + migration create the columns.
        await storeObservation(pool, {
          session_id: "s1", type: "change", title: "t", tool_name: "Bash",
          files_read: [], files_modified: [], concepts: [],
          source: "hook", fidelity: "observed",
        });
        // Pass 2: force the ensure path to run again on the migrated database
        // (reset the module flag) — must not throw, must not duplicate columns.
        __resetTablesEnsured();
        await storeObservation(pool, {
          session_id: "s2", type: "change", title: "t2", tool_name: "Bash",
          files_read: [], files_modified: [], concepts: [],
          source: "daemon", fidelity: "inferred",
        });

        const cols = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'pai_observations' AND column_name IN ('source', 'fidelity')`
        );
        expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["fidelity", "source"]);
        // No duplication: exactly one row per column name.
        for (const name of ["source", "fidelity"]) {
          expect(cols.rows.filter((r) => r.column_name === name)).toHaveLength(1);
        }

        // Writers pass the provenance values through, and reads carry them back.
        const rows = await querySessionObservations(pool, "s1");
        expect(rows[0]?.source).toBe("hook");
        expect(rows[0]?.fidelity).toBe("observed");
        const rows2 = await querySessionObservations(pool, "s2");
        expect(rows2[0]?.source).toBe("daemon");
        expect(rows2[0]?.fidelity).toBe("inferred");
      } finally {
        await pool.end();
      }
    } finally {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin.end();
      }
    }
  }, 30000);
});
