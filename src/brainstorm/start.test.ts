import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModeratorPrompt, buildParticipantPrompt, startBrainstorm, type SpawnFn } from "./start.js";
import { harvest } from "./harvest.js";
import { createBoard, post } from "./board.js";
import { brainstormCommand } from "../cli/commands/brainstorm.js";
import type { CommandDef, RunContext } from "../cli/define.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bs-test-"));
  process.env.PAI_BRAINSTORM_DIR = dir;
});
afterEach(() => {
  delete process.env.PAI_BRAINSTORM_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const deadlineMs = new Date(2026, 10, 27, 14, 35).getTime();

describe("prompts", () => {
  it("participant prompt carries id, loop, deadline, lens, never-stop rule", () => {
    const p = buildParticipantPrompt({ id: "bs-x", role: "p2", lens: "risk lens", goal: "G", context: ["/a/b.md"], deadlineMs });
    expect(p).toContain("pai brainstorm wait bs-x --since");
    expect(p).toContain("--as p2");
    expect(p).toContain("14:35");
    expect(p).toContain("risk lens");
    expect(p).toContain("/a/b.md");
    expect(p).toContain("FINAL:");
    expect(p).toMatch(/NEVER end your turn before the moderator's CLOSED/);
    expect(p).toContain("state=closed");
  });
  it("moderator prompt carries id, rounds, CLOSED shape and close-by time", () => {
    const m = buildModeratorPrompt({ id: "bs-x", goal: "G", participants: 3, lenses: ["a", "b", "c"], rounds: 2, context: [], deadlineMs, maxMinutes: 20 });
    expect(m).toContain("pai brainstorm wait bs-x --since");
    expect(m).toContain("14:35");
    expect(m).toContain("14:33");
    for (const s of ["CLOSED", "## Now", "## Next", "## Park", "## Disagreements", "## Participants' positions", "first step:", "owner:", "risks:", "ROUND k:"]) expect(m).toContain(s);
    expect(m).toContain("--as moderator");
  });
});

describe("startBrainstorm", () => {
  const run = async (local: boolean) => {
    const calls: string[][] = [];
    let n = 0;
    const spawn: SpawnFn = async (argv) => (calls.push(argv), { id: `w${++n}`, state: "running" });
    const r = await startBrainstorm({ goal: "G", participants: 2, local, caller: "sess" }, { spawn, root: dir });
    return { calls, r };
  };
  it("starts N+1 cloud workers with a spec each and records ids", async () => {
    const { calls, r } = await run(false);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c[c.indexOf("--where") + 1]).toBe("cloud");
      expect(c).toContain("--detach");
      expect(existsSync(c[c.indexOf("--spec") + 1])).toBe(true);
    }
    expect(calls[0][calls[0].indexOf("--max-minutes") + 1]).toBe("23");
    expect(calls[1][calls[1].indexOf("--max-minutes") + 1]).toBe("20");
    const meta = JSON.parse(readFileSync(join(r.dir, "meta.json"), "utf8"));
    expect(Object.keys(meta.workers).sort()).toEqual(["moderator", "p1", "p2"]);
    expect(meta.caller).toBe("sess");
    expect(r.id).toMatch(/^bs-\d{8}-\d{6}-[0-9a-f]{4}$/);
  });
  it("a half-started brainstorm stops the workers that did start", async () => {
    let n = 0;
    const spawn: SpawnFn = async (argv) => {
      if (argv.some((a) => a.endsWith(" moderator"))) throw new Error("moderator boom");
      return { id: `w${++n}`, state: "running" };
    };
    const killed: string[] = [];
    const kill = async (id: string) => void killed.push(id);
    await expect(startBrainstorm({ goal: "G", participants: 2 }, { spawn, kill, root: dir })).rejects.toThrow(
      /^brainstorm bs-\S+: 1 worker\(s\) did not start .*2 started worker\(s\) stopped/s,
    );
    expect(killed.sort()).toEqual(["w1", "w2"]);
  });
  it("--where local only with local", async () => {
    const { calls } = await run(true);
    for (const c of calls) expect(c[c.indexOf("--where") + 1]).toBe("local");
  });
});

describe("harvest", () => {
  it("writes result.md and notifies the caller", async () => {
    createBoard("b1", "the goal", Date.now() + 60000, dir);
    await (await import("node:fs/promises")).writeFile(join(dir, "b1", "meta.json"), JSON.stringify({ id: "b1", goal: "the goal", participants: 1, rounds: 2, caller: "sess", startedAt: "x", lenses: [] }));
    await post("b1", "p1", "opening", dir);
    await post("b1", "p1", "FINAL: do X", dir);
    await post("b1", "moderator", "CLOSED\n## Now\n1. do X -- first step: a", dir);
    const send = vi.fn(async () => {});
    const h = await harvest("b1", { send, root: dir });
    const md = readFileSync(h.path, "utf8");
    expect(md).toContain("the goal");
    expect(md).toContain("## Now");
    expect(md).not.toMatch(/^CLOSED/m);
    expect(md).toContain("## Attached: final positions");
    expect(md).toContain("do X");
    expect(send).toHaveBeenCalledOnce();
    expect(String((send.mock.calls[0] as unknown[])[1])).toContain("result.md");
  });
  it("a failing sender never fails harvest", async () => {
    createBoard("b2", "g", null, dir);
    await post("b2", "moderator", "CLOSED\n## Now\n1. a", dir);
    await (await import("node:fs/promises")).writeFile(join(dir, "b2", "meta.json"), JSON.stringify({ id: "b2", goal: "g", participants: 0, rounds: 1, caller: "s", startedAt: "x", lenses: [] }));
    const h = await harvest("b2", { send: async () => { throw new Error("boom"); }, root: dir });
    expect(h.notified).toBe(false);
    expect(existsSync(h.path)).toBe(true);
  });
});

describe("CLI group", () => {
  const sub = (name: string): CommandDef => brainstormCommand.subcommands!.find((s) => s.name === name)!;
  const ctx = (args: RunContext["args"], opts: RunContext["opts"] = {}): RunContext => ({ args, opts, dryRun: false, rest: [] });
  const capture = async (fn: () => Promise<number | void> | number | void) => {
    let buf = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => ((buf += s), true)) as never);
    try {
      return { rc: (await fn()) ?? 0, out: buf };
    } finally {
      spy.mockRestore();
    }
  };
  it("post, wait exit codes 0/3/4, show", async () => {
    createBoard("b3", "goal3", Date.now() + 60000, dir);
    let r = await capture(() => sub("post").run!(ctx({ ID: "b3", TEXT: "hello" }, { as: "p1" })));
    expect(r.out).toContain("posted #1");
    await capture(() => sub("post").run!(ctx({ ID: "b3", TEXT: "again" }, { as: "p2" })));
    r = await capture(() => sub("wait").run!(ctx({ ID: "b3" }, { since: 0 })));
    expect(r.rc).toBe(0);
    expect(r.out).toContain("-- board b3 last=2 state=new");
    r = await capture(() => sub("wait").run!(ctx({ ID: "b3" }, { since: 2, max: 0.3 })));
    expect(r.rc).toBe(3);
    expect(r.out).toContain("state=deadline");
    r = await capture(() => sub("post").run!(ctx({ ID: "b3", TEXT: "CLOSED\n## Now\n1. x" }, { as: "moderator" })));
    expect(existsSync(join(dir, "b3", "result.md"))).toBe(true);
    r = await capture(() => sub("wait").run!(ctx({ ID: "b3" }, { since: 3 })));
    expect(r.rc).toBe(4);
    expect(r.out).toContain("state=closed");
    await expect(sub("post").run!(ctx({ ID: "b3", TEXT: "late" }, { as: "p1" }))).rejects.toThrow(/closed/);
    r = await capture(() => sub("show").run!(ctx({ ID: "b3" }, { json: true })));
    expect(JSON.parse(r.out).state).toBe("closed");
    await expect(sub("wait").run!(ctx({ ID: "nope" }, {}))).rejects.toThrow(/no brainstorm board/);
  });
});
