import { GUARD_MARKER } from "./render-decision.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareToolName, renderRepair, repairToolName, reportToolDenial, renderToolDenial, repairParams, inventedToolDirective, renderParamRepair } from "./tool-name-repair.js";

const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => ({ tool_name, tool_input });

describe("repairToolName", () => {
  it("DottedNameRepaired: Glob.glob → Glob", () => {
    const r = repairToolName(call("Glob.glob", { pattern: "**/*log*" }), W)!;
    expect(r.new).toBe("Glob");
    expect(r.old).toBe("Glob.glob");
    expect(r.updatedInput).toEqual({ pattern: "**/*log*" });
  });

  it("DoubleNameRepaired: Bash.Bash → Bash", () => {
    expect(repairToolName(call("Bash.Bash", { command: "ls" }), W)?.new).toBe("Bash");
  });

  it("repairs the lower-cased Read.read too", () => {
    expect(repairToolName(call("Read.read", { file_path: "/x" }), W)?.new).toBe("Read");
    expect(repairToolName(call("Write.write"), W)?.new).toBe("Write");
    expect(repairToolName(call("Grep.grep"), W)?.new).toBe("Grep");
  });

  it("UnknownSuffixUntouched: foo.bar stays untouched", () => {
    expect(repairToolName(call("foo.bar"), W)).toBeNull();
  });

  it("only the last segment counts, and only for known tools", () => {
    expect(repairToolName(call("Glob.files"), W)).toBeNull();
    expect(repairToolName(call("Task.task"), W)).toBeNull();
    expect(bareToolName("Glob.glob")).toBe("Glob");
    expect(bareToolName("x.y.Bash")).toBe("Bash");
    expect(bareToolName("Bash")).toBeNull();
    expect(bareToolName(".Bash")).toBeNull();
    expect(bareToolName("Bash.")).toBeNull();
    expect(bareToolName("")).toBeNull();
  });

  it("NonWorkerUntouched: interactive sessions stay untouched", () => {
    expect(repairToolName(call("Glob.glob"), {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("a bare name and a missing input pass through", () => {
    expect(repairToolName(call("Glob"), W)).toBeNull();
    const r = repairToolName({ tool_name: "Bash.Bash" }, W)!;
    expect(r.updatedInput).toEqual({});
  });
});

describe("renderRepair", () => {
  it("allows the call with the input kept and names both forms", () => {
    const out = JSON.parse(renderRepair(repairToolName(call("Glob.glob", { pattern: "a*" }), W)!));
    expect(out.systemMessage).toContain("Glob.glob → Glob");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({ pattern: "a*" });
    expect(out.hookSpecificOutput.additionalContext).toContain("never Glob.glob");
  });
});

describe("reportToolDenial", () => {
  it("R denied for worker", () => {
    expect(reportToolDenial(call("R"), W)).toBe("write your R report as plain text in your final answer, not as a tool call");
  });

  it("functions.R denied for worker", () => {
    expect(reportToolDenial(call("functions.R"), W)).toBe("write your R report as plain text in your final answer, not as a tool call");
  });

  it("R not denied when PAI_WORKER unset", () => {
    expect(reportToolDenial(call("R"), {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("R not denied for tool names Read, Bash, Grep", () => {
    expect(reportToolDenial(call("Read"), W)).toBeNull();
    expect(reportToolDenial(call("Bash"), W)).toBeNull();
    expect(reportToolDenial(call("Grep"), W)).toBeNull();
  });
});

describe("renderToolDenial", () => {
  it("renderToolDenial output parses as JSON and contains the reason", () => {
    const denial = "write your R report as plain text in your final answer, not as a tool call";
    const output = renderToolDenial(denial);
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(GUARD_MARKER + denial);
  });
});

describe("repairParams", () => {
  it("Read path→file_path", () => {
    const r = repairParams({ tool_name: "Read", tool_input: { path: "/x" } }, W)!;
    expect(r.updatedInput).toEqual({ file_path: "/x" });
  });

  it("Edit filePath→file_path keeping other keys", () => {
    const r = repairParams({ tool_name: "Edit", tool_input: { filePath: "/x", old_string: "old" } }, W)!;
    expect(r.updatedInput).toEqual({ file_path: "/x", old_string: "old" });
    expect(r.old).toBe("Edit(filePath→file_path)");
    expect(r.new).toBe("Edit(file_path)");
  });

  it("Write file→file_path", () => {
    const r = repairParams({ tool_name: "Write", tool_input: { file: "/x" } }, W)!;
    expect(r.updatedInput).toEqual({ file_path: "/x" });
  });

  it("Bash cmd→command", () => {
    const r = repairParams({ tool_name: "Bash", tool_input: { cmd: "ls" } }, W)!;
    expect(r.updatedInput).toEqual({ command: "ls" });
  });

  it("Grep regex→pattern", () => {
    const r = repairParams({ tool_name: "Grep", tool_input: { regex: "pattern" } }, W)!;
    expect(r.updatedInput).toEqual({ pattern: "pattern" });
  });

  it("Read with both path and file_path keeps file_path and returns null", () => {
    const r = repairParams({ tool_name: "Read", tool_input: { path: "/x", file_path: "/y" } }, W);
    expect(r).toBeNull();
  });

  it("Read with file_path only returns null", () => {
    const r = repairParams({ tool_name: "Read", tool_input: { file_path: "/x" } }, W);
    expect(r).toBeNull();
  });

  it("non-worker env ({}) returns null", () => {
    expect(repairParams({ tool_name: "Read", tool_input: { path: "/x" } }, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("unknown tool Glob with { path: \"x\" } returns null", () => {
    expect(repairParams({ tool_name: "Glob", tool_input: { path: "x" } }, W)).toBeNull();
  });
});

describe("renderParamRepair", () => {
  it("renders the param repair correctly", () => {
    const r = repairParams({ tool_name: "Read", tool_input: { path: "/x" } }, W)!;
    const output = renderParamRepair(r);
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.updatedInput).toEqual({ file_path: "/x" });
  });
});

describe("inventedToolDirective", () => {
  it("Git gives a string containing \"Bash\"", () => {
    const r = inventedToolDirective({ tool_name: "Git" }, W)!;
    expect(r).toContain("Bash");
  });

  it("R and functions.R give the R directive", () => {
    const r1 = inventedToolDirective({ tool_name: "R" }, W)!;
    expect(r1).toBe("write your R report as plain text in your final answer, not as a tool call");
    const r2 = inventedToolDirective({ tool_name: "functions.R" }, W)!;
    expect(r2).toBe("write your R report as plain text in your final answer, not as a tool call");
  });

  it("Read gives null", () => {
    expect(inventedToolDirective({ tool_name: "Read" }, W)).toBeNull();
  });

  it("non-worker gives null", () => {
    expect(inventedToolDirective({ tool_name: "Git" }, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

// The entrypoint does only I/O around the pure rule — run it as a real
// subprocess with its own piped stdin and a temp HOME so the repair log never
// lands in the real ~/.claude (same shape as whisper-reinject.test.ts).
describe("pre-tool-use/worker-tool-name-repair entrypoint", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/worker-tool-name-repair.ts";
  let home: string;

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function runHook(input: object, env: NodeJS.ProcessEnv = {}): string {
    home = mkdtempSync(join(tmpdir(), "tool-name-repair-test-"));
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15_000,
      // This suite may itself run inside a worker — clear the guard so the
      // unguarded cases do not silently exercise the guarded path.
      env: { ...process.env, PAI_WORKER: "", HOME: home, ...env },
    });
  }

  it("rewrites a dotted name end-to-end and logs one line", () => {
    const stdout = runHook(
      { tool_name: "Glob.glob", cwd: "/tmp/w", tool_input: { pattern: "**/*" } },
      { PAI_WORKER: "1", PAI_WORKER_ID: "20261016-000000-00000" },
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("allow");
    expect(out.updatedInput).toEqual({ pattern: "**/*" });

    const log = join(home, ".claude", "pai", "logs", "workers", "tool-repair.log");
    expect(existsSync(log)).toBe(true);
    const line = readFileSync(log, "utf8").trimEnd().split("\n").pop()!;
    expect(line).toContain("worker=20261016-000000-00000");
    expect(line.endsWith("Glob.glob\tGlob")).toBe(true);
  });

  it("stays silent for a bare name, an unknown suffix and outside a worker", () => {
    for (const [input, env] of [
      [{ tool_name: "Glob", tool_input: {} }, { PAI_WORKER: "1" }],
      [{ tool_name: "foo.bar" }, { PAI_WORKER: "1" }],
      [{ tool_name: "Glob.glob" }, {}],
    ] as Array<[object, NodeJS.ProcessEnv]>) {
      expect(runHook(input, env)).toBe("");
      expect(existsSync(join(home, ".claude"))).toBe(false);
    }
  });

  it("maps Read path to file_path end-to-end and logs a [model] line", () => {
    const stdout = runHook(
      { tool_name: "Read", cwd: "/tmp/w", tool_input: { path: "/x" } },
      { PAI_WORKER: "1", PAI_WORKER_ID: "w1" },
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("allow");
    expect(out.updatedInput).toEqual({ file_path: "/x" });

    const log = join(home, ".claude", "pai", "logs", "workers", "tool-repair.log");
    expect(existsSync(log)).toBe(true);
    const line = readFileSync(log, "utf8").trimEnd().split("\n").pop()!;
    expect(line).toContain("[model]");
    expect(line).toContain("param alias");
  });

  it("answers an invented Git tool with a Bash directive", () => {
    const stdout = runHook(
      { tool_name: "Git", tool_input: {} },
      { PAI_WORKER: "1" },
    );
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("Bash");
  });

  it("stays silent for correct parameters", () => {
    const stdout = runHook(
      { tool_name: "Read", tool_input: { file_path: "/x" } },
      { PAI_WORKER: "1" },
    );
    expect(stdout).toBe("");
  });
});
