import { describe, it, expect } from "vitest";
import { renderEvent, makeColor } from "./render.js";

const ev = (text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", is_error: true, tool_use_id: "t1", content: text }] },
});

describe("renderEvent tool_result errors", () => {
  const c = makeColor(true);
  const render = (t: string) => renderEvent(c, "", ev(t) as never, "/w", {}).join("\n");

  it("hook denial is amber", () => {
    const o = render("PreToolUse:Read hook error: [x.mjs]: outside working directory");
    expect(o).toContain("\x1b[33m!");
    expect(o).not.toContain("\x1b[31m");
  });
  it("' blocked:' guard is amber", () => {
    expect(render("Bash blocked: rm -rf")).toContain("\x1b[33m!");
  });
  it("real error is red", () => {
    const o = render("Exit code 1\ncommand not found");
    expect(o).toContain("\x1b[31m!");
  });
});

describe("renderEvent wait poll exit 3", () => {
  const c = makeColor(true);
  const run = (tool: string, text: string) =>
    renderEvent(c, "", ev(text) as never, "/w", { t1: tool }).join("\n");
  it("wait --max exit 3 is a neutral line", () => {
    const o = run("Bash:wait", 'Exit code 3\n{"id":"x","state":"running"}\npai worker wait: still running: x');
    expect(o).toContain("still running, waiting again");
    expect(o).not.toContain("!");
    expect(o).not.toContain("\x1b[31m");
  });
  it("wait exit 1 stays an error", () => {
    expect(run("Bash:wait", "Exit code 1\npai worker wait: failed: x")).toContain("\x1b[31m!");
  });
  it("other Bash exit 3 stays an error", () => {
    expect(run("Bash", "Exit code 3\nboom")).toContain("\x1b[31m!");
  });
});

describe("renderEvent terminal text is plain, never HTML-escaped", () => {
  const c = makeColor(false);
  const tool = (name: string, input: unknown) =>
    renderEvent(
      c,
      "",
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] } } as never,
      "/w",
      {}
    ).join("\n");

  it("a Bash command keeps && > < and 2>/dev/null", () => {
    expect(tool("Bash", { command: "ls && git log 2>/dev/null | wc -l < in" })).toBe(
      "$ ls && git log 2>/dev/null | wc -l < in"
    );
  });

  it("the '> Reading' line keeps its >", () => {
    expect(tool("Read", { file_path: "/w/src/a.ts" })).toBe("> Reading src/a.ts");
  });
});
