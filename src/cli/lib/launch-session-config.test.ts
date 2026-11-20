import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../../storage/registry-sqlite.js";

let backend: SQLiteRegistryBackend;
vi.mock("../../storage/factory.js", () => ({ getRegistryBackend: async () => backend }));

import { buildHarness, dryRunText } from "./harness.js";
import { launchInDir, splitFlags, sessionLaunchExtras } from "./launch.js";

let dir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string) { saved[k] = process.env[k]; process.env[k] = v; }

async function project(slug: string, cfg?: object) {
  const root = join(dir, slug);
  mkdirSync(root, { recursive: true });
  const p = await backend.createProject({ slug, displayName: slug, rootPath: root, encodedDir: slug, createdAt: 1, updatedAt: 1 });
  if (cfg) await backend.updateProjectSessionConfig(p.id, JSON.stringify(cfg), 2);
  return root;
}

function globalDefaults(json: string) { writeFileSync(join(dir, "config.json"), `{"sessionDefaults":${json}}`); }

async function dry(root: string): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
  await launchInDir(root, "demo", { dryRun: true, engine: "claude" });
  spy.mockRestore();
  return lines.join("\n");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pai-launchcfg-")));
  mkdirSync(join(dir, "home"), { recursive: true });
  setEnv("PAI_HOME", join(dir, "home"));
  setEnv("PAI_CONFIG_FILE", join(dir, "config.json"));
  globalDefaults("{}");
  const db = new DatabaseCtor(":memory:");
  initializeSchema(db);
  backend = new SQLiteRegistryBackend(db);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

describe("launch applies the project session config", () => {
  it("preset full: exec line carries the flag and the env", async () => {
    const root = await project("full", { permission: "full", flags: "--dangerously-skip-permissions", env: { IS_SANDBOX: "1" } });
    const out = await dry(root);
    expect(out).toContain("--dangerously-skip-permissions");
    expect(out).toContain("IS_SANDBOX=1");
  });

  it("no config: line unchanged", async () => {
    const out = await dry(await project("plain"));
    expect(out).not.toContain("--dangerously");
    expect(out).not.toContain("flags:");
    expect(out).not.toContain("env:");
  });

  it("global default applies when the project has none; project overrides it", async () => {
    globalDefaults('{"flags":"--dangerously-skip-permissions","env":{"A":"g"}}');
    expect(await dry(await project("inherit"))).toContain("--dangerously-skip-permissions");
    const out = await dry(await project("own", { flags: "--permission-mode plan" }));
    expect(out).toContain("--permission-mode plan");
    expect(out).not.toContain("--dangerously-skip-permissions");
  });

  it("pai open / pai new builder: flags in argv, env in env and dry-run, nothing without config", async () => {
    const workers = { providers: {}, nativeModels: {}, logDir: join(dir, "logs") } as never;
    const root = await project("hx", { flags: "--dangerously-skip-permissions", env: { IS_SANDBOX: "1" } });
    const h = await buildHarness(workers, { provider: "anthropic", cwd: root, name: "hx", resume: "u-1" });
    expect(h.argv).toContain("--dangerously-skip-permissions");
    expect(h.env.IS_SANDBOX).toBe("1");
    expect(dryRunText(h)).toContain("IS_SANDBOX=1");
    const plain = await buildHarness(workers, { provider: "anthropic", cwd: await project("hp"), name: "hp" });
    expect(plain.argv).not.toContain("--dangerously-skip-permissions");
    expect(plain.env.IS_SANDBOX).toBeUndefined();
  });

  it("splits flags shell-safely and does not repeat a flag already present", () => {
    expect(splitFlags(`--allowedTools "Edit Read" --x='a b'`)).toEqual(["--allowedTools", "Edit Read", "--x=a b"]);
    const x = sessionLaunchExtras({ flags: "--name other --verbose", model: "opus" }, ["--name", "n"], true);
    expect(x.args).toEqual(["--verbose", "--model", "opus"]);
    expect(sessionLaunchExtras({ model: "opus" }, [], false).args).toEqual([]);
  });

  it("interactive model: native without a named model uses orchestratorModel, explicit wins, non-native keeps its default", async () => {
    const { nativeOrchestratorModel } = await import("../../workers/config.js");
    const mk = (m: string) => ({ engine: "claude", protocol: "anthropic", models: { default: m }, env: {}, enabled: true });
    const workers = { providers: { other: mk("other-default") }, nativeModels: { default: "sonnet" }, logDir: join(dir, "logs") } as never;
    const cwd = await project("mdl");
    const model = async (provider: string, m?: string) => (await buildHarness(workers, { provider, cwd, name: "mdl", model: m })).model;
    expect(await model("anthropic")).toBe(nativeOrchestratorModel());
    expect(await model("anthropic", "sonnet")).toBe("sonnet");
    expect(await model("anthropic", nativeOrchestratorModel())).toBe(nativeOrchestratorModel());
    expect(await model("other")).toBe("other-default");
  });
});

// ---- pai session --local: the interactive local-model launcher (session.ts) ----
describe("pai session --local plan", () => {
  const mkProvider = (port: number) => ({
    engine: "claude", protocol: "anthropic", baseUrl: `http://127.0.0.1:${port}`,
    models: { default: "gyro-m", fast: "gyro-s" }, env: {}, enabled: true,
  });

  it("print-cmd shows the router route, the local model, the compact window, no API key, the slim MCP list", async () => {
    const { parseWorkersConfig } = await import("../../workers/config.js");
    const { planLocalSession, localSessionPrintText } = await import("../commands/session.js");
    const workers = parseWorkersConfig({ providers: { gyro: mkProvider(9) }, localContextTokens: 65536 });
    // a claude home under our control: the slim profile reads its settings.json + MCP defs from here
    const ch = join(dir, "claude-home");
    mkdirSync(ch, { recursive: true });
    writeFileSync(join(ch, "settings.json"), JSON.stringify({
      // the user's settings carry a proxy route AND an API key: an interactive
      // local session must never keep the key (it bills the subscription, and
      // here there is no subscription — the router answers)
      env: { ANTHROPIC_BASE_URL: "https://user-proxy.example", ANTHROPIC_API_KEY: "sk-user" },
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "node x/worker-guard.mjs" }, { type: "command", command: "node x/inject-observations.mjs" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "node x/load-core-context.mjs" }] }],
      },
    }));
    // ~/.claude.json is the real home's and not ours to write; the MCP reader
    // caches per file mtime, so each run gets a fresh temp file instead
    const cj = join(dir, `claude-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(cj, JSON.stringify({ mcpServers: { aibroker: { command: "echo", args: ["a"] }, pai: { command: "echo", args: ["p"] }, todoist: { command: "echo" } } }));
    setEnv("CLAUDE_CONFIG_DIR", ch);
    // the probe seam says gyro runs; the route seam fakes the router — no live router needed
      const opts = { workers, logDir: join(dir, "logs"), sessionName: "demo", check: async () => true, route: () => "http://127.0.0.1:65432", claudeJson: cj };
      const p = await planLocalSession(opts);
      expect(p.model).toBe("gyro-m");
      expect(p.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:65432");
      expect(p.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("65536");
      expect(p.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(p.env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-pai-interactive: 1");
      const text = localSessionPrintText(p);
      expect(text).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:65432");
      expect(text).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=65536");
      expect(text).toContain("ANTHROPIC_API_KEY=(not set)");
      expect(text).toContain("mcpServers=aibroker, pai");
      expect(text).toMatch(/^claude --model gyro-m/m);
      // the written settings file: route pinned inside it (settings env outranks process env),
      // the user's proxy+key dropped, guard hooks kept, context injectors off
      const s = JSON.parse(readFileSync(p.settingsFile!, "utf8")) as Record<string, any>;
      expect(s.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:65432");
      expect(s.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("65536");
      const cmds = JSON.stringify(s.hooks);
      expect(cmds).toContain("worker-guard");
      expect(cmds).not.toContain("inject-observations");
      expect(cmds).not.toContain("load-core-context");
      // --model override validates against the provider's configured ids
      // --model override validates against the provider's configured ids
      await expect(planLocalSession({ ...opts, model: "nope" })).rejects.toThrow(/not configured/);
  });
});
