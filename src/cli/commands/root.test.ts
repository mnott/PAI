import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS } from "../../workers/config.js";
import { makeStyle } from "../help.js";
import { providerHealth } from "../lib/health.js";
import { allSetups, builtinSetups, findSetup, loadSaved, saveSetup, shortModel } from "../lib/setups.js";
import { pickerKey, pickerView, readOneKey, runPicker, type PickerState, type TtyIn } from "../lib/picker.js";
import { ago, finishCd, launchKey, launchScreen, lastSetup, localState, matchRows, pickerOpts, plainTable, setupsTable, truncate } from "./root.js";
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
  named: false,
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

describe("launch screen keys", () => {
  const drive = (keys: Array<[string | undefined, string?]>) => {
    let sel = 0;
    for (const [str, name] of keys) {
      const r = launchKey(sel, str, { name });
      if (!r) continue;
      sel = r.sel;
      if (r.choice) return { sel, choice: r.choice };
    }
    return { sel, choice: undefined };
  };
  it("Down, Down, Enter runs the third row; Up/k/j move; the marker stops at the ends", () => {
    expect(drive([[undefined, "down"], [undefined, "down"], ["\r", "return"]])).toEqual({ sel: 2, choice: "fresh" });
    expect(drive([[undefined, "down"], [undefined, "return"]])).toEqual({ sel: 1, choice: "setup" });
    expect(drive([["j"], ["j"], ["j"], ["k"], [undefined, "enter"]])).toEqual({ sel: 1, choice: "setup" });
    expect(drive([[undefined, "up"], [undefined, "return"]])).toEqual({ sel: 0, choice: "continue" });
  });
  it("letters keep working and Enter alone continues", () => {
    expect(drive([["s"]]).choice).toBe("setup");
    expect(drive([["n"]]).choice).toBe("fresh");
    expect(drive([[undefined, "return"]]).choice).toBe("continue");
    expect(launchKey(0, "x", {})).toBeNull();
  });
  it("the > marker follows the selection", () => {
    const lines = launchScreen(row({}), lastSetup(row({}), cfg), cfg, st, 2);
    expect(lines.filter((l) => l.startsWith(">")).join()).toContain("Start fresh");
    expect(lines.filter((l) => l.startsWith(">"))).toHaveLength(1);
  });
  it("readOneKey delivers an arrow key from a simulated terminal", async () => {
    const input = Object.assign(new EventEmitter(), { setRawMode: () => undefined, resume: () => undefined, pause: () => undefined }) as unknown as TtyIn;
    const p = readOneKey(input);
    (input as unknown as EventEmitter).emit("keypress", undefined, { name: "down" });
    expect((await p)?.key.name).toBe("down");
  });
  it("the setup chooser moves with Up/Down and Enter picks the highlighted row", () => {
    let s: PickerState = { filter: "", cursor: 0 };
    s = pickerKey(s, undefined, { name: "down" }, 4).state;
    s = pickerKey(s, undefined, { name: "down" }, 4).state;
    s = pickerKey(s, undefined, { name: "up" }, 4).state;
    expect(s.cursor).toBe(1);
    expect(pickerKey(s, "\r", { name: "return" }, 4).action).toBe("select");
    const setups = allSetups(cfg, null, []);
    const o = setupsTable(setups, cfg, {}, st);
    expect(pickerView(s, o, st)[5].startsWith("›")).toBe(true);
  });
});

describe("local setup rows", () => {
  const local = (port: number, enabled = true) => ({ ...mk(enabled), baseUrl: `http://127.0.0.1:${port}` });
  const lcfg = (providers: Record<string, ReturnType<typeof local>>) => ({
    active: null as unknown as string,
    nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
    providers,
    routing: { budgetWalls: {} } as never,
    logDir: "/nonexistent-pai-test-logs",
  });
  const rows = (c: ReturnType<typeof lcfg>, down: Set<string>, resolved?: string) =>
    builtinSetups(c, down, resolved).filter((s) => s.workers in c.providers);

  it("one local server: one 'anthropic + local workers' row on the resolved provider, shown as '<provider> (local)', status ok", async () => {
    const c = lcfg({ codernext: local(8000), "flashnext-iq3": local(8000) });
    const st1 = { ...(await localState(lcfg({ "flashnext-iq3": local(8000) }) as never, async () => true)), down: new Set<string>() };
    expect(st1.resolved).toBe("flashnext-iq3");
    const r = rows(c, st1.down, st1.resolved);
    expect(r.map((s) => s.name)).toEqual(["anthropic + local workers"]);
    const o = setupsTable(r, c, {}, st);
    expect(o.cells(r[0])[3]).toBe(`${st1.resolved} (local)`);
    expect(o.cells(r[0])[4]).toContain("ok");
  });
  it("two distinct local servers: the local row plus one row for the other server", () => {
    const c = lcfg({ a: local(8000), a2: local(8000), b: local(9000) });
    const r = rows(c, new Set(), "a");
    expect(r.map((s) => `${s.name}|${s.workers}`)).toEqual(["anthropic + local workers|a", "anthropic + b workers|b"]);
  });
  it("no local server answers: no local row at all", async () => {
    const c = lcfg({ codernext: local(8000), b: local(9000) });
    const s0 = await localState(c as never, async () => false);
    expect(s0.resolved).toBeUndefined();
    expect(rows(c, s0.down)).toEqual([]);
    expect(builtinSetups(c, s0.down).map((s) => s.name)).toEqual(["anthropic only", "anthropic + haiku workers"]);
  });
  it("saved setups stay as they are", () => {
    const c = lcfg({ a: local(8000) });
    const saved = [{ name: "mine", orchestrator: { provider: "anthropic" }, workers: "a", kind: "saved" as const }];
    expect(allSetups(c, null, saved, new Set(), "a").map((s) => s.name)).toEqual(["mine", "anthropic only", "anthropic + haiku workers", "anthropic + local workers"]);
  });
});

describe("picker layout", () => {
  const long = "x".repeat(300);
  const rows = [
    row({ name: "A very long session name that goes on and on", project: "A very long session name that goes on and on", message: long, model: "claude-opus-5-5" }),
    row({ name: "Jobs Example", project: "09 - Job Search", message: long, provider: "—", model: "—" }),
  ];
  for (const w of [60, 80, 105, 160]) {
    it(`no line is longer than ${w} columns`, () => {
      const o = pickerOpts(rows, st, undefined, () => w);
      const lines = pickerView({ filter: "", cursor: 0 }, o, st);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(w);
      expect(lines.join("\n")).toContain("Jobs Example");
    });
  }
  it("below 60 columns shows Name and Last active only", () => {
    const o = pickerOpts(rows, st, undefined, () => 50);
    const head = pickerView({ filter: "", cursor: 0 }, o, st).find((l) => l.includes("Last active")) ?? "";
    expect(head).toContain("Name");
    expect(head).not.toContain("Project");
    expect(head).not.toContain("Last message");
  });
  it("narrow widths show the model only and drop Project when it repeats the name", () => {
    const same = [row({ name: "web", project: "web" })];
    const lines = pickerView({ filter: "", cursor: 0 }, pickerOpts(same, st, undefined, () => 80), st).join("\n");
    expect(lines).not.toContain("Project");
    expect(lines).not.toContain("(anthropic)");
  });
});

describe("picker repaints in place", () => {
  it("a refresh redraws over the first paint instead of appending a second table", async () => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} }) as unknown as TtyIn;
    let buf = "";
    const output = { write: (s: string) => (buf += s) };
    const later = Promise.resolve([row({ name: "Fresh" })]);
    const done = runPicker(pickerOpts([row({ name: "Stale" })], st, undefined, () => 100, later), st, input, output);
    await later;
    await new Promise((r) => setTimeout(r, 0));
    expect(buf).toContain("Fresh");
    // second paint starts by moving the cursor back up over the first
    expect(buf).toMatch(/\u001b\[\d+A\r\u001b\[J/);
    (input as unknown as EventEmitter).emit("keypress", undefined, { name: "escape" });
    expect(await done).toBeNull();
  });
});
