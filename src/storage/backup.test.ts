import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaiDaemonConfig } from "../daemon/config.js";
import { backupStorageFiles, restoreStorageFiles, inspectStorageBackup } from "./backup.js";

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

const sqliteConfig = { storageBackend: "sqlite" } as PaiDaemonConfig;
const postgresConfig = { storageBackend: "postgres" } as PaiDaemonConfig;

describe("backupStorageFiles / restoreStorageFiles", () => {
  it("postgres backend: no-op (pg_dump is the real backup, not a file copy)", () => {
    process.env.PAI_HOME = tmpDir("pai-home-");
    const destDir = tmpDir("pai-backup-dest-");
    expect(backupStorageFiles(postgresConfig, destDir)).toEqual([]);
    expect(restoreStorageFiles(postgresConfig, destDir)).toEqual([]);
  });

  it("sqlite backend: round-trips registry.db through a backup dir", () => {
    const home = tmpDir("pai-home-");
    process.env.PAI_HOME = home;
    writeFileSync(join(home, "registry.db"), "fake-registry-bytes");

    const destDir = tmpDir("pai-backup-dest-");
    const backupResults = backupStorageFiles(sqliteConfig, destDir);
    expect(backupResults.find((r) => r.label === "Registry DB")?.status).toBe("ok");
    expect(existsSync(join(destDir, "registry.db"))).toBe(true);

    expect(inspectStorageBackup(destDir)).toEqual({ hasRegistry: true, hasFederation: false });

    const newHome = tmpDir("pai-home-restore-");
    process.env.PAI_HOME = newHome;
    // Pre-touch the destination inside the temp PAI_HOME so registryDbPath()'s
    // resolvePaiFile() resolves deterministically to it, never falling back to
    // the real ~/.pai/registry.db on this machine (see hard rule: tests must
    // never touch the real *.db files).
    writeFileSync(join(newHome, "registry.db"), "");
    const restoreResults = restoreStorageFiles(sqliteConfig, destDir);
    expect(restoreResults.find((r) => r.label === "Registry DB")?.status).toBe("ok");
    expect(existsSync(join(newHome, "registry.db"))).toBe(true);
  });
});
