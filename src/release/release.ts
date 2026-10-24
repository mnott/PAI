/**
 * `pai release`: one release flow. The private forge stays in the middle
 * (origin); GitHub gets main + the tag through the forge's push mirror and a
 * GitHub Release per version carrying the installable package. No npm registry.
 *
 * Steps, each printing one line: check, bump, build, test, commit, tag, push,
 * mirror, pack, release. The first failure stops with the step name and a
 * `state:` line saying what is committed, tagged and pushed. Every external
 * effect goes through the injected `run` (git, npm, gh) and `syncMirrors`.
 */

import { existsSync, mkdtempSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion, githubRepoOf, parseGithubRepo, stableAssetName, versionedAssetName } from "./repo-facts.js";
import { deriveForge, syncMirrors as realSyncMirrors, formatMirror, type MirrorSyncResult } from "../builds/mirror-sync.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<RunResult>;

export interface ReleaseOptions {
  repo: string;
  bump?: string;
  dryRun?: boolean;
}

export interface ReleaseDeps {
  run?: RunFn;
  syncMirrors?: (cwd: string) => Promise<MirrorSyncResult>;
  sleep?: (ms: number) => Promise<void>;
  out?: (line: string) => void;
  /** Where `npm pack` output is collected; default: a fresh temp dir. */
  packDir?: () => string;
  /** Tag visibility polling on GitHub: attempts and delay. */
  tagPoll?: { attempts: number; delayMs: number };
}

export const STEPS = ["check", "bump", "build", "test", "commit", "tag", "push", "mirror", "pack", "release"] as const;
export type Step = (typeof STEPS)[number];

export interface ReleaseState {
  version?: string;
  bumped: boolean;
  committed: boolean;
  tagged: boolean;
  pushed: boolean;
  mirrored: boolean;
  released: boolean;
}

export interface ReleaseResult {
  ok: boolean;
  failedStep?: Step;
  message?: string;
  state: ReleaseState;
  lines: string[];
}

class StepFailed extends Error {}

/** Env without terminal-session variables, so a test run does not talk to the user's terminal. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE"]) delete env[k];
  return env;
}

export const realRun: RunFn = (cmd, args, { cwd }) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e.message) }));
    c.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tail = (s: string): string => s.trim().split("\n").slice(-6).join(" | ").slice(0, 400);

interface Pkg {
  name?: string;
  version?: string;
  repository?: unknown;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(repo: string): Pkg {
  const f = join(repo, "package.json");
  if (!existsSync(f)) throw new Error(`no package.json in ${repo}`);
  return JSON.parse(readFileSync(f, "utf8")) as Pkg;
}

/** The repo's unit-test command: test:unit, vitest (unit project when configured), else `npm test`; null when none. */
export function testCommand(repo: string, pkg: Pkg): { cmd: string; args: string[] } | null {
  if (pkg.scripts?.["test:unit"]) return { cmd: "npm", args: ["run", "test:unit"] };
  const vitest = pkg.devDependencies?.vitest !== undefined || ["vitest.config.ts", "vitest.config.mjs", "vitest.config.js"].some((f) => existsSync(join(repo, f)));
  if (vitest) {
    const cfg = ["vitest.config.ts", "vitest.config.mjs", "vitest.config.js"].map((f) => join(repo, f)).find(existsSync);
    const projects = cfg ? /name:\s*["']unit["']/.test(readFileSync(cfg, "utf8")) : false;
    return { cmd: "npx", args: ["vitest", "run", ...(projects ? ["--project", "unit"] : [])] };
  }
  if (pkg.scripts?.test && !/bun test/.test(pkg.scripts.test)) return { cmd: "npm", args: ["test"] };
  return null;
}

/** Release notes: the CHANGELOG section for the version, else the commit subjects since the previous tag. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const esc = version.replace(/\./g, "\\.");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$|-)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

/** The ordered plan for a repo: what `--dry-run` prints and what a run follows. */
export function planRelease(repo: string, opts: { bump?: string } = {}): string[] {
  const pkg = readPkg(repo);
  const gh = githubRepoOf(pkg);
  const next = bumpVersion(pkg.version ?? "0.0.0", opts.bump ?? "patch");
  const t = testCommand(repo, pkg);
  const sync = existsSync(join(repo, "scripts", "sync-versions.mjs")) ? " + node scripts/sync-versions.mjs" : "";
  const stable = pkg.name ? stableAssetName(pkg.name) : "<name>.tgz";
  return [
    `check: clean tree, branch main`,
    `bump: ${pkg.version} -> ${next} (npm version --no-git-tag-version${sync})`,
    `build: ${pkg.scripts?.build ? "npm run build" : "(no build script)"}`,
    `test: ${t ? [t.cmd, ...t.args].join(" ") : "(no unit tests)"}`,
    `commit: git add -A; git commit -m "chore: release ${next}"`,
    `tag: v${next}`,
    `push: git push origin main --tags`,
    `mirror: forge push-mirror sync; wait for v${next} on GitHub${gh ? ` (${gh.owner}/${gh.repo})` : ""}`,
    `pack: npm pack -> ${stable} + versioned`,
    `release: gh release create v${next} ${stable}${gh ? ` --repo ${gh.owner}/${gh.repo}` : ""}`,
  ];
}

/** The `state:` line: what is committed, tagged and pushed. */
export function stateLine(s: ReleaseState): string {
  const v = s.version ? `v${s.version}` : "no version";
  const parts = [
    s.bumped ? `version ${v} written to the working tree` : "working tree untouched",
    s.committed ? "committed" : "not committed",
    s.tagged ? `tagged ${v}` : "not tagged",
    s.pushed ? "pushed to origin" : "not pushed",
    s.mirrored ? "on GitHub" : "not on GitHub",
    s.released ? "release created" : "no release",
  ];
  return `state: ${parts.join("; ")}`;
}

export async function runRelease(opts: ReleaseOptions, deps: ReleaseDeps = {}): Promise<ReleaseResult> {
  const run = deps.run ?? realRun;
  const lines: string[] = [];
  const print = (l: string): void => {
    lines.push(l);
    deps.out?.(l);
  };
  const state: ReleaseState = { bumped: false, committed: false, tagged: false, pushed: false, mirrored: false, released: false };
  const repo = opts.repo;

  let pkg: Pkg;
  try {
    pkg = readPkg(repo);
  } catch (e) {
    return { ok: false, failedStep: "check", message: (e as Error).message, state, lines: [`check: FAILED — ${(e as Error).message}`] };
  }

  if (opts.dryRun) {
    try {
      for (const l of planRelease(repo, { bump: opts.bump })) print(`plan ${l}`);
      return { ok: true, state, lines };
    } catch (e) {
      print(`check: FAILED — ${(e as Error).message}`);
      return { ok: false, failedStep: "check", message: (e as Error).message, state, lines };
    }
  }

  const sh = async (cmd: string, args: string[]): Promise<string> => {
    const r = await run(cmd, args, { cwd: repo });
    if (r.code !== 0) throw new StepFailed(`${[cmd, ...args].join(" ")} exited ${r.code}: ${tail(r.stderr || r.stdout)}`);
    return r.stdout;
  };

  let step: Step = "check";
  try {
    // 1. check
    const dirty = (await sh("git", ["status", "--porcelain"])).trim();
    if (dirty) throw new StepFailed(`working tree is not clean (${dirty.split("\n").length} changed path(s)); commit or stash first`);
    const branch = (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch !== "main") throw new StepFailed(`on branch "${branch}", releases are cut from main`);
    const origin = (await sh("git", ["remote", "get-url", "origin"])).trim();
    const forge = deriveForge(origin);
    const gh = githubRepoOf(pkg) ?? parseGithubRepo(await run("git", ["remote", "get-url", "github"], { cwd: repo }).then((r) => (r.code === 0 ? r.stdout : "")));
    if (!gh) throw new StepFailed("no GitHub repository: set package.json repository or a `github` remote");
    if (!pkg.name) throw new StepFailed("package.json has no name");
    const version = bumpVersion(pkg.version ?? "0.0.0", opts.bump ?? "patch");
    const tag = `v${version}`;
    if ((await sh("git", ["tag", "--list", tag])).trim()) throw new StepFailed(`tag ${tag} already exists`);
    print(`check: ok (main, clean; forge ${forge.repo}; GitHub ${gh.owner}/${gh.repo})`);

    // 2. bump
    step = "bump";
    state.version = version;
    state.bumped = true;
    await sh("npm", ["version", version, "--no-git-tag-version"]);
    if (existsSync(join(repo, "scripts", "sync-versions.mjs"))) await sh("node", ["scripts/sync-versions.mjs"]);
    print(`bump: ${pkg.version} -> ${version}`);

    // 3. build
    step = "build";
    if (pkg.scripts?.build) {
      await sh("npm", ["run", "build"]);
      print("build: ok");
    } else print("build: skipped (no build script)");

    // 4. test
    step = "test";
    const t = testCommand(repo, pkg);
    if (t) {
      await sh(t.cmd, t.args);
      print(`test: ok (${[t.cmd, ...t.args].join(" ")})`);
    } else print("test: skipped (no unit tests)");

    // 5. commit
    step = "commit";
    await sh("git", ["add", "-A"]);
    await sh("git", ["commit", "-m", `chore: release ${version}`]);
    state.committed = true;
    print(`commit: chore: release ${version}`);

    // 6. tag
    step = "tag";
    await sh("git", ["tag", tag]);
    state.tagged = true;
    print(`tag: ${tag}`);

    // 7. push
    step = "push";
    await sh("git", ["push", "origin", "main", "--tags"]);
    state.pushed = true;
    print("push: origin main + tags");

    // 8. mirror
    step = "mirror";
    const sync = await (deps.syncMirrors ?? ((cwd: string) => realSyncMirrors(cwd)))(repo);
    const bad = sync.mirrors.filter((m) => !m.ok);
    if (!sync.mirrors.length) throw new StepFailed("the forge has no push mirror to GitHub");
    if (bad.length) throw new StepFailed(bad.map(formatMirror).join("; "));
    const hasGithubRemote = (await run("git", ["remote", "get-url", "github"], { cwd: repo })).code === 0;
    const target = hasGithubRemote ? "github" : `https://github.com/${gh.owner}/${gh.repo}.git`;
    const { attempts, delayMs } = deps.tagPoll ?? { attempts: 12, delayMs: 5000 };
    let seen = false;
    for (let i = 0; i < attempts && !seen; i++) {
      const r = await run("git", ["ls-remote", "--tags", target, `refs/tags/${tag}`], { cwd: repo });
      seen = r.code === 0 && r.stdout.includes(`refs/tags/${tag}`);
      if (!seen && i < attempts - 1) await (deps.sleep ?? sleepReal)(delayMs);
    }
    if (!seen) throw new StepFailed(`${tag} not visible on GitHub after ${attempts} checks`);
    state.mirrored = true;
    print(`mirror: ok (${tag} on GitHub)`);

    // 9. pack
    step = "pack";
    const dir = (deps.packDir ?? (() => mkdtempSync(join(tmpdir(), "pai-release-"))))();
    const packed = (await sh("npm", ["pack", "--pack-destination", dir])).trim().split("\n").pop()?.trim() || versionedAssetName(pkg.name, version);
    const versioned = join(dir, packed);
    const stable = join(dir, stableAssetName(pkg.name));
    if (!existsSync(versioned)) throw new StepFailed(`npm pack reported ${packed} but it is not in ${dir}`);
    copyFileSync(versioned, stable);
    print(`pack: ${stableAssetName(pkg.name)} + ${packed}`);

    // 10. release
    step = "release";
    const changelogFile = join(repo, "CHANGELOG.md");
    let notes = existsSync(changelogFile) ? changelogSection(readFileSync(changelogFile, "utf8"), version) : null;
    if (!notes) {
      const prev = (await sh("git", ["tag", "--list", "v*", "--sort=-v:refname"])).split("\n").map((s) => s.trim()).find((s) => s && s !== tag);
      const log = (await sh("git", ["log", "--pretty=- %s", prev ? `${prev}..${tag}` : tag])).trim();
      notes = log || `Release ${tag}`;
    }
    await sh("gh", ["release", "create", tag, stable, versioned, "--repo", `${gh.owner}/${gh.repo}`, "--title", tag, "--notes", notes]);
    state.released = true;
    print(`release: https://github.com/${gh.owner}/${gh.repo}/releases/tag/${tag}`);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    return { ok: true, state, lines };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    print(`${step}: FAILED — ${message}`);
    print(stateLine(state));
    return { ok: false, failedStep: step, message, state, lines };
  }
}
