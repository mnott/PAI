import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJobs, deriveKey, runBuild } from "./gate.js";
import { listBuilds, renderBuildQueue } from "./queue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-keys-"));
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

describe("build keys", () => {
  it("serialises same-key jobs while another key runs, and the slot limit holds", async () => {
    const A1 = runBuild({ ...base, dir, slots: 3, key: "a", label: "A1", command: ["sleep", "0.6"] });
    await until(async () => (await listBuilds(dir)).length === 1);
    const A2 = runBuild({ ...base, dir, slots: 3, key: "a", label: "A2", command: ["sleep", "0.1"] });
    await until(async () => (await listBuilds(dir)).length === 2);
    const B = runBuild({ ...base, dir, slots: 3, key: "b", label: "B", command: ["sleep", "0.6"] });
    await until(async () => (await listBuilds(dir)).length === 3);
    await new Promise((r) => setTimeout(r, 150));
    const q = await listBuilds(dir);
    expect(q.map((t) => `${t.label}:${t.state}`)).toEqual(["A1:running", "B:running", "A2:waiting"]);
    const text = renderBuildQueue(q, { build: 3, test: 2 });
    expect(text).toContain("A1 [a]");
    expect(text).toContain("waiting A2 [a]");
    expect(text).toContain("same key as A1");
    expect(await Promise.all([A1, A2, B])).toEqual([0, 0, 0]);
  });

  it("a key-blocked waiter does not hold a free slot from a later different-key job", async () => {
    const A1 = runBuild({ ...base, dir, slots: 2, key: "a", label: "A1", command: ["sleep", "0.6"] });
    await until(async () => (await listBuilds(dir)).length === 1);
    const A2 = runBuild({ ...base, dir, slots: 2, key: "a", label: "A2", command: ["sleep", "0.1"] });
    await until(async () => (await listBuilds(dir)).length === 2);
    const B = runBuild({ ...base, dir, slots: 2, key: "b", label: "B", command: ["sleep", "0.1"] });
    await until(async () => (await listBuilds(dir)).some((t) => t.label === "B" && t.state === "running"));
    expect((await listBuilds(dir)).find((t) => t.label === "A2")?.state).toBe("waiting");
    await Promise.all([A1, A2, B]);
  });

  it("computes PAI_BUILD_JOBS and passes it to the child", async () => {
    expect(buildJobs(18, 3)).toBe(6);
    expect(buildJobs(4, 3)).toBe(2);
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((b: string | Uint8Array) => (lines.push(String(b)), true)) as typeof process.stdout.write;
    try {
      await runBuild({ ...base, dir, slots: 3, cores: 18, env: { ...process.env, PAI_BUILD_JOBS: "" }, command: ["sh", "-c", "echo jobs=$PAI_BUILD_JOBS"] });
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join("")).toContain("jobs=6");
  });

  it("derives a key from door + last argument; explicit key and env win", () => {
    expect(deriveKey(["tools/build.sh", "test", "mac"], "/x/CaseLeaf")).toBe("/x/CaseLeaf:tools/build.sh:mac");
    expect(deriveKey(["./tools/build.sh", "install", "mac"], "/x/CaseLeaf")).toBe("/x/CaseLeaf:tools/build.sh:mac");
    expect(deriveKey(["xcodebuild", "-scheme", "App", "build"], "/x/P")).toBe("/x/P:xcodebuild:App");
    expect(deriveKey(["sleep", "1"], "/x/P")).toBeUndefined();
  });

  it("derived key is shared by worktrees of one repo and differs between repos", () => {
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "ignore" });
    const a = join(dir, "a");
    const b = join(dir, "b");
    for (const r of [a, b]) {
      mkdirSync(r);
      git(r, "init", "-q");
      git(r, "commit", "-q", "--allow-empty", "-m", "i");
    }
    const wt = join(dir, "a-wt");
    git(a, "worktree", "add", "-q", wt, "-b", "wt");
    const cmd = ["tools/build.sh", "test", "mac"];
    expect(deriveKey(cmd, wt)).toBe(deriveKey(cmd, a));
    expect(deriveKey(cmd, b)).not.toBe(deriveKey(cmd, a));
    expect(deriveKey(["xcodebuild", "-scheme", "S"], wt)).toBe(deriveKey(["xcodebuild", "-scheme", "S"], a));
  });

  it("PAI_BUILD_KEY is used when no key is given", async () => {
    const r = runBuild({ ...base, dir, slots: 1, env: { ...process.env, PAI_BUILD_KEY: "envkey" }, command: ["sleep", "0.3"] });
    await until(async () => (await listBuilds(dir)).length === 1);
    expect((await listBuilds(dir))[0].key).toBe("envkey");
    await r;
  });
});
