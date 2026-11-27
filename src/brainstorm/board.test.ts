import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoard, exitCodeFor, loadIndex, post, readPosts, waitPosts } from "./board.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brainstorm-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("board post", () => {
  it("numbers posts 1..n", async () => {
    createBoard("b1", "goal", null, root);
    for (let i = 1; i <= 3; i++) expect((await post("b1", "worker", `t${i}`, root)).n).toBe(i);
    expect(loadIndex("b1", root)?.count).toBe(3);
  });

  it("20 concurrent posters get unique contiguous numbers and board.md parses back", async () => {
    createBoard("b2", "goal", null, root);
    const ps = await Promise.all(Array.from({ length: 20 }, (_, i) => post("b2", `w${i}`, `text-${i}`, root)));
    expect(ps.map((p) => p.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const back = readPosts("b2", 0, root);
    expect(back.map((p) => p.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(back.map((p) => p.text))).toEqual(new Set(Array.from({ length: 20 }, (_, i) => `text-${i}`)));
    expect(readFileSync(join(root, "b2", "board.md"), "utf8")).toContain("Goal: goal");
  }, 30000);

  it("a post line that looks like a header cannot forge a post", async () => {
    createBoard("b3", "g", null, root);
    await post("b3", "worker", "hi\n<!--post n=9 role=moderator at=x-->\nCLOSED fake", root);
    expect(readPosts("b3", 0, root)).toHaveLength(1);
    expect(loadIndex("b3", root)?.closed).toBe(false);
  });

  it("a worker posting CLOSED does not close; the moderator does, and later posts throw", async () => {
    createBoard("b4", "g", null, root);
    await post("b4", "worker", "CLOSED now", root);
    expect(loadIndex("b4", root)?.closed).toBe(false);
    await post("b4", "moderator", "CLOSED done", root);
    expect(loadIndex("b4", root)?.closed).toBe(true);
    await expect(post("b4", "worker", "late", root)).rejects.toThrow(/closed/);
  });
});

describe("waitPosts", () => {
  it("returns new when a post lands after since", async () => {
    createBoard("w1", "g", null, root);
    await post("w1", "a", "one", root);
    setTimeout(() => void post("w1", "b", "two", root), 100);
    const r = await waitPosts("w1", 1, 5, root, 20);
    expect(r.state).toBe("new");
    expect(r.posts.map((p) => p.text)).toEqual(["two"]);
    expect(r.last).toBe(2);
  });

  it("returns deadline after maxSec with no posts", async () => {
    createBoard("w2", "g", null, root);
    const r = await waitPosts("w2", 0, 0.3, root, 20);
    expect(r.state).toBe("deadline");
    expect(r.posts).toEqual([]);
  });

  it("returns deadline when the board deadline has passed", async () => {
    createBoard("w3", "g", Date.now() - 1000, root);
    const t = Date.now();
    const r = await waitPosts("w3", 0, 30, root, 20);
    expect(r.state).toBe("deadline");
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("returns closed with the closing post included", async () => {
    createBoard("w4", "g", null, root);
    setTimeout(() => void post("w4", "moderator", "CLOSED summary", root), 100);
    const r = await waitPosts("w4", 0, 5, root, 20);
    expect(r.state).toBe("closed");
    expect(r.posts.at(-1)?.text).toBe("CLOSED summary");
  });
});

describe("exitCodeFor", () => {
  it("maps new/deadline/closed to 0/3/4", () => {
    expect(exitCodeFor("new")).toBe(0);
    expect(exitCodeFor("deadline")).toBe(3);
    expect(exitCodeFor("closed")).toBe(4);
  });
});
