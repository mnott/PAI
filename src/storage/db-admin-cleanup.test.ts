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
    // onlyNames scopes the sweep to the databases this test created: with
    // minAgeMs 0 an unscoped sweep would drop scratch dbs other vitest
    // workers are mid-use (the merge-gate "database does not exist" flaky).
    const mine = () => ({ minAgeMs: 0, onlyNames: [a.dbName, b.dbName] });
    const listed = await cleanupTestDatabases(admin, { ...mine(), dryRun: true });
    expect(listed).toContain(a.dbName);
    expect(listed).toContain(b.dbName);
    // a scratch db not on the list is never dropped, even at age 0 — that is
    // another worker's in-flight database in a real parallel run.
    const foreign = await createScratchDatabase("cleanupkeep");
    made.push(foreign);
    await foreign.pool.query("CREATE TABLE t (v int)");
    await foreign.pool.end();
    const dropped = await cleanupTestDatabases(admin, mine());
    expect(dropped).toContain(a.dbName);
    expect(dropped).toContain(b.dbName);
    expect(dropped).not.toContain(foreign.dbName);
    expect(await cleanupTestDatabases(admin, { ...mine(), dryRun: true })).not.toContain(a.dbName);
    // the foreign db survived the sweep and is still there for its own cleanup.
    expect(await cleanupTestDatabases(admin, { minAgeMs: 0, onlyNames: [foreign.dbName], dryRun: true })).toContain(foreign.dbName);
  }, 60000);
});
