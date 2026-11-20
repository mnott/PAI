import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
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

// "" keeps the key in `saved` as undefined, so afterEach deletes it again
function setEnv(k: string, v: string | "") { if (v === "") delete process.env[k]; else process.env[k] = v; }

/** Points readWorkersCached at a cap of `tokens`: localContextTokens rides in the main config's workers section. */
function capConfig(name: string, tokens: number) {
  const f = join(dir, `${name}.config.yaml`);
  writeFileSync(f, `workers:\n  localContextTokens: ${tokens}\n`);
  setEnv("PAI_CONFIG_FILE", f);
}

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
    const workers = parseWorkersConfig({ providers: { gyro: mkProvider(9) }, localContextTokens: 100000 });
    // a claude home under our control: the slim profile reads its settings.json + MCP defs from here
    const ch = join(dir, "claude-home");
    mkdirSync(ch, { recursive: true });
    // the user's real customization dirs ride under this fake home: with the
    // user source loaded, print-cmd must show them reachable
    mkdirSync(join(ch, "skills/demo-skill"), { recursive: true });
    writeFileSync(join(ch, "skills/demo-skill/SKILL.md"), "---\nname: demo-skill\ndescription: probe\n---\n");
    mkdirSync(join(ch, "commands"), { recursive: true });
    writeFileSync(join(ch, "commands/demo-cmd.md"), "# demo command\n");
    mkdirSync(join(ch, "agents"), { recursive: true });
    writeFileSync(join(ch, "agents/demo-agent.md"), "---\nname: demo-agent\n---\n");
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
      expect(p.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("262144");
      expect(p.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(p.env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-pai-interactive: 1");
      const text = localSessionPrintText(p);
      expect(text).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:65432");
      expect(text).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144");
      expect(text).toContain("ANTHROPIC_API_KEY=(not set)");
      expect(text).toContain("mcpServers=aibroker, pai, todoist");
      expect(text).toContain("mcp deferred (tool search): todoist");
      expect(text).toMatch(/^claude --model gyro-m/m);
      // the user setting source is loaded: /Name resolves against ~/.claude skills,
      // commands and agents; what stays out is neutralised elsewhere — hooks come
      // from --settings alone (the guard filter), MCP from --strict-mcp-config
      expect(text).toContain("--setting-sources user,project,local");
      expect(p.argv).toContain("--strict-mcp-config");
      // print-cmd names the user's customization dirs and they exist under this home
      expect(text).toContain("user skills/commands/agents: skills, commands, agents from " + ch);
      expect(existsSync(join(ch, "skills/demo-skill/SKILL.md"))).toBe(true);
      expect(existsSync(join(ch, "commands/demo-cmd.md"))).toBe(true);
      expect(existsSync(join(ch, "agents/demo-agent.md"))).toBe(true);
      // the written settings file: route pinned inside it (settings env outranks process env),
      // the user's proxy+key dropped, guard hooks kept, context injectors off
      const s = JSON.parse(readFileSync(p.settingsFile!, "utf8")) as Record<string, any>;
      expect(s.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:65432");
      expect(s.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("262144");
      const cmds = JSON.stringify(s.hooks);
      expect(cmds).toContain("worker-guard");
      expect(cmds).not.toContain("inject-observations");
      expect(cmds).not.toContain("load-core-context");
      // --model override validates against the provider's configured ids
      await expect(planLocalSession({ ...opts, model: "nope" })).rejects.toThrow(/not configured/);
  });

  // the compact window resolver (run-env.ts localCompactWindow): a provider env
  // entry for the key is the model's native window as shipped in providers.yaml
  // (gyro-l carries 262144 there), never an operator choice — it must not win
  // over workers.localContextTokens, or `session --local` compacts at 262144
  // and stalls the local engine at 130k+ contexts (1.2.129).
  it("compact window: a provider env model window never widens past the cap; the cap wins; the model window caps from above", async () => {
    const { parseWorkersConfig } = await import("../../workers/config.js");
    const { localCompactWindow } = await import("../../workers/run-env.js");
    // parseWorkersConfig fills the provider shape from its defaults (strict parse)
    const mk = (env: Record<string, string>) => parseWorkersConfig({ providers: { gyro: { ...mkProvider(9), env } } }).providers.gyro;
    // the cap reads from the main config's workers section (a fresh file per
    // value: readWorkersCached keys its cache on path+mtime)
    capConfig("cap64k", 65536);
    // Claude Code clamps anything below 100000 up to it (and warns): PAI never passes less
    expect(localCompactWindow(mk({}))).toBe(100000);
    // a provider entry above the cap is the model window, not an operator choice
    expect(localCompactWindow(mk({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" }))).toBe(100000);
    // no provider entry: the configured value alone
    expect(localCompactWindow(mk({}))).toBe(100000);
    // a small model window (apple-fm 8k) is lifted to the 100k minimum too
    expect(localCompactWindow(mk({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "8192" }))).toBe(100000);
    // a configured cap above the model window lets the model window stand
    capConfig("cap300k", 300000);
    expect(localCompactWindow(mk({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" }))).toBe(262144);
    // however small the configured cap, the value passed is never below 100000
    capConfig("cap1k", 1000);
    expect(localCompactWindow(mk({}))).toBe(100000);
    // a session cap override (session --local) is independent of the workers cap
    expect(localCompactWindow(mk({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" }), 131072)).toBe(131072);
  });

  it("print-cmd shows the configured cap under a provider's model window, and the configured value when set", async () => {
    const { parseWorkersConfig } = await import("../../workers/config.js");
    const { planLocalSession, localSessionPrintText } = await import("../commands/session.js");
    // gyro ships a 262144 model window in its provider env (the shipped providers.yaml form)
    const withWin = parseWorkersConfig({ providers: { gyro: { ...mkProvider(9), env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" } } } }).providers.gyro;
    // the cap rides from the main config's workers section (readWorkersCached),
    // not from parseWorkersConfig's arg
    capConfig("pcap64k", 65536);
    const ch = join(dir, "claude-home-win");
    mkdirSync(ch, { recursive: true });
    writeFileSync(join(ch, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" } }));
    setEnv("CLAUDE_CONFIG_DIR", ch);
    const cj = join(dir, `claude-win-${Date.now()}.json`);
    writeFileSync(cj, JSON.stringify({ mcpServers: { aibroker: { command: "echo" }, pai: { command: "echo" } } }));
    const opts = { workers: parseWorkersConfig({ providers: { gyro: withWin } }), logDir: join(dir, "logs-win"), sessionName: "win", check: async () => true, route: () => "http://127.0.0.1:65432", claudeJson: cj };
    // defaults: the session cap (262144) under the model window
    const p = await planLocalSession(opts);
    expect(p.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("262144");
    expect(localSessionPrintText(p)).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144");
    // the written slim settings carry it too (settings env outranks the process env)
    const s = JSON.parse(readFileSync(p.settingsFile!, "utf8")) as Record<string, any>;
    expect(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("262144");
    // an explicit session cap (--context) wins and print-cmd shows it; the workers cap is not involved
    const q = await planLocalSession({ ...opts, contextTokens: 100000 });
    expect(q.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
    expect(localSessionPrintText(q)).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000");
  });

  describe("local session: MCP, context, permissions, shortcuts", () => {
    async function plan(extra: Record<string, unknown> = {}, servers: string[] = ["aibroker", "pai", "todoist", "teams", "jobs"]) {
      const { parseWorkersConfig } = await import("../../workers/config.js");
      const { planLocalSession } = await import("../commands/session.js");
      const ch = join(dir, `ch-${Math.random().toString(36).slice(2)}`);
      mkdirSync(ch, { recursive: true });
      writeFileSync(join(ch, "settings.json"), JSON.stringify({ env: {} }));
      setEnv("CLAUDE_CONFIG_DIR", ch);
      const cj = join(dir, `cj-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(cj, JSON.stringify({ mcpServers: Object.fromEntries(servers.map((n) => [n, { command: "echo" }])) }));
      return planLocalSession({ workers: parseWorkersConfig({ providers: { gyro: mkProvider(9) } }), logDir: join(dir, "logs-x"), sessionName: "x", check: async () => true, route: () => "http://127.0.0.1:65432", claudeJson: cj, ...extra });
    }
    const mcpFile = (p: { mcpFile?: string }) => JSON.parse(readFileSync(p.mcpFile!, "utf8")).mcpServers as Record<string, { alwaysLoad: boolean }>;

    it("default loads all servers, deferred except aibroker+pai, tool search on", async () => {
      const p = await plan();
      expect(p.mcpLoaded.sort()).toEqual(["aibroker", "jobs", "pai", "teams", "todoist"]);
      expect(p.mcpDeferred.sort()).toEqual(["jobs", "teams", "todoist"]);
      expect(p.env.ENABLE_TOOL_SEARCH).toBe("true");
      const f = mcpFile(p);
      expect(f.aibroker.alwaysLoad).toBe(true);
      expect(f.pai.alwaysLoad).toBe(true);
      expect(f.todoist.alwaysLoad).toBe(false);
    });
    it("session carries the code-graph instruction and pai tools always-loaded", async () => {
      const p = await plan();
      const i = p.argv.indexOf("--append-system-prompt");
      expect(i).toBeGreaterThan(0);
      expect(p.argv[i + 1]).toContain("pai code explore");
      expect(p.argv[i + 1]).toContain("code_search");
      expect(p.mcpDeferred).not.toContain("pai");
      expect(mcpFile(p).pai.alwaysLoad).toBe(true);
    });
    it("--mcp lean = two servers; a list is honoured; unknown names fail", async () => {
      const lean = await plan({ mcp: "lean" });
      expect(lean.mcpLoaded).toEqual(["aibroker", "pai"]);
      expect(lean.mcpDeferred).toEqual([]);
      const some = await plan({ mcp: ["pai", "teams"] });
      expect(some.mcpLoaded).toEqual(["pai", "teams"]);
      expect(some.mcpDeferred).toEqual(["teams"]);
      await expect(plan({ mcp: ["nope"] })).rejects.toThrow(/unknown MCP server/);
      const { parseMcpSpec } = await import("../commands/session.js");
      expect(parseMcpSpec("a,b")).toEqual(["a", "b"]);
      expect(parseMcpSpec("lean")).toBe("lean");
      expect(parseMcpSpec(undefined)).toBe("all");
    });
    it("session.localMcp / session.localContextTokens come from the config", async () => {
      const f = join(dir, "sess.config.yaml");
      writeFileSync(f, "session:\n  localMcp: lean\n  localContextTokens: 150000\n");
      setEnv("PAI_CONFIG_FILE", f);
      const { readSessionLocalConfig } = await import("../commands/session.js");
      expect(readSessionLocalConfig(f)).toEqual({ contextTokens: 150000, mcp: "lean" });
      const g = join(dir, "sess2.config.yaml");
      writeFileSync(g, "session:\n  localContextTokens: 5000\n");
      expect(readSessionLocalConfig(g)).toEqual({ contextTokens: 100000, mcp: "all" });
    });
    it("--context parses n/128k/256k and refuses below 100000; the window is never below 100000", async () => {
      const { parseContextTokens } = await import("../commands/session.js");
      expect(parseContextTokens("128k")).toBe(131072);
      expect(parseContextTokens("256k")).toBe(262144);
      expect(parseContextTokens("200000")).toBe(200000);
      expect(() => parseContextTokens("64k")).toThrow(/100000/);
      expect((await plan({ contextTokens: 131072 })).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("131072");
      expect((await plan({ contextTokens: 1000 })).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
      const { parseWorkersConfig } = await import("../../workers/config.js");
      expect(parseWorkersConfig({}).localContextTokens).toBe(100000);
    });
    it("permissions are skipped by default; --ask-permissions keeps them; rest passes verbatim", async () => {
      const p = await plan({ rest: ["--continue", "-p", "hi"] });
      expect(p.argv).toContain("--dangerously-skip-permissions");
      expect(p.argv.slice(-3)).toEqual(["--continue", "-p", "hi"]);
      expect((await plan({ askPermissions: true })).argv).not.toContain("--dangerously-skip-permissions");
    });
    it("print-cmd lists loaded and deferred servers and the token estimate", async () => {
      const { localSessionPrintText } = await import("../commands/session.js");
      const t = localSessionPrintText(await plan());
      expect(t).toContain("mcp loaded (always): aibroker, pai");
      expect(t).toContain("mcp deferred (tool search): todoist, teams, jobs");
      expect(t).toMatch(/estimated start-up tool-definition tokens: ~\d+/);
    });
    it("pai local is a listed command; the group passes -- through; local is no session name", async () => {
      const { GROUPS } = await import("../registry.js");
      const { localTop, sessionCommand } = await import("../commands/session.js");
      expect(GROUPS.flatMap((g) => g.commands).map((c) => c.name)).toContain("local");
      expect(localTop.passthrough).toBe(true);
      expect(sessionCommand.passthrough).toBe(true);
      const { runRoot } = await import("../commands/root.js");
      await expect(runRoot({ name: "local", dryRun: true })).rejects.toThrow(/command, never a session name/);
      const { rootCommand } = await import("../commands/root.js");
      expect(rootCommand.options!.map((o) => o.name)).toContain("local");
    });
  });
});
