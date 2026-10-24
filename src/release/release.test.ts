import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogSection, planRelease, realRun, runRelease, STEPS, stateLine, type RunFn } from "./release.js";
import type { MirrorSyncResult } from "../builds/mirror-sync.js";

function tmpRepo(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "rel-test-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@acme/tool", version: "1.2.3", repository: { type: "git", url: "git+https://github.com/acme/tool.git" }, scripts: { build: "x", test: "vitest" }, devDependencies: { vitest: "^4" }, ...extra }),
  );
  return dir;
}

interface Fake {
  calls: string[];
  run: RunFn;
}

/** Fake git/npm/gh: answers by command line; `fail` makes the first matching command exit 1. */
function fake(dir: string, o: { dirty?: boolean; branch?: string; fail?: string; tagVisibleAfter?: number } = {}): Fake {
  const calls: string[] = [];
  let lsRemote = 0;
  const run: RunFn = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });
    if (o.fail && line.startsWith(o.fail)) return { code: 1, stdout: "", stderr: "boom" };
    if (line === "git status --porcelain") return ok(o.dirty ? " M a.ts\n" : "");
    if (line === "git rev-parse --abbrev-ref HEAD") return ok((o.branch ?? "main") + "\n");
    if (line === "git remote get-url origin") return ok("https://forge.example/git/APPS/tool.git\n");
    if (line === "git remote get-url github") return { code: 2, stdout: "", stderr: "" };
    if (line.startsWith("git tag --list v")) return ok(line.includes("--sort") ? "v1.2.4\nv1.2.3\n" : "");
    if (line.startsWith("git ls-remote")) return ok(++lsRemote > (o.tagVisibleAfter ?? 0) ? "abc\trefs/tags/v1.2.4\n" : "");
    if (line.startsWith("npm pack")) {
      const d = args[args.indexOf("--pack-destination") + 1];
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "acme-tool-1.2.4.tgz"), "tgz");
      return ok("acme-tool-1.2.4.tgz\n");
    }
    if (line.startsWith("git log")) return ok("- fix: a\n- feat: b\n");
    return ok();
  };
  return { calls, run };
}

const mirrorOk = async (): Promise<MirrorSyncResult> => ({ repo: "APPS/tool", mirrors: [{ name: "github", ok: true, commitSha: "abc12345" }] });
const common = { sleep: async () => {}, tagPoll: { attempts: 3, delayMs: 0 } };

describe("planRelease", () => {
  it("lists the steps in order with the computed version and asset names", () => {
    const plan = planRelease(tmpRepo(), { bump: "minor" });
    expect(plan.map((l) => l.split(":")[0])).toEqual([...STEPS]);
    expect(plan[1]).toContain("1.2.3 -> 1.3.0");
    expect(plan[3]).toContain("npx vitest run");
    expect(plan[8]).toContain("tool.tgz");
    expect(plan[9]).toContain("--repo acme/tool");
  });
});

describe("runRelease", () => {
  it("runs every step in order and creates the release with stable + versioned assets", async () => {
    const dir = tmpRepo();
    const f = fake(dir);
    const lines: string[] = [];
    const r = await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk, out: (l) => lines.push(l) });
    expect(r.ok).toBe(true);
    expect(lines.map((l) => l.split(":")[0])).toEqual([...STEPS]);
    const idx = (p: string): number => f.calls.findIndex((c) => c.startsWith(p));
    const order = ["git status", "npm version 1.2.4 --no-git-tag-version", "npm run build", "npx vitest run", "git add -A", "git commit -m chore: release 1.2.4", "git tag v1.2.4", "git push origin main --tags", "git ls-remote", "npm pack", "gh release create v1.2.4"].map(idx);
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    const gh = f.calls.find((c) => c.startsWith("gh release create"))!;
    expect(gh).toContain("tool.tgz");
    expect(gh).toContain("acme-tool-1.2.4.tgz");
    expect(gh).toContain("--repo acme/tool");
    expect(gh).toContain("- fix: a");
    expect(f.calls.some((c) => c.includes("bun test"))).toBe(false);
  });

  it("uses the CHANGELOG section as notes when present", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.2.4] - 2026-10-24\nAdded the thing\n\n## [1.2.3]\nold\n");
    const f = fake(dir);
    await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk });
    expect(f.calls.find((c) => c.startsWith("gh release create"))).toContain("Added the thing");
  });

  it("waits for the tag on GitHub", async () => {
    const dir = tmpRepo();
    const f = fake(dir, { tagVisibleAfter: 2 });
    const r = await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk });
    expect(r.ok).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("git ls-remote")).length).toBe(3);
  });

  it("refuses a dirty tree before touching anything", async () => {
    const dir = tmpRepo();
    const f = fake(dir, { dirty: true });
    const r = await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("check");
    expect(r.message).toContain("not clean");
    expect(r.lines.at(-1)).toContain("working tree untouched");
    expect(f.calls.some((c) => c.startsWith("npm"))).toBe(false);
  });

  it("refuses a branch other than main", async () => {
    const dir = tmpRepo();
    const f = fake(dir, { branch: "feature" });
    const r = await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk });
    expect(r.failedStep).toBe("check");
    expect(r.message).toContain('"feature"');
  });

  it("stops at the first failing step and reports what is committed, tagged, pushed", async () => {
    const dir = tmpRepo();
    const f = fake(dir, { fail: "git push" });
    const r = await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk });
    expect(r.failedStep).toBe("push");
    expect(r.state).toMatchObject({ bumped: true, committed: true, tagged: true, pushed: false, released: false });
    expect(r.lines.at(-1)).toBe("state: version v1.2.4 written to the working tree; committed; tagged v1.2.4; not pushed; not on GitHub; no release");
    expect(f.calls.some((c) => c.startsWith("npm pack") || c.startsWith("gh "))).toBe(false);
  });

  it("stops at a failing build before committing", async () => {
    const dir = tmpRepo();
    const f = fake(dir, { fail: "npm run build" });
    const r = await runRelease({ repo: dir }, { ...common, run: f.run, syncMirrors: mirrorOk });
    expect(r.failedStep).toBe("build");
    expect(r.state.committed).toBe(false);
    expect(f.calls.some((c) => c.startsWith("git commit"))).toBe(false);
  });

  it("fails the mirror step when the mirror is rejected, state says pushed", async () => {
    const dir = tmpRepo();
    const f = fake(dir);
    const r = await runRelease(
      { repo: dir },
      { ...common, run: f.run, syncMirrors: async () => ({ repo: "x/y", mirrors: [{ name: "github", ok: false, error: { reason: "push protection", detail: "secret" } }] }) },
    );
    expect(r.failedStep).toBe("mirror");
    expect(r.state.pushed).toBe(true);
    expect(r.state.mirrored).toBe(false);
  });

  it("--dry-run prints the plan and runs nothing", async () => {
    const dir = tmpRepo();
    const f = fake(dir);
    const r = await runRelease({ repo: dir, dryRun: true, bump: "major" }, { ...common, run: f.run });
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual([]);
    expect(r.lines[1]).toContain("-> 2.0.0");
  });

  it("refuses for real on a dirty and on a non-main temp git repo", async () => {
    const dir = tmpRepo();
    const git = (...a: string[]): string => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(dir, "x.txt"), "x");
    const dirty = await runRelease({ repo: dir }, { ...common, run: realRun, syncMirrors: mirrorOk });
    expect(dirty.message).toContain("not clean");
    git("add", "-A");
    git("commit", "-qm", "x");
    git("checkout", "-q", "-b", "topic");
    const off = await runRelease({ repo: dir }, { ...common, run: realRun, syncMirrors: mirrorOk });
    expect(off.message).toContain('"topic"');
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.2.3");
  });
});

describe("helpers", () => {
  it("changelogSection finds the version block", () => {
    expect(changelogSection("## 1.0.0\nx\n## 0.9.0\ny", "1.0.0")).toBe("x");
    expect(changelogSection("## 0.9.0\ny", "1.0.0")).toBeNull();
  });
  it("stateLine for a fresh failure", () => {
    expect(stateLine({ bumped: false, committed: false, tagged: false, pushed: false, mirrored: false, released: false })).toContain("working tree untouched");
  });
});
