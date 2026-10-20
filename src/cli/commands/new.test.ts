import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeAnthropicModels } from "../../workers/config.js";
import { makeStyle } from "../help.js";
import { looksLikePath, prepareDir, resolveDir } from "../lib/new-dir.js";
import { builtinSetups } from "../lib/setups.js";
import { startSession } from "./root.js";

const prov = (baseUrl: string, enabled = true) => ({ enabled, protocol: "anthropic" as const, baseUrl, keyFile: null, env: {}, models: { default: "m", fast: "f" } });
const cfg = {
  active: "glm",
  nativeModels: { ...nativeAnthropicModels() },
  providers: {
    glm: prov("https://glm.invalid"),
    flashnext: prov("http://127.0.0.1:8080"),
    "local-off": prov("http://localhost:9000", false),
    remote: prov("https://remote.invalid"),
  },
  routing: { budgetWalls: {} } as never,
};

describe("local worker setups", () => {
  const names = builtinSetups(cfg).map((s) => s.name);
  it("adds one 'anthropic + local workers' row for the running loopback provider only", () => {
    expect(names).toContain("anthropic + local workers");
    expect(names).not.toContain("anthropic + local-off workers");
    expect(names).not.toContain("anthropic + remote workers");
  });
  it("never adds '<local> only'", () => {
    expect(names).not.toContain("flashnext only");
    expect(names).toContain("glm only");
  });
  it("orchestrator is anthropic, workers the local provider", () => {
    const s = builtinSetups(cfg).find((x) => x.name === "anthropic + local workers")!;
    expect(s.orchestrator.provider).toBe("anthropic");
    expect(s.workers).toBe("flashnext");
  });
});

describe("path-like arguments", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pai-new-"))));
  it("recognises ./ ../ / ~ and existing folders, not bare names", () => {
    for (const a of ["./x", "../x", "/x", "~", "~/code/app"]) expect(looksLikePath(a, dir)).toBe(true);
    expect(looksLikePath("webseiten", dir)).toBe(false);
    mkdirSync(join(dir, "real"));
    expect(looksLikePath("real", dir)).toBe(true);
  });
  it("expands ~", () => {
    expect(resolveDir("~/code/app")).toMatch(/code\/app$/);
    expect(resolveDir("~/code/app").startsWith("~")).toBe(false);
  });
});

describe("pai new", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-new-"));
    saved = process.env.PAI_HOME;
    process.env.PAI_HOME = join(dir, "pai-home");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = saved;
  });

  it("creates a missing folder and registers it", async () => {
    const target = join(dir, "a", "app");
    const registered: string[] = [];
    const lines: string[] = [];
    const got = await prepareDir(target, { dryRun: false, out: (s) => lines.push(s), register: async (d) => void registered.push(d) });
    expect(got).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(registered).toEqual([target]);
    expect(lines.join("\n")).toContain("Created");
  });

  it("dry run neither creates nor registers", async () => {
    const target = join(dir, "dry");
    const registered: string[] = [];
    await prepareDir(target, { dryRun: true, out: () => {}, register: async (d) => void registered.push(d) });
    expect(existsSync(target)).toBe(false);
    expect(registered).toEqual([]);
  });

  it("refuses a file", async () => {
    const f = join(dir, "file");
    writeFileSync(f, "x");
    await expect(prepareDir(f, { dryRun: false, out: () => {}, register: async () => {} })).rejects.toThrow(/not a folder/);
  });

  it("a local setup applies the session-scoped worker provider and leaves the global one alone", async () => {
    const written: string[] = [];
    const term = { input: {} as never, output: { write: (s: string) => (written.push(s), true) } as never, isTTY: false, st: makeStyle(false) };
    const setup = builtinSetups(cfg).find((s) => s.name === "anthropic + local workers")!;
    const code = await startSession({ workers: { ...cfg, logDir: join(dir, "logs") } as never, setup, name: "app", cwd: dir, dryRun: true, term });
    const text = written.join("");
    expect(code).toBe(0);
    expect(text).toContain("flashnext for this session only");
    expect(text).toContain("PAI_SESSION_WORKER_PROVIDER=flashnext");
    expect(text).toContain("PAI_SESSION_PROVIDER=anthropic");
    expect(text).not.toContain("Workers now run on");
  });

  it("a remote setup (anthropic + glm workers) sets the session worker provider and never writes the global workers.yaml", async () => {
    const yaml = join(dir, "workers.yaml");
    writeFileSync(yaml, "active: glm\n");
    const before = readFileSync(yaml, "utf8");
    const savedYaml = process.env.PAI_WORKERS_YAML;
    process.env.PAI_WORKERS_YAML = yaml;
    try {
      const written: string[] = [];
      const term = { input: {} as never, output: { write: (s: string) => (written.push(s), true) } as never, isTTY: false, st: makeStyle(false) };
      const other = { ...cfg, active: "remote" };
      const setup = builtinSetups(other).find((s) => s.name === "anthropic + glm workers")!;
      await startSession({ workers: { ...other, logDir: join(dir, "logs") } as never, setup, name: "app", cwd: dir, dryRun: true, term });
      const text = written.join("");
      expect(text).toContain("PAI_SESSION_WORKER_PROVIDER=glm");
      expect(text).toContain("PAI_SESSION_PROVIDER=anthropic");
      expect(readFileSync(yaml, "utf8")).toBe(before);
    } finally {
      if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
      else process.env.PAI_WORKERS_YAML = savedYaml;
    }
  });
});

describe("pai <path> routes to new", () => {
  it("a path argument starts a new session in that folder instead of searching names", async () => {
    const { runRoot } = await import("./root.js");
    const dir = mkdtempSync(join(tmpdir(), "pai-route-"));
    const saved = process.env.PAI_HOME;
    process.env.PAI_HOME = join(dir, "pai-home");
    const written: string[] = [];
    try {
      const term = { input: {} as never, output: { write: (s: string) => (written.push(s), true) } as never, isTTY: false, st: makeStyle(false) };
      const code = await runRoot({ name: join(dir, "fresh"), with: "anthropic only", dryRun: true }, term);
      expect(code).toBe(0);
      expect(written.join("")).toContain("would create and register");
      expect(written.join("")).toContain('Starting "fresh"');
      expect(existsSync(join(dir, "fresh"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.PAI_HOME;
      else process.env.PAI_HOME = saved;
    }
  });
});

describe("setup orchestrator model", () => {
  it("built-in anthropic rows show opus as orchestrator", () => {
    const rows = builtinSetups(cfg).filter((s) => s.orchestrator.provider === "anthropic");
    expect(rows.length).toBeGreaterThan(1);
    for (const s of rows) expect(s.orchestrator.model).toBe("opus");
  });
  it("launching 'anthropic + glm workers' starts claude on opus and exports the glm worker provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-new-"));
    const written: string[] = [];
    const term = { input: {} as never, output: { write: (s: string) => (written.push(s), true) } as never, isTTY: false, st: makeStyle(false) };
    const setup = builtinSetups(cfg).find((s) => s.name === "anthropic + glm workers")!;
    await startSession({ workers: { ...cfg, logDir: join(dir, "logs") } as never, setup, name: "app", cwd: dir, dryRun: true, term });
    const text = written.join("");
    expect(text).toMatch(/--model opus/);
    expect(text).toContain("opus (anthropic)");
    expect(text).toContain("PAI_SESSION_WORKER_PROVIDER=glm");
  });
});
