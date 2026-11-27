import { describe, expect, it } from "vitest";
import { decidePlannerLockBash } from "./edit-gate.js";

const TOP = "/work/tree";
const allowed = (cmd: string) => decidePlannerLockBash(cmd, "/tmp/scratch", TOP, TOP).decision !== "block";

describe("decidePlannerLockBash: pai brainstorm", () => {
  it("allows wait", () => {
    expect(allowed("pai brainstorm wait 3 --since 2 --max 60")).toBe(true);
  });
  it("allows a moderator post", () => {
    expect(allowed('pai brainstorm post 3 "hello world" --as moderator')).toBe(true);
  });
  it("allows quotes and > inside the quoted text", () => {
    expect(allowed(`pai brainstorm post 3 "a > b and 'c' >> d" --as moderator`)).toBe(true);
    expect(allowed(`pai brainstorm post 3 'x > y' --as worker`)).toBe(true);
  });
  it("allows a post from a file", () => {
    expect(allowed('pai brainstorm post 3 --file "$TMPDIR/p.txt"')).toBe(true);
  });
  it("still blocks a real redirect into the worktree", () => {
    expect(allowed("pai brainstorm wait 3 > /work/tree/out.txt")).toBe(false);
  });
});
