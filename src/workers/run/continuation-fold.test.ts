import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ spawnOwned: vi.fn(), reask: vi.fn() }));

vi.mock("./pane-handles.js", async (orig) => ({
  ...(await orig<typeof import("./pane-handles.js")>()),
  spawnOwned: hoisted.spawnOwned,
  announcePane: vi.fn(async () => undefined),
  requireVisiblePane: vi.fn(async () => true),
}));
vi.mock("./gate.js", async (orig) => ({ ...(await orig<typeof import("./gate.js")>()), runGates: vi.fn(async () => undefined) }));
vi.mock("./lifecycle.js", () => ({ reapRunTree: vi.fn(async () => undefined) }));
vi.mock("./finalise.js", async (orig) => ({ ...(await orig<typeof import("./finalise.js")>()), reaskAg2Report: hoisted.reask }));
vi.mock("./unparsed-call.js", async (orig) => ({
  ...(await orig<typeof import("./unparsed-call.js")>()),
  unparsedCallDecision: () => ({ name: "Bash", mode: "enforce", version: 1 }),
}));
vi.mock("../pane.js", async (orig) => ({ ...(await orig<typeof import("../pane.js")>()), resolveHostSession: vi.fn(async () => ({ term: "t" })) }));
vi.mock("../../builds/queue.js", async (orig) => ({ ...(await orig<typeof import("../../builds/queue.js")>()), releaseBuildsOf: vi.fn(async () => []) }));

import { foldRun } from "./execute-fold.js";
import { newRunState, type PreparedRun } from "./execute-prepare.js";
import { loadStatus } from "../status.js";
import type { ExecuteArgs, StreamEvent } from "./types.js";

let root: string;
let logDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "contfold-")));
  logDir = join(root, "logs");
  mkdirSync(logDir, { recursive: true });
  hoisted.spawnOwned.mockReset();
  hoisted.reask.mockReset();
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeAllListeners(sig);
  rmSync(root, { recursive: true, force: true });
});

const assistant = (name: string): StreamEvent =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id: `id-${name}`, name: "Write", input: { file_path: `/w/${name}` } }] } }) as unknown as StreamEvent;

describe("unparsed-call continuation", () => {
  it("its stream events reach status and the worker jsonl", async () => {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { pid: 999999, kill: vi.fn(), stdin: new PassThrough(), stdout, stderr: null });
    hoisted.spawnOwned.mockResolvedValue(proc);
    const seen: { turns: number; tools: number; last: string }[] = [];
    hoisted.reask.mockImplementation(async (a: { onEvent: (e: StreamEvent) => void }) => {
      for (const n of ["a", "b", "c"]) {
        a.onEvent(assistant(n));
        const st = loadStatus(logDir, "w-cf");
        seen.push({ turns: st?.turns ?? -1, tools: st?.tools ?? -1, last: st?.last ?? "" });
      }
      a.onEvent({ type: "result", result: "R\nr=+" } as StreamEvent);
      return "R\nr=+\nz=done";
    });
    const args = {
      config: { routing: {}, unparsedCallContinuations: 1 },
      logDir,
      target: { providerName: "stub", provider: {}, via: "flag" },
      model: "m",
      label: "cf",
      parsed: { headless: true, prompt: "go", outputFormat: "text", allowedTools: [], mcp: [], rest: [], callerSystemPrompts: [] },
      claudeArgs: [],
      reroutes: 0,
      reportFormat: "ag2",
      limit: null,
      noBrowser: false,
      opts: {},
    } as unknown as ExecuteArgs;
    const prep = {
      headless: true, wid: "w-cf", adopted: null, cwd: root, term: "t", paneVerified: false, session: null, sessionKey: undefined,
      spawnerSession: null, worktree: null, preamble: null, addendum: null, trailerApplied: false, env: {}, claudeCmd: ["claude"],
      cmd: ["claude"], chromeArgs: [], mcpArgs: [], toolArgs: [], toolsFlag: [], slimArgs: [], promptText: null, state: newRunState(),
    } as unknown as PreparedRun;
    const run = foldRun(args, prep);
    await new Promise((r) => setTimeout(r, 30));
    stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n");
    stdout.write(JSON.stringify({ type: "result", result: "<tool_call>\n<function=Bash>\n</function>\n</tool_call>" }) + "\n");
    await new Promise((r) => setTimeout(r, 30));
    stdout.end();
    proc.emit("close", 0);
    await run;
    expect(hoisted.reask.mock.calls[0][0].onEvent).toBeTypeOf("function");
    expect(seen.map((s) => s.turns)).toEqual([1, 2, 3]);
    expect(seen.map((s) => s.tools)).toEqual([1, 2, 3]);
    expect(seen[2].last).toContain("c");
    const events = readFileSync(join(logDir, "w-cf.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "assistant")).toHaveLength(3);
  });
});
