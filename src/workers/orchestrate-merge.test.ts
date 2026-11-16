import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { announceLeader, closeQueue, joinQueue, joinRepoQueue, mergeNotice, mergedBrief, waitLeaderId, type MergeRequest } from "./orchestrate-merge.js";

const req = (label: string, at: number, prompt = `do ${label}`): MergeRequest => ({ pid: 1, label, prompt, at });

describe("joinQueue", () => {
  it("the first request leads, a second inside the window follows as part 2", () => {
    const a = joinQueue(null, "/r", req("a", 1000), 20);
    expect(a.role).toBe("leader");
    const b = joinQueue(a.queue, "/r", req("b", 15_000), 20);
    expect(b).toMatchObject({ role: "follower", part: 2 });
    expect(b.queue.requests.map((r) => r.label)).toEqual(["a", "b"]);
  });

  it("a request after the window, or after the queue closed, starts its own job", () => {
    const a = joinQueue(null, "/r", req("a", 0), 20);
    expect(joinQueue(a.queue, "/r", req("late", 20_000), 20).role).toBe("leader");
    expect(joinQueue({ ...a.queue, closed: true }, "/r", req("b", 5000), 20).role).toBe("leader");
  });
});

describe("mergedBrief", () => {
  it("one request is unchanged", () => {
    expect(mergedBrief([req("a", 0, "P1")])).toEqual({ prompt: "P1", label: "a" });
  });

  it("two requests become numbered parts in one brief", () => {
    const m = mergedBrief([req("fix x", 0, "Fix x"), req("fix y", 1, "Fix y")]);
    expect(m.prompt).toContain("2 numbered parts");
    expect(m.prompt).toContain("## Part 1: fix x\n\nFix x");
    expect(m.prompt).toContain("## Part 2: fix y\n\nFix y");
    expect(m.label).toBe("2 parts: fix x + fix y");
    expect(mergeNotice([req("fix x", 0), req("fix y", 1)])).toContain("part 2 = fix y");
  });
});

describe("repo queue on disk", () => {
  it("same repo merges, another repo does not, a closed queue restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omerge-"));
    const a = await joinRepoQueue(dir, "/repo1", req("a", Date.now()), 20);
    const b = await joinRepoQueue(dir, "/repo1", req("b", Date.now()), 20);
    const other = await joinRepoQueue(dir, "/repo2", req("c", Date.now()), 20);
    expect([a.role, b.role, other.role]).toEqual(["leader", "follower", "leader"]);
    await announceLeader(dir, "/repo1", "w-1");
    expect(await waitLeaderId(dir, "/repo1", 1000)).toBe("w-1");
    expect((await closeQueue(dir, "/repo1")).map((r) => r.label)).toEqual(["a", "b"]);
    expect((await joinRepoQueue(dir, "/repo1", req("d", Date.now()), 20)).role).toBe("leader");
  });
});
