import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paiHomeDir } from "./pai-home.js";
import { applyHomeMigration, planHomeMigration, rewritePaiPaths, renderTable } from "./home-migrate.js";
import { homeMigrateCmd } from "../cli/impl/home.js";

const dirs: string[] = [];
function fakeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "pai-home-mig-"));
  dirs.push(h);
  return h;
}
function put(path: string, body = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
});

describe("paiHomeDir resolution", () => {
  it("defaults to ~/.pai", () => {
    const h = fakeHome();
    process.env.HOME = h;
    delete process.env.PAI_HOME;
    expect(paiHomeDir()).toBe(join(h, ".pai"));
  });
  it("keeps the legacy dir until migrated", () => {
    const h = fakeHome();
    process.env.HOME = h;
    delete process.env.PAI_HOME;
    put(join(h, ".claude", "pai", "config.yaml"));
    mkdirSync(join(h, ".pai", "pgdata"), { recursive: true });
    expect(paiHomeDir()).toBe(join(h, ".claude", "pai"));
  });
  it("prefers ~/.pai once it has config.yaml", () => {
    const h = fakeHome();
    process.env.HOME = h;
    delete process.env.PAI_HOME;
    put(join(h, ".claude", "pai", "config.yaml"));
    put(join(h, ".pai", "config.yaml"));
    expect(paiHomeDir()).toBe(join(h, ".pai"));
  });
  it("PAI_HOME overrides everything", () => {
    const h = fakeHome();
    process.env.HOME = h;
    put(join(h, ".claude", "pai", "config.yaml"));
    process.env.PAI_HOME = "/somewhere/else";
    expect(paiHomeDir()).toBe("/somewhere/else");
  });
});

describe("rewritePaiPaths", () => {
  it("rewrites tilde, $HOME and absolute forms, and nothing else", () => {
    const t = "a: ~/.claude/pai/keys/x\nb: /h/.claude/pai/logs\nc: $HOME/.claude/pai\nd: ~/.claude/pai.json\ne: ~/.claude/pairs\nf: /other/.claude/pai/x";
    const r = rewritePaiPaths(t, "/h");
    expect(r.count).toBe(3);
    expect(r.text).toBe("a: ~/.pai/keys/x\nb: /h/.pai/logs\nc: $HOME/.pai\nd: ~/.claude/pai.json\ne: ~/.claude/pairs\nf: /other/.claude/pai/x");
  });
});

function setup(): string {
  const h = fakeHome();
  put(join(h, ".claude", "pai", "config.yaml"), `vault: ${h}/.claude/pai/obsidian-vault\n`);
  put(join(h, ".claude", "pai", "workers.yaml"), `key_file: ${h}/.claude/pai/keys/a\n`);
  put(join(h, ".claude", "pai", "keys", "a"), "secret");
  put(join(h, ".claude", "pai", "History", "h.txt"));
  put(join(h, ".claude", "pai", "config.yaml.bak-pai"));
  put(join(h, ".claude", "pai", ".DS_Store"));
  put(join(h, ".pai", ".DS_Store"));
  put(join(h, ".pai", "pgdata", "PG_VERSION"), "16");
  put(join(h, ".pai", "scheduler-state.json.bak"));
  put(join(h, ".pai", "old.tar.gz"));
  put(join(h, ".pai", "x.migrated-20260919"));
  put(join(h, "Library", "LaunchAgents", "com.pai.pai-daemon.plist"), `<string>${h}/.claude/pai/logs/d.log</string>`);
  put(join(h, "Library", "LaunchAgents", "com.other.plist"), `<string>${h}/.claude/pai/x</string>`);
  return h;
}

describe("planHomeMigration / dry run", () => {
  it("dry run changes nothing and reports the plan", () => {
    const h = setup();
    const lines: string[] = [];
    const log = console.log;
    console.log = (s?: unknown) => void lines.push(String(s));
    let rc: number;
    try {
      rc = homeMigrateCmd({ dryRun: true }, h, () => []);
    } finally {
      console.log = log;
    }
    expect(rc).toBe(0);
    expect(lstatSync(join(h, ".claude", "pai")).isDirectory()).toBe(true);
    expect(existsSync(join(h, ".pai", "config.yaml"))).toBe(false);
    expect(readFileSync(join(h, ".pai", "pgdata", "PG_VERSION"), "utf8")).toBe("16");
    const out = lines.join("\n");
    expect(out).toContain("pgdata");
    expect(out).toContain("(untouched)");
    expect(out).toContain("attic");
  });
  it("busy daemon/workers make a real run refuse, nothing moves", () => {
    const h = setup();
    const log = console.log;
    console.log = () => {};
    let rc: number;
    try {
      rc = homeMigrateCmd({}, h, () => ["PAI daemon (pid 1)"]);
    } finally {
      console.log = log;
    }
    expect(rc).toBe(1);
    expect(lstatSync(join(h, ".claude", "pai")).isDirectory()).toBe(true);
  });
  it("detects name clashes with existing ~/.pai entries, including pgdata", () => {
    const h = setup();
    put(join(h, ".pai", "keys", "b"));
    put(join(h, ".claude", "pai", "pgdata", "evil"));
    const plan = planHomeMigration({ home: h, date: "20261019" });
    expect(plan.clashes.sort()).toEqual(["keys", "pgdata"]);
    expect(() => applyHomeMigration(plan, h)).toThrow(/clashes/);
    expect(existsSync(join(h, ".claude", "pai", "keys", "a"))).toBe(true);
    expect(existsSync(join(h, ".pai", "pgdata", "evil"))).toBe(false);
  });
});

describe("applyHomeMigration", () => {
  it("renames into ~/.pai, attics leftovers, symlinks, rewrites paths, leaves pgdata alone", () => {
    const h = setup();
    const plan = planHomeMigration({ home: h, date: "20261019" });
    expect(plan.clashes).toEqual([]);
    expect(plan.rewrites.map((r) => r.file.replace(h, "")).sort()).toEqual([
      "/.pai/config.yaml",
      "/.pai/workers.yaml",
      "/Library/LaunchAgents/com.pai.pai-daemon.plist",
    ]);
    const table = renderTable(plan, () => 1024, h);
    expect(table).toContain("pgdata");

    applyHomeMigration(plan, h);

    expect(lstatSync(join(h, ".claude", "pai")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(h, ".claude", "pai"))).toBe(join(h, ".pai"));
    expect(readFileSync(join(h, ".pai", "keys", "a"), "utf8")).toBe("secret");
    expect(readFileSync(join(h, ".pai", "History", "h.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(h, ".pai", "pgdata", "PG_VERSION"), "utf8")).toBe("16");
    expect(existsSync(join(h, ".pai", "attic", "20261019", "config.yaml.bak-pai"))).toBe(true);
    expect(existsSync(join(h, ".pai", "attic", "20261019", "old.tar.gz"))).toBe(true);
    expect(existsSync(join(h, ".pai", "attic", "20261019", "x.migrated-20260919"))).toBe(true);
    expect(existsSync(join(h, ".pai", "attic", "20261019", ".DS_Store"))).toBe(true);
    expect(existsSync(join(h, ".pai", "old.tar.gz"))).toBe(false);
    expect(readFileSync(join(h, ".pai", "config.yaml"), "utf8")).toBe(`vault: ${h}/.pai/obsidian-vault\n`);
    expect(readFileSync(join(h, ".pai", "workers.yaml"), "utf8")).toBe(`key_file: ${h}/.pai/keys/a\n`);
    expect(readFileSync(join(h, "Library", "LaunchAgents", "com.pai.pai-daemon.plist"), "utf8")).toContain(`${h}/.pai/logs/d.log`);
    expect(readFileSync(join(h, "Library", "LaunchAgents", "com.other.plist"), "utf8")).toContain(".claude/pai/x");
    // resolves to the new home through the legacy path too
    expect(readFileSync(join(h, ".claude", "pai", "keys", "a"), "utf8")).toBe("secret");

    // second run: nothing to do
    expect(planHomeMigration({ home: h, date: "20261019" }).skip).toMatch(/already/);
  });
});
