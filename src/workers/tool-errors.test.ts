import { describe, expect, it } from "vitest";
import { classifyToolError, harnessEvidence, lastCommand, type ToolErrorRecord } from "./tool-errors.js";

const rec = (over: Partial<ToolErrorRecord>): ToolErrorRecord => ({
  ts: 0,
  worker: "w1",
  provider: "gyro-l",
  label: "test",
  tool: "Bash",
  signature: "s",
  raw: "",
  ...over,
});

describe("lastCommand", () => {
  it("strips quoted spans", () => {
    expect(lastCommand(`echo "a | b" && grep 'x;y' f`)).toMatchObject({ name: "grep", compound: true });
  });
  it("is linear on a 200 KB command with a heredoc and an unmatched quote", () => {
    const cmd = `python3 - <<'PY'\n${"print(\"it's\")\n".repeat(8000)}PY\necho "oops ${"x \\\" ' ".repeat(25000)}`;
    expect(cmd.length).toBeGreaterThan(200_000);
    const t = Date.now();
    lastCommand(cmd);
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe("worker mistakes are never harness", () => {
  // 2026-11-19 01:18 worker 20261118-232451-28562: its own tsc error was labelled
  // "[harness] configuration file parsing error in worker script".
  it("a tsc error in the worker's own file is model", () => {
    const c = classifyToolError(
      rec({ raw: "src/workers/render.ts(597,39): error TS18047: 'l' is possibly 'null'.", input: "npx tsc --noEmit" })
    );
    expect(c.cls).toBe("model");
    expect(harnessEvidence("src/workers/render.ts(597,39): error TS18047: 'l' is possibly 'null'.")).toBe(false);
  });
  // 2026-11-19 02:17 worker 20261119-012354-92712: its own broken perl regex.
  it("a syntax error in the worker's own one-off command is model", () => {
    const c = classifyToolError(rec({ raw: "Unmatched ) in regex; marked by <-- HERE in m/( )/ at -e line 1.", input: "perl -pe 's/(foo)/'" }));
    expect(c.cls).toBe("model");
  });
  it("a python or node one-off that fails to parse is model", () => {
    expect(classifyToolError(rec({ raw: "SyntaxError: invalid syntax. Perhaps you forgot a comma?", input: "python3 -c 'print(1'" })).cls).toBe("model");
    expect(classifyToolError(rec({ raw: "SyntaxError: Unexpected token ')'", input: "node -e 'function f() {'" })).cls).toBe("model");
  });
  it("No such file for a path the worker invented is model", () => {
    expect(classifyToolError(rec({ raw: "python3: can't open file '/Users/x/probe.py': [Errno 2] No such file or directory", input: "python3 probe.py" })).cls).toBe("model");
    expect(classifyToolError(rec({ tool: "Bash", raw: "/bin/sh: ./scripts/x.sh: No such file or directory", input: "./scripts/x.sh" })).cls).toBe("model");
  });
  it("String to replace not found is model", () => {
    expect(classifyToolError(rec({ tool: "Edit", raw: "String to replace not found in file." })).cls).toBe("model");
  });
});

describe("harnessEvidence", () => {
  // A real harness sample: a PAI guard message carries the marker and may be called harness.
  it("matches a PAI guard deny", () => {
    expect(harnessEvidence("PAI guard: sleep-poll gate: foreground sleep blocked")).toBe(true);
  });
  it("matches pai CLI failures, the loop guard and stack frames in PAI's own code", () => {
    expect(harnessEvidence("pai: unexpected failure: invalid byte sequence for encoding \"UTF8\": 0x00")).toBe(true);
    expect(harnessEvidence("loop guard: same command repeated without a change")).toBe(true);
    expect(harnessEvidence("TypeError: x is not a function\n    at tick (/Users/x/dev/ai/PAI/src/daemon/supervise.ts:12:3)")).toBe(true);
  });
  it("does not match a worker's own error text", () => {
    expect(harnessEvidence("Unmatched ) in regex; marked by <-- HERE in m/( )/ at -e line 1.")).toBe(false);
    expect(harnessEvidence("src/workers/render.ts(597,39): error TS18047: 'l' is possibly 'null'.")).toBe(false);
  });
});
