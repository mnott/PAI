import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuild } from "./gate.js";
import { buildNext, enqueue, listBuilds, patchTicket, releaseBuildsOf } from "./queue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-builds-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = { pollMs: 20, heartbeatMs: 10_000, lowPriority: (c: string[]) => c, out: () => {}, callerGone: () => false };
const until = async (f: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("build queue", () => {
  it("runs two builds one after the other, FIFO", async () => {
    const a = runBuild({ ...base, dir, slots: 1, label: "A", command: ["sleep", "0.5"] });
    await until(async () => (await listBuilds(dir)).length === 1);
    const b = runBuild({ ...base, dir, slots: 1, label: "B", command: ["sleep", "0.1"] });
    await until(async () => (await listBuilds(dir)).length === 2);
    const q = await listBuilds(dir);
    expect(q.map((t) => `${t.label}:${t.state}`)).toEqual(["A:running", "B:waiting"]);
    expect(await a).toBe(0);
    await until(async () => (await listBuilds(dir)).some((t) => t.label === "B" && t.state === "running"));
    expect(await b).toBe(0);
    expect(await listBuilds(dir)).toEqual([]);
  });

  it("slots=2 runs two at once and queues the third", async () => {
    const ps = ["A", "B", "C"].map((label) => runBuild({ ...base, dir, slots: 2, label, command: ["sleep", "0.6"] }));
    await until(async () => (await listBuilds(dir)).length === 3);
    const q = await listBuilds(dir);
    expect(q.filter((t) => t.state === "running")).toHaveLength(2);
    expect(q.filter((t) => t.state === "waiting")).toHaveLength(1);
    expect(await Promise.all(ps)).toEqual([0, 0, 0]);
  });

  it("passes PAI_BUILD_MODE delta by default and full with --full", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((b: string | Uint8Array) => (lines.push(String(b)), true)) as typeof process.stdout.write;
    try {
      await runBuild({ ...base, dir, slots: 1, command: ["sh", "-c", "echo mode=$PAI_BUILD_MODE"] });
      await runBuild({ ...base, dir, slots: 1, full: true, command: ["sh", "-c", "echo mode=$PAI_BUILD_MODE"] });
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join("")).toContain("mode=delta");
    expect(lines.join("")).toContain("mode=full");
  });

  it("kills the build tree when the caller is gone", async () => {
    const r = runBuild({ ...base, dir, slots: 1, label: "L", command: ["sleep", "30"], callerGone: () => true });
    await until(async () => (await listBuilds(dir)).some((t) => !!t.pgid));
    const t = (await listBuilds(dir))[0];
    const code = await r;
    expect(code).toBe(129);
    await until(async () => !alive(t.pgid as number));
    expect(await listBuilds(dir)).toEqual([]);
  });

  it("prunes a dead gate's ticket and kills the tree it left", async () => {
    const dead = spawnSync("true");
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const t = await enqueue(dir, { pid: dead.pid ?? 999999, label: "X", session: "s", cmd: "sleep 30", mode: "delta" });
    await patchTicket(dir, t.id, { state: "running", pgid: orphan.pid });
    expect(alive(orphan.pid as number)).toBe(true);
    expect(await listBuilds(dir)).toEqual([]);
    await until(async () => !alive(orphan.pid as number));
  });

  it("next moves a waiting build to the front; a worker's builds are released", async () => {
    const me = process.pid;
    const a = await enqueue(dir, { pid: me, label: "A", session: "s", cmd: "a", mode: "delta" });
    const b = await enqueue(dir, { pid: me, label: "B", session: "s", cmd: "b", mode: "delta", worker: "w1" });
    const c = await enqueue(dir, { pid: me, label: "C", session: "s", cmd: "c", mode: "delta" });
    expect(await buildNext(dir, c.id)).toEqual([c.id, a.id, b.id]);
    expect(await releaseBuildsOf(dir, "w1", { kill: () => {} })).toEqual([b.id]);
    expect((await listBuilds(dir)).map((t) => t.id)).toEqual([c.id, a.id]);
  });
});
