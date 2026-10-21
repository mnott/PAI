import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPoolPolicy, PoolRefusedError, tryPoolRun } from "./run.js";
import { runChain } from "./chain.js";
import { rerunOnCloud } from "./run/escalate.js";
import { workerArgs } from "./plan-deps.js";
import { workerRunShape } from "../daemon-mcp/tools/worker-run-args.js";
import { z } from "zod";
import { skipReasonLine } from "./pool-cli.js";
import { ledgerPath } from "./paths.js";

vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});

const servers: Server[] = [];
beforeEach(() => {
  for (const k of ["PAI_WORKER", "PAI_WORKER_PROVIDER", "PAI_SESSION_PROVIDER", "PAI_WORKER_AUTOPANE", "PAI_WORKER_ALLOW_HIDDEN"]) vi.stubEnv(k, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const parsedOf = (over: Record<string, unknown> = {}) => ({
  headless: true,
  prompt: "hi",
  callerSystemPrompt: false,
  callerMcpConfig: false,
  mcp: [],
  allowedTools: [],
  outputFormat: "json",
  ...over,
});

const args = (logDir: string, over: Record<string, unknown> = {}, pool: Record<string, unknown> = {}) =>
  ({
    config: { panes: { required: false }, pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 1, spares: 1, continuation: false, ...pool } },
    logDir,
    quiet: true,
    id: "w-sk",
    noPane: true,
    label: "x",
    model: "m",
    cwd: tmpdir(),
    worktreeFlag: false,
    reportFormat: "ag2",
    noBrowser: true,
    target: { providerName: "glm", provider: { models: { default: "m" } } },
    parsed: parsedOf(),
    opts: {},
    ...over,
  }) as never;

const skipLines = (d: string): string[] =>
  readFileSync(ledgerPath(d), "utf8").split("\n").filter((l) => l.includes("WORKER-POOL-SKIP"));

const dir = () => mkdtempSync(join(tmpdir(), "pai-skip-"));

describe("every non-pooled path records exactly one skip line", () => {
  const cases: Array<[string, string, (d: string) => never]> = [
    ["pool-off", "pool-off", (d) => args(d, {}, { enabled: false })],
    ["orchestrate", "orchestrate", (d) => args(d, { orchestrate: true })],
    ["spares-off", "spares-off", (d) => args(d, {}, { spares: 0 })],
    ["opted-out", "opted-out", (d) => args(d, { opts: { noPool: true } })],
    ["interactive", "interactive", (d) => args(d, { parsed: parsedOf({ headless: false, prompt: null }) })],
    ["tools", "tools", (d) => args(d, { parsed: parsedOf({ allowedTools: ["Read,Grep"] }) })],
    ["mcp", "mcp", (d) => args(d, { mcpFlag: "pai" })],
    ["resume", "resume", (d) => args(d, { resumeOf: "w0" })],
    ["print-cmd", "print-cmd", (d) => args(d, { printCmd: true })],
    ["engine", "engine", (d) => args(d, { target: { providerName: "cx", provider: { models: {}, engine: "codex" } } })],
    ["worktree", "worktree", (d) => args(d, { worktreeFlag: true }, { continuation: true })],
    ["unreachable", "unreachable", (d) => args(d)],
  ];
  for (const [name, reason, make] of cases) {
    it(name, async () => {
      const d = dir();
      expect(await tryPoolRun(make(d))).toBeNull();
      const lines = skipLines(d);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`reason=${reason}`);
      expect(lines[0]).toContain("id=w-sk");
    });
  }

  it("tools skip carries the grant", async () => {
    const d = dir();
    await tryPoolRun(args(d, { parsed: parsedOf({ allowedTools: ["Read,Grep"] }) }));
    expect(skipLines(d)[0]).toContain("grant=Read,Grep");
  });

  it("claim miss: host reason, key, one skip line", async () => {
    const d = dir();
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ pooled: false, reason: "no-spare" })));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    expect(await tryPoolRun(args(d, {}, { port }))).toBeNull();
    const lines = skipLines(d);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=no-spare");
    expect(lines[0]).toContain("key=glm/m");
  });

  it("claim error (connection cut after connect) is recorded as claim-error, not host-unreachable", async () => {
    const d = dir();
    const server = createServer((req) => {
      req.resume();
      req.socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    expect(await tryPoolRun(args(d, {}, { port }))).toBeNull();
    const lines = skipLines(d);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=claim-error");
  });

  it("stderr line is printed for a silent case too", async () => {
    const d = dir();
    const w = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await tryPoolRun(args(d, { quiet: false }, { enabled: false }));
    const out = w.mock.calls.map((c) => String(c[0])).join("");
    w.mockRestore();
    expect(out).toContain("pool: not pooled (pool-off)");
  });
});

describe("every headless start refuses caller-caused reasons unless noPool", () => {
  const strict = (over: Record<string, unknown>, noPool = false) =>
    args(dir(), { opts: { ...(noPool ? { noPool: true } : {}) }, ...over });
  const caller: Array<[string, Record<string, unknown>]> = [
    ["tools", { parsed: parsedOf({ allowedTools: ["Read,Edit,Write,Bash,Grep,Glob,WebFetch"] }) }],
    ["mcp", { mcpFlag: "pai" }],
    ["mcp grant", { parsed: parsedOf({ allowedTools: ["mcp__pai__x"] }) }],
    ["system-prompt", { parsed: parsedOf({ callerSystemPrompt: true }) }],
    ["stream-json", { parsed: parsedOf({ outputFormat: "stream-json" }) }],
    ["browser", { noBrowser: false, parsed: parsedOf({ allowedTools: ["mcp__claude-in-chrome__tabs"] }) }],
  ];
  for (const [name, over] of caller) {
    it(`${name}: refused, allowed with --no-pool`, () => {
      expect(() => assertPoolPolicy(strict(over))).toThrow(PoolRefusedError);
      expect(() => assertPoolPolicy(strict(over, true))).not.toThrow();
    });
  }

  it("tools message names the fix", () => {
    expect(() => assertPoolPolicy(strict(caller[0]![1]))).toThrow(/grant adds WebFetch\); use the slot set Read,Edit,Write,Bash,Grep,Glob or pass --no-pool/);
  });

  const free: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ["pool off", { parsed: parsedOf({ allowedTools: ["Read"] }) }, { enabled: false }],
    ["interactive", { parsed: parsedOf({ headless: false, prompt: null }) }],
    ["resume", { resumeOf: "w0" }],
    ["worktree", { worktreeFlag: true }],
    ["native", { target: { providerName: "anthropic", provider: { models: {}, native: true } } }, { native: false }],
    ["engine", { target: { providerName: "cx", provider: { models: {}, engine: "codex" } } }],
    ["no spare", {}],
  ];
  for (const [name, over, pool] of free) {
    it(`${name}: never refused`, () => {
      expect(() => assertPoolPolicy(args(dir(), { opts: {}, ...over }, pool ?? {}))).not.toThrow();
    });
  }

  it("a start that is not headless or only prints its command is never refused", () => {
    const over = { mcpFlag: "pai" };
    expect(() => assertPoolPolicy(args(dir(), { ...over, printCmd: true }))).not.toThrow();
    expect(() => assertPoolPolicy(args(dir(), { ...over, parsed: parsedOf({ headless: false, prompt: null }) }))).not.toThrow();
  });
});

describe("noPool is threaded through every entry point", () => {
  const chainOpts = (extra: Record<string, unknown>) => ({ stages: ["implement"], brief: "b", claudeArgs: ["-p", "b"], ...extra }) as never;
  const seen = async (extra: Record<string, unknown>) => {
    const got: Array<boolean | undefined> = [];
    await runChain(chainOpts(extra), { logDir: dir(), runStage: async (o) => (got.push(o.noPool), 0) });
    return got;
  };

  it("chain stages carry noPool, and omit it by default", async () => {
    expect(await seen({ noPool: true })).toEqual([true]);
    expect(await seen({})).toEqual([undefined]);
  });

  it("MCP worker_run schema takes an optional no_pool boolean", () => {
    const schema = z.object(workerRunShape);
    expect(schema.parse({ label: "l", prompt: "p", no_pool: true }).no_pool).toBe(true);
    expect(schema.parse({ label: "l", prompt: "p" }).no_pool).toBeUndefined();
  });

  it("plan and queue workers start with --no-pool when the run has it", () => {
    const base = { label: "l", provider: "p", tier: "local" };
    expect(workerArgs({ ...base, noPool: true } as never, "s", "r")).toContain("--no-pool");
    expect(workerArgs(base as never, "s", "r")).not.toContain("--no-pool");
  });

  it("the cloud fall-through rerun inherits the original run's noPool", async () => {
    for (const noPool of [true, undefined]) {
      let got: boolean | undefined = false as boolean | undefined;
      const a = {
        logDir: dir(), noPane: true, label: "x", route: { policy: "p" }, opts: { noPool }, claudeArgs: ["-p", "x"],
        target: { providerName: "glm" }, runner: async (o: { noPool?: boolean }) => ((got = o.noPool), 0),
      };
      await rerunOnCloud(a as never, "w1", "why", { fallThroughTo: undefined } as never);
      expect(got).toBe(noPool);
    }
  });
});

describe("skipReasonLine", () => {
  it("counts reasons in the window, most frequent first", () => {
    const now = new Date("2026-10-21T12:00:00").getTime();
    const text = [
      "2026-10-21 10:00:00 WORKER-POOL-SKIP id=a provider=glm reason=tools",
      "2026-10-21 10:01:00 WORKER-POOL-SKIP id=b provider=glm reason=tools",
      "2026-10-21 10:02:00 WORKER-POOL-SKIP id=c provider=glm reason=mcp",
      "2026-10-18 10:02:00 WORKER-POOL-SKIP id=d provider=glm reason=old",
    ].join("\n");
    expect(skipReasonLine(text, now)).toBe("not pooled · 24 h: tools 2, mcp 1");
    expect(skipReasonLine("", now)).toBe("");
  });
});
