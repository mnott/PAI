import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paiHomeDir } from "./pai-home.js";
import { applyHomeMigration, planHomeMigration, rewritePaiPaths, renderTable } from "./home-migrate.js";
import { homeMigrateCmd } from "../cli/impl/home.js";
import { setConfigValueOp, unsetConfigValueOp } from "./main-config-ops.js";
import { readWorkersSection, writeWorkersSection } from "../workers/config.js";

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

// ---------------------------------------------------------------------------
// `pai config set` provider overrides (the 2026-11-17 incident): a partial
// workers.providers.<name>.* block written into config.yaml broke every load
// ("workers.providers.gyro-l.baseUrl: is required") and the router answered
// 500 to all workers; the same write reflowed unrelated long strings. Lives
// here because this file already owns the temp-PAI-home pattern above.
// ---------------------------------------------------------------------------

const cfgDirs: string[] = [];
const cfgSaved: Record<string, string | undefined> = {};

/** A temp PAI home whose config.yaml carries one long line that must never
 *  reflow, and a workers.yaml defining gyro-l. Never the live files. */
function fakeCfgHome(workersYaml: string): string {
  const h = mkdtempSync(join(tmpdir(), "pai-cfg-ops-"));
  cfgDirs.push(h);
  for (const k of ["PAI_HOME", "PAI_CONFIG_FILE", "PAI_WORKERS_YAML"]) cfgSaved[k] = process.env[k];
  process.env.PAI_HOME = h;
  process.env.PAI_CONFIG_FILE = join(h, "config.json");
  process.env.PAI_WORKERS_YAML = join(h, "workers.yaml");
  const LONG = "x".repeat(120);
  writeFileSync(join(h, "config.yaml"), `# main config\nvaultPath: ${LONG}/${LONG}\nlogLevel: info\n`);
  writeFileSync(join(h, "workers.yaml"), workersYaml);
  return h;
}

afterEach(() => {
  while (cfgDirs.length) rmSync(cfgDirs.pop()!, { recursive: true, force: true });
  for (const [k, v] of Object.entries(cfgSaved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// The test run's global sandbox config.yaml (test/setup-home-guard.ts) is a
// sibling of the fixture homes: a provider set whose name workers.yaml does not
// define would merge onto its provider and break every later readWorkersSection
// in this file. Each case names providers nothing else uses, and cleans up.
afterEach(() => {
  try {
    const guard = process.env.PAI_CONFIG_FILE;
    if (!guard) return;
    const guardYaml = join(dirname(guard), "config.yaml");
    if (existsSync(guardYaml)) writeFileSync(guardYaml, readFileSync(guardYaml, "utf8").replace(/^workers:\n(?:[ \t].*\n)*\n?/m, ""));
  } catch {
    /* best effort */
  }
});

const GYRO_YAML = `active: gyro-l
providers:
  anthropic:
    builtin: true
  gyro-l:
    url: http://127.0.0.1:8791
    models:
      default: qwen3.8-flash-next-gyro-l
`;

describe("config set provider overrides (2026-11-17 incident)", () => {
  it("the exact incident command lands in workers.yaml and the config still loads", () => {
    const h = fakeCfgHome(GYRO_YAML);
    const cfgBefore = readFileSync(join(h, "config.yaml"), "utf8");
    setConfigValueOp("workers.providers.gyro-l.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS", "32768");

    // config.yaml byte-identical: no partial provider block, no reflow.
    expect(readFileSync(join(h, "config.yaml"), "utf8")).toBe(cfgBefore);
    const w = readFileSync(join(h, "workers.yaml"), "utf8");
    expect(w).toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32768"'); // a string, not an int

    const { workers } = readWorkersSection();
    expect(workers.providers["gyro-l"].baseUrl).toBe("http://127.0.0.1:8791"); // url kept
    expect(workers.providers["gyro-l"].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32768");
  });

  it("an unrelated long string is byte-identical after a set", () => {
    const h = fakeCfgHome(GYRO_YAML);
    const LONG = "x".repeat(120);
    const before = readFileSync(join(h, "config.yaml"), "utf8");
    expect(before).toContain(`vaultPath: ${LONG}/${LONG}`); // plain, unquoted, one line
    setConfigValueOp("logLevel", "debug");
    const after = readFileSync(join(h, "config.yaml"), "utf8");
    expect(after).toContain(`vaultPath: ${LONG}/${LONG}\n`); // the exact line survives
    expect(after).toMatch(/^logLevel: debug$/m);
  });

  it("a write that would make the config unloadable is refused, both files unchanged", () => {
    const h = fakeCfgHome(GYRO_YAML);
    const cfgBefore = readFileSync(join(h, "config.yaml"), "utf8");
    const wBefore = readFileSync(join(h, "workers.yaml"), "utf8");
    // a provider nobody defines, with no url: the loader would fail on it, so
    // the write is refused before anything touches disk (env value or not).
    expect(() => setConfigValueOp("workers.providers.newbie.env.FOO", "32768")).toThrow(/would not load/);
    expect(readFileSync(join(h, "config.yaml"), "utf8")).toBe(cfgBefore);
    expect(readFileSync(join(h, "workers.yaml"), "utf8")).toBe(wBefore);
  });

  it("a stray partial provider block in config.yaml deep-merges onto its workers.yaml provider", () => {
    // the kaputt file from 2026-11-17 must load again without a restore
    const h = fakeCfgHome(GYRO_YAML);
    writeFileSync(
      join(h, "config.yaml"),
      readFileSync(join(h, "config.yaml"), "utf8") +
        `workers:\n  providers:\n    gyro-l:\n      env:\n        CLAUDE_CODE_MAX_OUTPUT_TOKENS: 32768\n`
    );
    const { workers } = readWorkersSection();
    expect(workers.providers["gyro-l"].baseUrl).toBe("http://127.0.0.1:8791");
    expect(workers.providers["gyro-l"].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32768");
  });

  it("unset of a provider env key removes it from workers.yaml, nothing else moves", () => {
    const h = fakeCfgHome(GYRO_YAML);
    setConfigValueOp("workers.providers.gyro-l.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS", "32768");
    expect(unsetConfigValueOp("workers.providers.gyro-l.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS").existed).toBe(true);
    expect(readFileSync(join(h, "workers.yaml"), "utf8")).toBe(GYRO_YAML); // scaffolding pruned
  });

  it("an unrelated workers-section write never rewrites the mode as a side effect", () => {
    const h = fakeCfgHome(`mode: balanced\n${GYRO_YAML}`);
    const wBefore = readFileSync(join(h, "workers.yaml"), "utf8");
    const { raw, workers } = readWorkersSection();
    workers.routing.cooldownMinutes = 17;
    writeWorkersSection(raw, workers);
    expect(readFileSync(join(h, "workers.yaml"), "utf8")).toBe(wBefore);
  });
});
