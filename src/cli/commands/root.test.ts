import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS } from "../../workers/config.js";
import { makeStyle } from "../help.js";
import { providerHealth } from "../lib/health.js";
import { allSetups, builtinSetups, findSetup, loadSaved, saveSetup, shortModel } from "../lib/setups.js";
import { ago, finishCd, launchScreen, lastSetup, matchRows, plainTable, setupsTable, truncate } from "./root.js";
import { oneLine, type SessionRow } from "./session.js";

const st = makeStyle(false);
const ok = { state: "ok", reason: "ok" } as const;
const row = (o: Partial<SessionRow>): SessionRow => ({
  id: "aaaaaaaa",
  uuid: "aaaaaaaa-0000",
  name: "20 - Webseiten",
  project: "web",
  provider: "anthropic",
  model: "claude-opus-5-5",
  lastActive: "2d ago",
  lastActiveMs: Date.now() - 2 * 86_400_000,
  status: "resumable",
  message: "keepalive",
  dir: "/tmp/web",
  health: ok,
  ...o,
});

const mk = (enabled = true, fast = "f") => ({ enabled, protocol: "anthropic" as const, baseUrl: "https://x.invalid", keyFile: null, env: {}, models: { default: "m", fast } });
const cfg = {
  active: "glm",
  nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
  providers: { glm: mk(), kimi: mk(), off: mk(false) },
  routing: { budgetWalls: {} } as never,
};

describe("matching", () => {
  const rows = [row({ name: "PAI", uuid: "b1" }), row({ name: "PAI", uuid: "b2" }), row({ name: "Pairing notes", uuid: "c1" }), row({ name: "Other", uuid: "d1", project: "paint" })];
  it("an exact name wins over longer matches, newest first", () => {
    expect(matchRows(rows, "pai").map((r) => r.uuid)).toEqual(["b1"]);
  });
  it("several partial matches are all returned for the pre-filtered picker", () => {
    expect(matchRows(rows, "pa").map((r) => r.uuid)).toEqual(["b1", "b2", "c1", "d1"]);
  });
  it("an id prefix matches one session", () => {
    expect(matchRows(rows, "c1").map((r) => r.uuid)).toEqual(["c1"]);
  });
  it("nothing matches nonsense", () => {
    expect(matchRows(rows, "zzz")).toEqual([]);
  });
});

describe("screens", () => {
  it("the launch screen is at most 6 lines and names session, message, last setup and the three keys", () => {
    const lines = launchScreen(row({}), lastSetup(row({}), cfg), cfg, st);
    expect(lines.length).toBeLessThanOrEqual(6);
    const t = lines.join("\n");
    expect(t).toContain('"20 - Webseiten"');
    expect(t).toContain('"keepalive"');
    expect(t).toContain("opus-5.5 (anthropic) with workers on glm-fast");
    expect(t).toContain("Enter  Continue exactly like last time");
    expect(t).toContain("s      Choose a different setup");
    expect(t).toContain("n      Start fresh");
  });
  it("a provider at its limit is spelled out on the launch screen", () => {
    const r = row({ provider: "glm", model: "glm-5.3", health: { state: "limit", reason: "glm: at limit, 100% until 08:02" } });
    expect(launchScreen(r, lastSetup(r, cfg), cfg, st).join("\n")).toContain("glm: at limit, 100% until 08:02");
  });
  it("the plain picker table has the five columns", () => {
    const t = plainTable([row({})], st);
    for (const h of ["Name", "Project", "Last active", "Last used on", "Last message"]) expect(t).toContain(h);
    expect(t).toContain("opus-5.5 (anthropic)");
  });
  it("the setup chooser lists # | Setup | Orchestrator | Workers | Status", () => {
    const setups = allSetups(cfg, lastSetup(row({}), cfg), []);
    const o = setupsTable(setups, cfg, {}, st);
    expect(o.headers).toEqual(["#", "Setup", "Orchestrator", "Workers", "Status"]);
    expect(o.cells(setups[0])[1]).toBe("Last time");
  });
  it("small formatters", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(ago(Date.now() - 2 * 3600_000)).toBe("2h ago");
    expect(ago(Date.now() - 3 * 86_400_000)).toBe("3d ago");
    expect(oneLine("<task-notification> <task-id>x</task-id> hello  world")).toBe("x hello world");
    expect(shortModel("claude-opus-5-5")).toBe("opus-5.5");
    expect(shortModel("glm-5.3[1m]")).toBe("glm-5.3");
  });
});

describe("setups", () => {
  it("built-ins come from enabled providers only", () => {
    const names = builtinSetups(cfg).map((s) => s.name);
    expect(names).toContain("anthropic only");
    expect(names).toContain("glm only");
    expect(names).toContain("anthropic + kimi workers");
    expect(names.join()).not.toContain("off");
  });
  it("Last time reproduces the session's provider with the workers configured now", () => {
    const s = lastSetup(row({ provider: "kimi", model: "k3" }), cfg);
    expect(s.orchestrator).toEqual({ provider: "kimi", model: "k3" });
    expect(s.workers).toBe("glm");
  });
  it("saves, loads and finds by name or unique prefix (temp file)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pai-setups-")), "setups.json");
    saveSetup({ name: "my mix", orchestrator: { provider: "kimi" }, workers: "glm" }, path);
    const saved = loadSaved(path);
    expect(saved).toEqual([{ name: "my mix", orchestrator: { provider: "kimi" }, workers: "glm", kind: "saved" }]);
    const all = allSetups(cfg, null, saved);
    expect(findSetup(all, "MY MIX")?.name).toBe("my mix");
    expect(findSetup(all, "my")?.name).toBe("my mix");
    expect(findSetup(all, "nope")).toBeNull();
  });
});

describe("providerHealth", () => {
  const now = new Date(2026, 9, 17, 12, 0);
  it("flags a provider at its wall with the reason, and disabled ones", () => {
    const h = providerHealth("glm", cfg, { glm: { percent: 99, resetAt: new Date(2026, 9, 17, 18, 5).getTime(), fetchedAt: 0 } }, now);
    expect(h).toEqual({ state: "limit", reason: "glm: at limit, 99% until 18:05" });
    expect(providerHealth("off", cfg, {}, now).state).toBe("off");
    expect(providerHealth("glm", cfg, { glm: { percent: 40, resetAt: null, fetchedAt: 0 } }, now).state).toBe("ok");
    expect(providerHealth("anthropic", cfg, {}, now).state).toBe("ok");
  });
});

describe("finishCd", () => {
  it("writes to PAI_PICK_OUT file when set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pick-"));
    const path = join(tmp, "out");
    const env = { PAI_PICK_OUT: path };
    const term = { output: { write() {} } as any };
    const result = finishCd("/some/dir", term, env);
    expect(result).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("/some/dir");
  });

  it("writes to output when PAI_PICK_OUT is not set", () => {
    const term = { output: { write(s: string) { expect(s).toBe("/some/dir\n"); } } as any };
    const result = finishCd("/some/dir", term);
    expect(result).toBe(0);
  });
});
