import { describe, it, expect } from "vitest";
import { evaluate } from "../../../guard/evaluate.js";
import { emptyLoopState, recordLoopResult, type LoopState } from "./loop-guard.js";
import { failLedgerOn, ledgerNote } from "./fail-ledger.js";

const cwd = process.cwd();

/** One tool call the way the hooks run it: Pre (evaluate) then Post (recordLoopResult). */
function run(state: LoopState, tool: string, input: Record<string, unknown>, response: unknown, ledger = true): LoopState {
  const d = evaluate({ kind: "tool_call", tool, input, cwd }, { env: {}, record: () => undefined, loop: { state, now: 1, failLedger: ledger } });
  const cmd = tool === "Bash" ? (input.command as string) : undefined;
  return recordLoopResult(d.loop!.state, tool, cmd ?? input, response, 1, ledger);
}

const fail = (msg: string) => `Exit code 1\n${msg}`;
const entries = (s: LoopState) => s.fail?.entries ?? [];

describe("fail ledger", () => {
  it("is off by default and records nothing", () => {
    let s = emptyLoopState();
    s = run(s, "Bash", { command: "npm test" }, fail("Error: boom"), false);
    s = run(s, "Bash", { command: "npm test" }, fail("Error: boom"), false);
    s = run(s, "Read", { file_path: "/nonexistent/zz.ts" }, "", false);
    expect(s.fail).toBeUndefined();
    expect(failLedgerOn({}, { enabled: false, maxEntries: 5 })).toBeUndefined();
    expect(failLedgerOn({}, undefined)).toBeUndefined();
  });

  it("PAI_FAIL_LEDGER overrides the config either way", () => {
    expect(failLedgerOn({ PAI_FAIL_LEDGER: "1" }, { enabled: false, maxEntries: 3 })).toEqual({ enabled: true, maxEntries: 3 });
    expect(failLedgerOn({ PAI_FAIL_LEDGER: "1" })).toEqual({ enabled: true, maxEntries: 5 });
    expect(failLedgerOn({ PAI_FAIL_LEDGER: "0" }, { enabled: true, maxEntries: 5 })).toBeUndefined();
  });

  it("records a repeated Bash failure only on the second identical failure", () => {
    let s = run(emptyLoopState(), "Bash", { command: "npm test" }, fail("Error: boom"));
    expect(entries(s)).toEqual([]);
    s = run(s, "Bash", { command: "npm test" }, fail("Error: boom"));
    expect(entries(s)).toEqual([expect.objectContaining({ kind: "repeat-failure", scope: "npm test", turn: 2, evidence: "exit 1: Error: boom" })]);
  });

  it("does not record a different error line, or a failure after a success", () => {
    let s = run(emptyLoopState(), "Bash", { command: "npm test" }, fail("Error: boom"));
    s = run(s, "Bash", { command: "npm test" }, fail("Error: other"));
    s = run(s, "Bash", { command: "npm test" }, "ok");
    s = run(s, "Bash", { command: "npm test" }, fail("Error: other"));
    expect(entries(s)).toEqual([]);
  });

  it("records a Read and a Glob of a nonexistent path, with evidence capped", () => {
    let s = run(emptyLoopState(), "Read", { file_path: "/nonexistent/zz.ts" }, "");
    s = run(s, "Glob", { pattern: "*.ts", path: "/nonexistent/dir" }, "");
    expect(entries(s).map((e) => [e.kind, e.scope, e.turn])).toEqual([
      ["missing-path", "/nonexistent/zz.ts", 1],
      ["missing-path", "/nonexistent/dir", 2],
    ]);
    const long = run(emptyLoopState(), "Bash", { command: "x" }, fail(`Error: ${"y".repeat(400)}`));
    const again = run(long, "Bash", { command: "x" }, fail(`Error: ${"y".repeat(400)}`));
    expect(entries(again)[0].evidence.length).toBeLessThanOrEqual(160);
  });

  it("records a Write that restores a file version a run failed with", () => {
    const w = (content: string) => ({ file_path: "out/a.py", content });
    let s = run(emptyLoopState(), "Write", w("v1\n"), "ok");
    s = run(s, "Bash", { command: "pytest" }, fail("AssertionError: v1"));
    s = run(s, "Write", w("v2\n"), "ok");
    expect(entries(s)).toEqual([]);
    s = run(s, "Write", w("v1\n"), "ok");
    expect(entries(s)).toEqual([expect.objectContaining({ kind: "restored-failing-version", scope: "out/a.py" })]);
  });

  it("does not flag a restore when no run failed with that version", () => {
    const w = (content: string) => ({ file_path: "out/b.py", content });
    let s = run(emptyLoopState(), "Write", w("v1\n"), "ok");
    s = run(s, "Write", w("v2\n"), "ok");
    s = run(s, "Write", w("v1\n"), "ok");
    expect(entries(s)).toEqual([]);
  });

  it("injects the last N entries, masked, only in the turn that added one", () => {
    let s = emptyLoopState();
    for (let i = 0; i < 7; i++) s = run(s, "Read", { file_path: `/nonexistent/f${i}.ts` }, "");
    const n = ledgerNote(s, 5)!;
    expect(n.note.startsWith("Already failed in this run (do not repeat):")).toBe(true);
    expect(n.note.split("\n").length).toBe(6);
    expect(n.note).toContain("f6.ts");
    expect(n.note).not.toContain("f1.ts");
    // shown once: no second block for the same turn
    expect(ledgerNote(n.state, 5)).toBeUndefined();
    // a turn without a new entry: nothing
    const quiet = run(n.state, "Bash", { command: "ls" }, "a b");
    expect(ledgerNote(quiet, 5)).toBeUndefined();
  });

  it("masks secrets in the block", () => {
    let s = run(emptyLoopState(), "Bash", { command: "curl x" }, fail("Error: API_KEY=sk-abcdefghijklmnop1234567890 rejected"));
    s = run(s, "Bash", { command: "curl x" }, fail("Error: API_KEY=sk-abcdefghijklmnop1234567890 rejected"));
    expect(ledgerNote(s, 5)!.note).not.toContain("abcdefghijklmnop1234567890");
  });
});
