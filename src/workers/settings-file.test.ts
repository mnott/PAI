import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claudeCommand, pinnedSettingsArgs } from "./run-env.js";
import { gcSettingsFiles, removeRunSettings } from "./settings-file.js";
import { slimProfileArgs } from "./slim-profile.js";

const FAKE = "sk-test-fake";
const home = mkdtempSync(join(tmpdir(), "pai-settings-file-"));
const saved = process.env.PAI_HOME;
const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: "https://api.example.test/anthropic", ANTHROPIC_AUTH_TOKEN: FAKE };

beforeAll(() => {
  process.env.PAI_HOME = home;
});
afterAll(() => {
  if (saved === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("provider token never in argv", () => {
  it("built command carries a settings file path, not the token", () => {
    for (const argv of [claudeCommand(env, false), pinnedSettingsArgs(env, false)]) {
      expect(argv.join("\0")).not.toContain(FAKE);
      expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
    }
  });

  it("the pin file holds the token and is 0600", () => {
    const path = pinnedSettingsArgs(env, false)[1];
    expect(JSON.parse(readFileSync(path, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(FAKE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a route without a token stays inline", () => {
    const argv = pinnedSettingsArgs({}, false);
    expect(JSON.parse(argv[1]).env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });
});

describe("slim profile settings file", () => {
  const user = join(home, "user-settings.json");
  writeFileSync(user, "{}");

  it("is created 0600, also over an existing 0644 file, and removed at finalise", () => {
    const logDir = join(home, "logs-slim");
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, "w-1.settings.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    const args = slimProfileArgs(logDir, "w-1", [], {}, user, undefined, { env: { ANTHROPIC_AUTH_TOKEN: FAKE } });
    expect(args[args.indexOf("--settings") + 1]).toBe(file);
    expect(args.join("\0")).not.toContain(FAKE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    pinnedSettingsArgs(env, false);
    removeRunSettings(logDir, "w-1");
    expect(existsSync(file)).toBe(false);
  });
});

describe("gcSettingsFiles", () => {
  it("removes settings files older than a day, keeps fresh ones", () => {
    const logDir = join(home, "logs-gc");
    mkdirSync(logDir, { recursive: true });
    const old = join(logDir, "w-old.settings.json");
    const fresh = join(logDir, "w-new.settings.json");
    writeFileSync(old, "{}");
    writeFileSync(fresh, "{}");
    const t = new Date(Date.now() - 2 * 86400_000);
    utimesSync(old, t, t);
    expect(gcSettingsFiles(logDir, true)).toEqual([old]);
    expect(existsSync(old)).toBe(true);
    expect(gcSettingsFiles(logDir)).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
