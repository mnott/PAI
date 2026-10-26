/**
 * End-to-end test of the opencode engine through the worker run path: a fake
 * `opencode` executable on PATH replays the recorded fixture lines, and
 * executeOpencodeRun must produce the status (turns, tools, session, final
 * text), the events transcript and the WORKER-START/WORKER-END ledger lines —
 * the same shape a codex run leaves. No network, no real opencode.
 */

import { mkdtempSync, mkdirSync, chmodSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  runGates: vi.fn(),
  reapRunTree: vi.fn(async () => undefined),
}));

vi.mock("./gate.js", async (orig) => ({ ...(await orig<typeof import("./gate.js")>()), runGates: hoisted.runGates }));
vi.mock("./pane-handles.js", async (orig) => ({
  ...(await orig<typeof import("./pane-handles.js")>()),
  announcePane: vi.fn(async () => undefined),
  requireVisiblePane: vi.fn(async () => true),
}));
vi.mock("./lifecycle.js", () => ({ reapRunTree: hoisted.reapRunTree }));
vi.mock("../pane.js", async (orig) => ({
  ...(await orig<typeof import("../pane.js")>()),
  resolveHostSession: vi.fn(async () => ({ term: "test-term" })),
}));
vi.mock("../../builds/queue.js", async (orig) => ({
  ...(await orig<typeof import("../../builds/queue.js")>()),
  releaseBuildsOf: vi.fn(async () => []),
}));

import { executeOpencodeRun } from "./execute.js";
import { loadStatus } from "../status.js";
import { eventsPath, ledgerPath } from "../paths.js";
import type { OpencodeArgs } from "./types.js";

let root: string;
let logDir: string;
let binDir: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "oc-run-")));
  logDir = join(root, "logs");
  mkdirSync(logDir, { recursive: true });
  binDir = join(root, "bin");
  mkdirSync(binDir);
  hoisted.runGates.mockReset();
  hoisted.reapRunTree.mockClear();
  // the fake opencode dir leads PATH; a node_modules symlink lets the
  // scratch-dir module link work as in a real run
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  const modules = join(process.cwd(), "node_modules");
  try {
    require("node:fs").symlinkSync(modules, join(root, "node_modules"), "dir");
  } catch {
    /* no node_modules: the link is optional */
  }
  vi.spyOn(process, "exit").mockImplementation(((c?: number) => undefined as never) as never);
});
afterEach(() => {
  process.env.PATH = savedPath;
  vi.restoreAllMocks();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeAllListeners(sig);
  rmSync(root, { recursive: true, force: true });
});

/** A fake opencode on PATH: replays fixture lines, records its argv and env. */
function fakeOpencode(fixtureName: string): void {
  const fixture = readFileSync(join(__dirname, "..", "fixtures", fixtureName), "utf8");
  writeFileSync(join(root, "fixture.txt"), fixture, "utf8");
  writeFileSync(
    join(binDir, "opencode"),
    `#!/bin/sh\ncat "${join(root, "fixture.txt")}"\nprintf '%s\\n' "$@" > "${join(root, "argv.txt")}"\nenv > "${join(root, "env.txt")}"\n`,
    "utf8"
  );
  chmodSync(join(binDir, "opencode"), 0o755);
}

function args(): OpencodeArgs {
  return {
    config: { routing: {} },
    logDir,
    target: {
      providerName: "oc",
      provider: { enabled: true, protocol: "anthropic", baseUrl: "", keyFile: null, models: { default: "glm-5.3" }, env: {}, engine: "opencode" },
      via: "flag",
    },
    model: "glm-5.3",
    label: "oc-run",
    parsed: { headless: true, prompt: "do it", outputFormat: "text", allowedTools: [], mcp: [], rest: [], callerSystemPrompts: [] },
    claudeArgs: ["--allowedTools", "Read"],
    reroutes: 0,
    reportFormat: "json",
    limit: null,
    noBrowser: false,
    worktreeFlag: false,
    id: "w-oc",
    cwd: root,
    quiet: true,
  } as unknown as OpencodeArgs;
}

describe("executeOpencodeRun end-to-end (fake opencode replaying fixtures)", () => {
  it("tool-run fixture: counts rise, final text \"ok\", ok status, ledger lines, env carries no real key", async () => {
    fakeOpencode("opencode-tool-run.jsonl");
    const before = { turns: 0, tools: 0 };
    const rc = await executeOpencodeRun(args());
    expect(rc).toBe(0);
    const st = loadStatus(logDir, "w-oc");
    expect(st).not.toBeNull();
    expect(st!.state).toBe("done");
    expect(st!.turns).toBeGreaterThan(before.turns);
    expect(st!.tools).toBeGreaterThan(before.tools);
    expect(st!.turns).toBe(2);
    expect(st!.tools).toBe(1);
    expect(st!.claudeSession).toBe("ses_e8dd6eba5ffeRcl3iK0COoMY4F");
    expect(st!.last).toContain("ok");
    // the argv the fake saw: opencode run --format json --model pai/... -- -- prompt last
    const argv = readFileSync(join(root, "argv.txt"), "utf8").trim().split("\n");
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
    expect(argv).toContain("pai/glm-5.3");
    expect(argv).toContain("--auto");
    expect(argv).toContain("--pure");
    // the prompt after -- may itself carry "--" (the scratch-dir line), so
    // everything from -- onward is the prompt
    expect(argv[argv.indexOf("--")]).toBe("--");
    expect(argv.slice(argv.indexOf("--") + 1).join(" ")).toContain("do it");
    // the transcript: normalised assistant/tool events + the result event
    const events = readFileSync(eventsPath(logDir, "w-oc"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "system" && e.subtype === "init")).toBe(true);
    expect(events.some((e) => e.type === "assistant")).toBe(true);
    const result = events[events.length - 1] as { type: string; result: string; is_error: boolean; num_turns: number };
    expect(result.type).toBe("result");
    expect(result.result).toBe("ok");
    expect(result.is_error).toBe(false);
    expect(result.num_turns).toBe(2);
    // the ledger: WORKER-START with engine opencode, dropped-flag note, WORKER-END
    const ledger = readFileSync(ledgerPath(logDir), "utf8");
    expect(ledger).toContain("WORKER-START");
    expect(ledger).toContain("engine=opencode");
    expect(ledger).toContain("dropped for opencode: --allowedTools");
    expect(ledger).toContain("WORKER-END");
    // the env the fake saw: OPENCODE_CONFIG (whose file carries the router
    // prefix), XDG_DATA_HOME, no real key
    const env = readFileSync(join(root, "env.txt"), "utf8");
    const cfgPath = /OPENCODE_CONFIG=(.*)$/m.exec(env)![1]!;
    expect(readFileSync(cfgPath, "utf8")).toContain("/p/oc/v1");
    expect(env).toContain("XDG_DATA_HOME=");
    expect(env).toContain("PAI_WORKER=1");
    expect(env).not.toMatch(/OPENAI_API_KEY=/);
    expect(env).not.toMatch(/ANTHROPIC_API_KEY=/);
    expect(env).not.toMatch(/ANTHROPIC_AUTH_TOKEN=/);
  });

  it("error fixture: run ends failed with the error text in status.last", async () => {
    fakeOpencode("opencode-error.jsonl");
    const rc = await executeOpencodeRun(args());
    expect(rc).toBe(1); // the run returns 1 because the fold marked the failure
    const st = loadStatus(logDir, "w-oc");
    expect(st!.state).toBe("failed");
    // the error text reached the fold and the status
    expect(st!.last).toContain("Unexpected server error");
    const events = readFileSync(eventsPath(logDir, "w-oc"), "utf8");
    const result = JSON.parse(events.trim().split("\n").pop()!) as { is_error: boolean };
    expect(result.is_error).toBe(true);
    const ledger = readFileSync(ledgerPath(logDir), "utf8");
    expect(ledger).toContain("WORKER-END");
  });

  it("opencode missing from PATH ends failed (spawn error)", async () => {
    // PATH without the fake (and without the real CLI's dir): the spawn errors
    process.env.PATH = "/usr/bin:/bin";
    await expect(executeOpencodeRun({ ...args(), id: "w-oc2" } as OpencodeArgs)).rejects.toThrow();
    const st = loadStatus(logDir, "w-oc2");
    expect(st!.state).toBe("failed");
  });
});
