import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NATIVE_ANTHROPIC_MODELS } from "../../workers/config.js";
import { makeStyle } from "../help.js";
import { looksLikePath, prepareDir, resolveDir } from "../lib/new-dir.js";
import { builtinSetups } from "../lib/setups.js";
import { startSession, workerScope } from "./root.js";

const prov = (baseUrl: string, enabled = true) => ({ enabled, protocol: "anthropic" as const, baseUrl, keyFile: null, env: {}, models: { default: "m", fast: "f" } });
const cfg = {
  active: "glm",
  nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
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
  it("scopes local workers to the session, others stay global", () => {
    expect(workerScope(cfg, { name: "x", orchestrator: { provider: "anthropic" }, workers: "flashnext", kind: "builtin" })).toBe("session");
    expect(workerScope(cfg, { name: "x", orchestrator: { provider: "anthropic" }, workers: "glm", kind: "builtin" })).toBe("global");
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
    expect(text).toContain("PAI_SESSION_PROVIDER=flashnext");
    expect(text).not.toContain("Workers now run on");
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
