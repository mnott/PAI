import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGlobalDefaults, getGlobalDefaults } from "./session-config.js";

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-sessioncfg-"));
  prev = process.env.PAI_CONFIG_FILE;
  process.env.PAI_CONFIG_FILE = join(dir, "config.json");
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("saveGlobalDefaults", () => {
  it("refuses to write when config.json is not valid JSON, leaving it byte-identical", () => {
    const broken = '{ "daemon": { "port": 1 }, "secret": "x",, }';
    writeFileSync(process.env.PAI_CONFIG_FILE!, broken);
    expect(() => saveGlobalDefaults({ permission: "full" })).toThrow(/config\.json/);
    expect(readFileSync(process.env.PAI_CONFIG_FILE!, "utf8")).toBe(broken);
  });

  it("keeps the other keys, backs up, and leaves no temp file", () => {
    const file = process.env.PAI_CONFIG_FILE!;
    writeFileSync(file, JSON.stringify({ keep: { a: 1 } }));
    saveGlobalDefaults({ permission: "trusted" });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.keep).toEqual({ a: 1 });
    expect(getGlobalDefaults()).toEqual({ permission: "trusted" });
    expect(existsSync(`${file}.bak-pai`)).toBe(true);
    expect(existsSync(`${file}.tmp-pai-${process.pid}`)).toBe(false);
  });

  it("creates the file when it is missing", () => {
    saveGlobalDefaults({ permission: "full" });
    expect(getGlobalDefaults()).toEqual({ permission: "full" });
  });
});
