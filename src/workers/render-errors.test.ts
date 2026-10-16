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
