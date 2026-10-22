import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveNotificationConfig, defaultNotificationConfig } from "./config.js";

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-notifcfg-"));
  prev = process.env.PAI_CONFIG_FILE;
  process.env.PAI_CONFIG_FILE = join(dir, "config.json");
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("saveNotificationConfig", () => {
  it("refuses to write when config.json is invalid, leaving it byte-identical", () => {
    const broken = '{ "daemon": { "port": 1 }, "secret": "x",, }';
    writeFileSync(process.env.PAI_CONFIG_FILE!, broken);
    expect(() => saveNotificationConfig(defaultNotificationConfig())).toThrow(/config\.json/);
    expect(readFileSync(process.env.PAI_CONFIG_FILE!, "utf8")).toBe(broken);
  });

  it("keeps the other keys", () => {
    const file = process.env.PAI_CONFIG_FILE!;
    writeFileSync(file, JSON.stringify({ keep: { a: 1 } }));
    saveNotificationConfig(defaultNotificationConfig());
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.keep).toEqual({ a: 1 });
    expect(written.notifications).toBeDefined();
  });
});
