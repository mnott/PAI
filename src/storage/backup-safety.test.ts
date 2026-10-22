import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import type { PaiDaemonConfig } from "../daemon/config.js";
import { restoreStorageFiles } from "./backup.js";

const tmps: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PAI_HOME;
});

describe("restoreDb safety snapshot", () => {
  it("keeps the current db (incl. WAL content) in a timestamped file before overwriting", () => {
    const home = tmpDir("pai-home-safe-");
    process.env.PAI_HOME = home;
    const live = new BetterSqlite3(join(home, "registry.db"));
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0");
    live.exec("CREATE TABLE t (v TEXT)");
    live.prepare("INSERT INTO t VALUES (?)").run("current-state");
    live.close();

    const backup = tmpDir("pai-backup-safe-");
    const b = new BetterSqlite3(join(backup, "registry.db"));
    b.exec("CREATE TABLE t (v TEXT)");
    b.prepare("INSERT INTO t VALUES (?)").run("from-backup");
    b.close();

    const res = restoreStorageFiles({ storageBackend: "sqlite" } as PaiDaemonConfig, backup);
    expect(res.find((r) => r.label === "Registry DB")?.status).toBe("ok");

    const safeties = readdirSync(home).filter((f) => f.startsWith("registry.db.pre-restore-"));
    expect(safeties).toHaveLength(1);
    expect(statSync(join(home, safeties[0])).mode & 0o777).toBe(0o600);
    const snap = new BetterSqlite3(join(home, safeties[0]), { readonly: true });
    expect(snap.prepare("SELECT v FROM t").all()).toEqual([{ v: "current-state" }]);
    snap.close();
    const now = new BetterSqlite3(join(home, "registry.db"), { readonly: true });
    expect(now.prepare("SELECT v FROM t").all()).toEqual([{ v: "from-backup" }]);
    now.close();
  });
});
