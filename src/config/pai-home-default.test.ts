/**
 * A path under the current default home (~/.pai) is never an "old" location,
 * so a PAI_HOME override must not be told to pull live data out of it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnderDefaultPaiHome, resolvePaiFile, migratePaiFile, migratePaiDir } from "./pai-home.js";
import { backupsDirPath } from "../cli/commands/lifecycle/backup.js";
import { migrateBackupsLegacy } from "../cli/impl/config.js";

const dirs: string[] = [];
const saved = { HOME: process.env.HOME, PAI_HOME: process.env.PAI_HOME };
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

/** A fake default home holding .pai/backups, plus a distinct PAI_HOME. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pai-fakehome-"));
  dirs.push(home);
  mkdirSync(join(home, ".pai", "backups"), { recursive: true });
  writeFileSync(join(home, ".pai", "backups", "snap.txt"), "live");
  const paiHome = join(home, "elsewhere");
  mkdirSync(paiHome);
  process.env.HOME = home;
  process.env.PAI_HOME = paiHome;
  return { home, paiHome };
}

describe("default home is never an old location", () => {
  it("isUnderDefaultPaiHome matches the home and its children only", () => {
    const { home } = fixture();
    expect(isUnderDefaultPaiHome(join(home, ".pai"))).toBe(true);
    expect(isUnderDefaultPaiHome(join(home, ".pai", "backups"))).toBe(true);
    expect(isUnderDefaultPaiHome(join(home, ".pai-other"))).toBe(false);
    expect(isUnderDefaultPaiHome(join(home, ".claude", "pai"))).toBe(false);
  });

  it("backupsDirPath returns the PAI_HOME path and prints no notice", () => {
    const { paiHome } = fixture();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(backupsDirPath()).toBe(join(paiHome, "backups"));
    expect(err.mock.calls.map((c) => String(c[0])).join("")).not.toContain("old location");
  });

  it("resolvePaiFile still honours a genuinely legacy candidate", () => {
    const { home, paiHome } = fixture();
    const legacy = join(home, ".claude", "pai", "x.json");
    mkdirSync(join(home, ".claude", "pai"), { recursive: true });
    writeFileSync(legacy, "{}");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(resolvePaiFile(join(paiHome, "x.json"), [legacy], "h")).toBe(legacy);
  });

  it("migratePaiFile / migratePaiDir never take a source from the default home", () => {
    const { home, paiHome } = fixture();
    writeFileSync(join(home, ".pai", "f.json"), "{}");
    const f = migratePaiFile(join(paiHome, "f.json"), [join(home, ".pai", "f.json")]);
    expect(f.fromPath).toBeNull();
    const d = migratePaiDir(join(paiHome, "backups"), [join(home, ".pai", "backups")]);
    expect(d.fromDir).toBeNull();
    expect(existsSync(join(home, ".pai", "f.json"))).toBe(true);
    expect(existsSync(join(home, ".pai", "backups", "snap.txt"))).toBe(true);
  });

  it("migrate --backups moves nothing out of the default home", () => {
    const { home, paiHome } = fixture();
    const r = migrateBackupsLegacy(false);
    expect(r.fromDir).toBeNull();
    expect(r.note).toContain("current default");
    expect(existsSync(join(home, ".pai", "backups", "snap.txt"))).toBe(true);
    expect(existsSync(join(paiHome, "backups"))).toBe(false);
  });
});
