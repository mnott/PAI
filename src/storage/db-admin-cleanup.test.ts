import { describe, it, expect, afterAll } from "vitest";
import { loadConfig } from "../daemon/config.js";
import { cleanupTestDatabases, pgAdminUrl } from "./db-admin.js";
import { createScratchDatabase, type ScratchDb } from "./test-db.js";

const conn = loadConfig().postgres?.connectionString;
const made: ScratchDb[] = [];

describe.skipIf(!conn)("cleanupTestDatabases (real Postgres SQL)", () => {
  afterAll(async () => { for (const d of made) await d.cleanup(); });

  it("lists scratch databases on dry run and drops them with age 0", async () => {
    const a = await createScratchDatabase("cleanupx");
    const b = await createScratchDatabase("cleanupx");
    made.push(a, b);
    for (const d of [a, b]) await d.pool.query("CREATE TABLE t (v int)");
    await a.pool.end(); await b.pool.end();
    const admin = pgAdminUrl(conn!);
    const listed = await cleanupTestDatabases(admin, { minAgeMs: 0, dryRun: true });
    expect(listed).toContain(a.dbName);
    expect(listed).toContain(b.dbName);
    const dropped = await cleanupTestDatabases(admin, { minAgeMs: 0 });
    expect(dropped).toContain(a.dbName);
    expect(dropped).toContain(b.dbName);
    expect(await cleanupTestDatabases(admin, { minAgeMs: 0, dryRun: true })).not.toContain(a.dbName);
  }, 60000);
});
