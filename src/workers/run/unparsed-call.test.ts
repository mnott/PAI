import { describe, expect, it, vi } from "vitest";
import { unparsedToolCall, unparsedCallPrompt } from "./unparsed-call.js";
import { reaskAg2Report } from "./finalise.js";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn: vi.fn() }));

describe("unparsedToolCall", () => {
  it("qwen3-coder form", () => {
    const t = "Files written.\n<tool_call>\n<function=Bash>\n<parameter=command>\nls run\n</parameter>\n</function>\n</tool_call>";
    expect(unparsedToolCall(t)).toBe("Bash");
  });
  it("anthropic xml forms", () => {
    expect(unparsedToolCall('ok\n<function_calls>\n<invoke name="Grep">\n<parameter name="pattern">x</parameter>\n</invoke>\n</function_calls>')).toBe("Grep");
    expect(unparsedToolCall('<invoke name="Bash"><parameter name="command">ls</parameter></invoke>')).toBe("Bash");
  });
  it("json name+arguments on the last lines", () => {
    expect(unparsedToolCall('Next:\n{"name": "Bash",\n "arguments": {"command": "ls"}}')).toBe("Bash");
  });
  it("negatives", () => {
    expect(unparsedToolCall("R\nr=+\nz=done")).toBeNull();
    expect(unparsedToolCall(undefined)).toBeNull();
    expect(unparsedToolCall("Example:\n```\n<tool_call>\n<function=Bash>\n</function>\n</tool_call>\n```\nThat is the form.")).toBeNull();
    expect(unparsedToolCall("Use <tool_call> tags like <function=Bash> in prose, then more text after.")).toBeNull();
    expect(unparsedToolCall('The config {"name": "x", "other": 1} is fine')).toBeNull();
  });
});

describe("continuation", () => {
  it("one resume with the tool name and allowed tools", async () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.kill = vi.fn();
    vi.mocked(childProcess.spawn).mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);
    const prompt = unparsedCallPrompt("Bash", "Read, Write");
    const p = reaskAg2Report({ env: {}, cwd: "/w", model: "m", callerPinnedModel: true, chromeArgs: [], mcpArgs: [], toolArgs: [], toolsFlag: [], sessionId: "s1", prompt });
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(childProcess.spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf("--resume") + 1]).toBe("s1");
    const sent = args[args.indexOf("-p") + 1];
    expect(sent).toContain("call to the tool Bash");
    expect(sent).toContain("Available tools: Read, Write.");
    proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "R\nr=+" })));
    proc.emit("close", 0);
    expect(await p).toBe("R\nr=+");
  });
});
