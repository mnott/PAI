import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import type { PaiDaemonConfig } from "../daemon/config.js";
import { backupStorageFiles, restoreStorageFiles } from "./backup.js";

const tmps: string[] = [];
const dbs: BetterSqlite3.Database[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PAI_HOME;
});
const cfg = { storageBackend: "sqlite" } as PaiDaemonConfig;

describe("backup/restore of a WAL-mode registry.db", () => {
  it("backup contains uncheckpointed writes; restore leaves no stale sidecars", () => {
    const home = tmpDir("pai-home-wal-");
    process.env.PAI_HOME = home;
    const live = new BetterSqlite3(join(home, "registry.db"));
    dbs.push(live);
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0");
    live.exec("CREATE TABLE t (v TEXT)");
    live.prepare("INSERT INTO t VALUES (?)").run("committed-in-wal");
    expect(existsSync(join(home, "registry.db-wal"))).toBe(true);

    const dest = tmpDir("pai-backup-wal-");
    expect(backupStorageFiles(cfg, dest).find((r) => r.label === "Registry DB")?.status).toBe("ok");
    const copy = new BetterSqlite3(join(dest, "registry.db"), { readonly: true });
    expect(copy.prepare("SELECT v FROM t").all()).toEqual([{ v: "committed-in-wal" }]);
    copy.close();
    live.close();

    // restore into a home that has stale sidecars from an older database
    const home2 = tmpDir("pai-home-wal2-");
    process.env.PAI_HOME = home2;
    writeFileSync(join(home2, "registry.db"), "");
    writeFileSync(join(home2, "registry.db-wal"), "stale");
    writeFileSync(join(home2, "registry.db-shm"), "stale");
    expect(restoreStorageFiles(cfg, dest).find((r) => r.label === "Registry DB")?.status).toBe("ok");
    expect(existsSync(join(home2, "registry.db-wal"))).toBe(false);
    expect(existsSync(join(home2, "registry.db-shm"))).toBe(false);
    const restored = new BetterSqlite3(join(home2, "registry.db"));
    expect(restored.prepare("SELECT v FROM t").all()).toEqual([{ v: "committed-in-wal" }]);
    restored.close();
  });
});
