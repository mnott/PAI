/**
 * model-runtimes.test.ts — the configured runtime commands and the one-time
 * seed. Every case runs against a temp config.yaml via PAI_CONFIG_FILE (set
 * before daemon/config.ts is first imported) — never the live config. No real
 * model server is ever started: the shell run goes through injected deps.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { RuntimeCommands } from "./model-runtimes.js";

const savedConfigFile = process.env.PAI_CONFIG_FILE;
const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-model-rt-"));
  dirs.push(d);
  return d;
}

let readRuntimeCommands: typeof import("./model-runtimes.js")["readRuntimeCommands"];
let runRuntimeOp: typeof import("./model-runtimes.js")["runRuntimeOp"];
let runtimeOpArgv: typeof import("./model-runtimes.js")["runtimeOpArgv"];
let runtimeLogFile: typeof import("./model-runtimes.js")["runtimeLogFile"];
let readyIsUrl: typeof import("./model-runtimes.js")["readyIsUrl"];

beforeAll(async () => {
  process.env.HOME = newDir();
  const home = newDir();
  process.env.PAI_HOME = home;
  process.env.PAI_CONFIG_FILE = join(home, "config.yaml");
  writeFileSync(process.env.PAI_CONFIG_FILE, "{}\n");
  ({ readRuntimeCommands, runRuntimeOp, runtimeOpArgv, runtimeLogFile, readyIsUrl } = await import("./model-runtimes.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
});

const fakeDeps = (runs: string[], opts: { code?: number; readyOk?: boolean } = {}) => ({
  runShell: async (cmd: string) => {
    runs.push(cmd);
    return { code: opts.code ?? 0 };
  },
  getUrl: async () => opts.readyOk ?? true,
  runCmd: async () => (opts.readyOk ?? true ? 0 : 1),
  now: (() => { let t = 0; return () => (t += 1000); })(),
  sleep: async () => undefined,
});

describe("models.runtimes config", () => {
  it("reads the block from the config; a runtime without commands is absent", () => {
    const cfg = join(newDir(), "config.yaml");
    writeFileSync(cfg, "models:\n  runtimes:\n    ollama:\n      start: ollama serve\n      stop: kill\n      ready: http://127.0.0.1:11434/api/tags\n      note: PAI embedding\n    strata-box: {}\n");
    const cmds = readRuntimeCommands(cfg);
    expect(cmds.ollama).toEqual({ start: "ollama serve", stop: "kill", ready: "http://127.0.0.1:11434/api/tags", note: "PAI embedding" });
    expect(cmds["strata-box"]).toBeUndefined();
    // a missing user file still resolves the shipped defaults, never {}
    const fromDefaults = readRuntimeCommands(join(newDir(), "missing.yaml"));
    expect(fromDefaults.ollama?.start).toBe("ollama serve");
    expect(fromDefaults["docker-model-runner"]?.start).toBe("docker model run");
  });

  it("the log file is <PAI home>/logs/local/<runtime>.log", () => {
    expect(runtimeLogFile("/h", "ollama")).toBe(join("/h", "logs", "local", "ollama.log"));
  });

  it("a docker model command gets the --model value appended once", () => {
    expect(runtimeOpArgv("docker model run", "e5")).toEqual(["docker", "model", "run", "e5"]);
    expect(runtimeOpArgv("docker model unload e5", "e5")).toEqual(["docker", "model", "unload", "e5"]);
    expect(runtimeOpArgv("ollama serve", undefined)).toEqual(["ollama", "serve"]);
    expect(runtimeOpArgv("ollama serve", "x")).toEqual(["ollama", "serve"]);
  });

  it("ready: a URL is polled as a URL, a command as a command", async () => {
    const urls: string[] = [];
    const cmds: string[] = [];
    const deps = { runShell: async () => ({ code: 0 }), getUrl: async (u: string) => { urls.push(u); return true; }, runCmd: async (c: string) => { cmds.push(c); return 0; }, now: () => 0, sleep: async () => undefined };
    expect(readyIsUrl("http://x")).toBe(true);
    expect(readyIsUrl("docker model status")).toBe(false);
    const { waitReady } = await import("./model-runtimes.js");
    expect(await waitReady("http://127.0.0.1:11434/api/tags", deps)).toBe(true);
    expect(urls).toEqual(["http://127.0.0.1:11434/api/tags"]);
    expect(await waitReady("docker model status", deps)).toBe(true);
    expect(cmds).toEqual(["docker model status"]);
    // never ready: false at the deadline, no endless poll (a clock that advances per sleep)
    let t = 0;
    const never = { ...deps, getUrl: async () => false, now: () => t, sleep: async () => { t += 1000; } };
    expect(await waitReady("http://x", never, 3000, 1000)).toBe(false);
  });
});

describe("runRuntimeOp", () => {
  it("start runs the configured command, waits for ready, answers ok", async () => {
    const runs: string[] = [];
    const home = newDir();
    const r = await runRuntimeOp("ollama", "start", { ollama: { start: "ollama serve", ready: "http://127.0.0.1:11434/api/tags" } }, fakeDeps(runs), home);
    expect(r.ok).toBe(true);
    expect(runs).toEqual(["ollama serve"]);
    expect(r.message).toContain("ollama up");
  });

  it("stop runs the stop command; a failing start reports the log path", async () => {
    const runs: string[] = [];
    const home = newDir();
    const r = await runRuntimeOp("docker-model-runner", "stop", { "docker-model-runner": { stop: "docker model unload" } }, fakeDeps(runs), home);
    expect(r.ok).toBe(true);
    expect(runs).toEqual(["docker model unload"]);
    const bad = await runRuntimeOp("ollama", "start", { ollama: { start: "ollama serve" } }, fakeDeps(runs, { code: 3 }), home);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("exited (3)");
    expect(bad.message).toContain(join(home, "logs", "local", "ollama.log"));
  });

  it("an unconfigured runtime or op refuses without running anything", async () => {
    const runs: string[] = [];
    const r = await runRuntimeOp("strata-box", "start", { ollama: { start: "ollama serve" } }, fakeDeps(runs), newDir());
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no start command configured for strata-box");
    const r2 = await runRuntimeOp("ollama", "stop", { ollama: { start: "ollama serve" } }, fakeDeps(runs), newDir());
    expect(r2.ok).toBe(false);
    expect(runs).toEqual([]);
  });
});

describe("models.runtimes shipped defaults (temp dirs only, never a user write)", () => {
  const DEFAULTS = join(process.cwd(), "src", "config", "defaults", "config.yaml");

  it("the seed lives in the shipped defaults, not in code", () => {
    const block = (parse(readFileSync(DEFAULTS, "utf8")).models as { runtimes: Record<string, RuntimeCommands> }).runtimes;
    expect(block.ollama).toEqual({
      start: "ollama serve",
      stop: "kill $(lsof -nP -iTCP:11434 -sTCP:LISTEN -t)",
      ready: "http://127.0.0.1:11434/api/tags",
      note: "PAI's embedding backend runs here",
    });
    expect(block["docker-model-runner"]).toEqual({
      start: "docker model run",
      stop: "docker model unload",
      ready: "docker model status",
      note: "idle loads a model on the first request",
    });
  });

  it("a fresh config resolves models.runtimes.ollama.start from the defaults without writing the user file", async () => {
    const home = newDir();
    const cfg = join(home, "config.yaml");
    const saved = { home: process.env.PAI_HOME, cfgFile: process.env.PAI_CONFIG_FILE };
    process.env.PAI_HOME = home;
    process.env.PAI_CONFIG_FILE = cfg;
    try {
      const { effectiveMainConfig } = await import("../config/shipped-defaults.js");
      const merged = effectiveMainConfig(cfg) as { models?: { runtimes?: Record<string, RuntimeCommands> } };
      expect(merged.models?.runtimes?.ollama?.start).toBe("ollama serve");
      expect(merged.models?.runtimes?.ollama?.note).toBe("PAI's embedding backend runs here");
      expect(existsSync(cfg)).toBe(false);
    } finally {
      process.env.PAI_HOME = saved.home;
      if (saved.cfgFile === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = saved.cfgFile;
    }
  });

  it("a user entry wins over the shipped defaults", async () => {
    const home = newDir();
    const cfg = join(home, "config.yaml");
    writeFileSync(cfg, "models:\n  runtimes:\n    ollama:\n      start: my-own-start\n");
    const saved = { home: process.env.PAI_HOME, cfgFile: process.env.PAI_CONFIG_FILE };
    process.env.PAI_HOME = home;
    process.env.PAI_CONFIG_FILE = cfg;
    try {
      const { effectiveMainConfig } = await import("../config/shipped-defaults.js");
      const merged = effectiveMainConfig(cfg) as { models?: { runtimes?: Record<string, RuntimeCommands> } };
      expect(merged.models?.runtimes?.ollama?.start).toBe("my-own-start");
      // the defaults' other keys of the same entry stay unless the user replaces them
      expect(merged.models?.runtimes?.ollama?.ready).toBe("http://127.0.0.1:11434/api/tags");
      expect(merged.models?.runtimes?.["docker-model-runner"]?.start).toBe("docker model run");
    } finally {
      process.env.PAI_HOME = saved.home;
      if (saved.cfgFile === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = saved.cfgFile;
    }
  });
});
