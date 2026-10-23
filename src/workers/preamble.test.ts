import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendSystemPromptArgs } from "./args.js";
import { PREAMBLE_MAX_BYTES, loadPreamble, preambleBlock, preambleLine } from "./preamble.js";
import { workerContractPrompt } from "./report.js";

const dirs: string[] = [];
function repo(file?: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pai-preamble-")));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  if (file !== undefined) {
    mkdirSync(join(d, ".pai"));
    writeFileSync(join(d, ".pai", "worker.md"), file);
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadPreamble", () => {
  it("loads the file from a subdirectory cwd (git toplevel)", () => {
    const d = repo("rule one\nrule two\n");
    mkdirSync(join(d, "sub"));
    const r = loadPreamble(join(d, "sub"));
    expect("preamble" in r && r.preamble?.text).toBe("rule one\nrule two");
    expect("preamble" in r && r.preamble?.lines).toBe(2);
    expect(preambleLine("preamble" in r ? r.preamble : null)).toBe("preamble: .pai/worker.md (2 lines)");
  });

  it("missing or empty file adds nothing", () => {
    expect(loadPreamble(repo())).toEqual({ preamble: null });
    expect(loadPreamble(repo("  \n\n"))).toEqual({ preamble: null });
    expect(preambleLine(null)).toBe("preamble: none");
  });

  it("a linked worktree uses its own toplevel's file", () => {
    const d = repo("main rule\n");
    execFileSync("git", ["add", "."], { cwd: d });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: d });
    const wt = join(d, "wt");
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: d });
    writeFileSync(join(wt, ".pai", "worker.md"), "worktree rule\n");
    const r = loadPreamble(wt);
    expect("preamble" in r && r.preamble?.text).toBe("worktree rule");
  });

  it("a worktree without its own .pai/ falls back to the main checkout's", () => {
    const d = repo("main rule\n");
    execFileSync("git", ["add", "."], { cwd: d });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: d });
    const wt = join(d, "wt");
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: d });
    const r = loadPreamble(wt);
    expect("preamble" in r && r.preamble?.text).toBe("main rule");
  });

  it("refuses an oversize file with the reason", () => {
    const r = loadPreamble(repo("x".repeat(PREAMBLE_MAX_BYTES + 1)));
    expect("refused" in r && r.refused).toMatch(/over the 16384 byte limit/);
  });
});

describe("system prompt assembly", () => {
  it("is byte-identical across specs, appended once, after the contract", () => {
    const d = repo("PREAMBLE-MARKER-7731\n");
    const r = loadPreamble(d);
    const p = "preamble" in r ? r.preamble! : null;
    expect(p).not.toBeNull();
    const build = (spec: string) => ({
      sys: appendSystemPromptArgs([workerContractPrompt("simple", "ag2"), preambleBlock(p!)]),
      user: spec,
    });
    const a = build("spec A");
    const b = build("a completely different spec B");
    expect(a.sys).toEqual(b.sys);
    const text = a.sys[1];
    expect(text.split("PREAMBLE-MARKER-7731")).toHaveLength(2);
    expect(text.indexOf("PREAMBLE-MARKER-7731")).toBeGreaterThan(text.indexOf(workerContractPrompt("simple", "ag2")));
    expect(text).not.toContain("spec A");
    expect(text).not.toContain(p!.hash);
  });
});

describe("projectConfigFile fallback never crosses repos", () => {
  it("--separate-git-dir: a sibling .pai in the shared git-dir parent is not read", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pai-sep-")));
    dirs.push(base);
    mkdirSync(join(base, "gitdirs", ".pai"), { recursive: true });
    writeFileSync(join(base, "gitdirs", ".pai", "worker.md"), "foreign rules");
    mkdirSync(join(base, "repoA"));
    execFileSync("git", ["init", "-q", "--separate-git-dir", join(base, "gitdirs", "repoA"), join(base, "repoA")]);
    execFileSync("git", ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: join(base, "repoA") });
    execFileSync("git", ["worktree", "add", "-q", join(base, "wtA"), "-b", "w"], { cwd: join(base, "repoA") });
    expect(loadPreamble(join(base, "wtA"))).toEqual({ preamble: null });
  });

  it("bare repo + worktree: nothing from the bare repo's parent; a normal main checkout still works", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pai-bare-")));
    dirs.push(base);
    mkdirSync(join(base, ".pai"));
    writeFileSync(join(base, ".pai", "worker.md"), "foreign rules");
    execFileSync("git", ["init", "-q", "--bare", join(base, "repo.git")]);
    execFileSync("git", ["worktree", "add", "-q", "--orphan", "-b", "m", join(base, "wt")], { cwd: join(base, "repo.git") });
    expect(loadPreamble(join(base, "wt"))).toEqual({ preamble: null });

    const main = repo("own rules");
    execFileSync("git", ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: main });
    execFileSync("git", ["worktree", "add", "-q", join(base, "wt2"), "-b", "w2"], { cwd: main });
    const r = loadPreamble(join(base, "wt2"));
    expect("preamble" in r && r.preamble?.text).toBe("own rules");
  });
});
