import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScanConfig, saveScanConfig } from "./scan.js";

let home: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-scancfg-"));
  for (const k of ["HOME", "PAI_HOME"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.PAI_HOME = join(home, ".pai");
  mkdirSync(process.env.PAI_HOME, { recursive: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("saveScanConfig", () => {
  it("refuses to overwrite an unparsable file, leaving it byte-identical", () => {
    const file = join(process.env.PAI_HOME!, "registry-scan.json");
    const broken = '{"scan_dirs": ["/a",';
    writeFileSync(file, broken);
    expect(loadScanConfig()).toEqual({ scan_dirs: [] });
    expect(() => saveScanConfig({ scan_dirs: ["/b"] })).toThrow(/registry-scan\.json/);
    expect(readFileSync(file, "utf8")).toBe(broken);
  });

  it("writes atomically and round-trips", () => {
    saveScanConfig({ scan_dirs: ["/a"] });
    saveScanConfig({ scan_dirs: ["/a", "/b"] });
    expect(loadScanConfig()).toEqual({ scan_dirs: ["/a", "/b"] });
    expect(readdirSync(process.env.PAI_HOME!).filter((f) => f.includes(".tmp-pai-"))).toEqual([]);
  });
});
