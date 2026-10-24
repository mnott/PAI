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

import { existsSync, mkdtempSync, readFileSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion, detectGithubRepo, githubRepoOf, isGithubUrl, parseGithubRepo, remoteUrl, stableAssetName, versionedAssetName } from "./repo-facts.js";
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
  /** Resume at this step: earlier steps are skipped; after `tag` the tag on HEAD is the release. */
  from?: Step;
  /** Steps to skip; only `mirror` (no-op when the tag is already on GitHub). */
  skip?: Step[];
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

/** Parse `--from` / `--skip` values; throws a plain Error naming the valid steps. */
export function parseStep(value: string, flag: string): Step {
  if ((STEPS as readonly string[]).includes(value)) return value as Step;
  throw new Error(`--${flag}: unknown step "${value}" (steps: ${STEPS.join(" ")})`);
}

/** Lockfile-faithful dependency install for a checkout: npm ci, bun's frozen install, or plain npm install. */
function installCommand(dir: string): string[] {
  if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json"))) return ["npm", "ci"];
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return ["bun", "install", "--frozen-lockfile"];
  return ["npm", "install"];
}

/**
 * Filename, packed size and file count from `npm pack --json`; null when the output is not that.
 * The JSON array is pretty-printed and may follow lifecycle-script output on stdout, so try
 * parsing from each line that starts with "[" to the end.
 */
export function parsePackJson(out: string): { filename: string; size: number; entryCount: number } | null {
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("[")) continue;
    try {
      const j = JSON.parse(lines.slice(i).join("\n"))?.[0];
      if (j?.filename) return { filename: String(j.filename), size: Number(j.size) || 0, entryCount: Number(j.entryCount) || 0 };
    } catch { /* not the JSON start; try the next candidate */ }
  }
  return null;
}

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
export function planRelease(repo: string, opts: { bump?: string; from?: Step; skip?: Step[]; version?: string } = {}): string[] {
  const pkg = readPkg(repo);
  const gh = detectGithubRepo(repo, pkg);
  const githubOrigin = isGithubUrl(remoteUrl(repo, "origin"));
  const next = opts.version ?? bumpVersion(pkg.version ?? "0.0.0", opts.bump ?? "patch");
  const t = testCommand(repo, pkg);
  const sync = existsSync(join(repo, "scripts", "sync-versions.mjs")) ? " + node scripts/sync-versions.mjs" : "";
  const stable = pkg.name ? stableAssetName(pkg.name) : "<name>.tgz";
  const plan = [
    `check: clean tree, branch main`,
    `bump: ${pkg.version} -> ${next} (npm version --no-git-tag-version${sync})`,
    `build: ${pkg.scripts?.build ? "npm run build" : "(no build script)"}`,
    `test: ${t ? [t.cmd, ...t.args].join(" ") : "(no unit tests)"}`,
    `commit: git add -A; git commit -m "chore: release ${next}"`,
    `tag: v${next}`,
    `push: git push origin main --tags`,
    githubOrigin
      ? `mirror: skipped (origin is GitHub${gh ? `, ${gh.owner}/${gh.repo}` : ""}; the push already reaches it)`
      : `mirror: ${opts.from || opts.skip?.includes("mirror") ? `no-op when v${next} is already on GitHub, else ` : ""}forge push-mirror sync; wait for v${next} on GitHub${gh ? ` (${gh.owner}/${gh.repo})` : ""}`,
    `pack: clean worktree of v${next} (install, build) -> npm pack -> ${stable} + versioned`,
    `release: gh release create v${next} ${stable}${gh ? ` --repo ${gh.owner}/${gh.repo}` : ""}`,
  ];
  return opts.from ? plan.slice(STEPS.indexOf(opts.from)) : plan;
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

  const fromIdx = opts.from ? STEPS.indexOf(opts.from) : 0;
  const resume = fromIdx > STEPS.indexOf("tag");
  const skipMirror = opts.skip?.includes("mirror") ?? false;
  /** The v* tag on HEAD, for steps after `tag`. */
  const headTag = async (): Promise<string> => {
    const r = await run("git", ["tag", "--points-at", "HEAD"], { cwd: repo });
    const t = r.stdout.split("\n").map((x) => x.trim()).filter((x) => /^v\d/.test(x)).sort().pop();
    if (r.code !== 0 || !t) throw new StepFailed(`--from ${opts.from}: HEAD has no v* tag; resume from a step up to tag, or check out the tagged commit`);
    return t;
  };

  if (opts.dryRun) {
    try {
      const version = resume ? (await headTag()).slice(1) : undefined;
      for (const l of planRelease(repo, { bump: opts.bump, from: opts.from, skip: opts.skip, version })) print(`plan ${l}`);
      return { ok: true, state, lines };
    } catch (e) {
      print(`check: FAILED — ${(e as Error).message}`);
      return { ok: false, failedStep: "check", message: (e as Error).message, state, lines };
    }
  }
  const at = (s: Step): boolean => STEPS.indexOf(s) >= fromIdx;

  const sh = async (cmd: string, args: string[]): Promise<string> => {
    const r = await run(cmd, args, { cwd: repo });
    if (r.code !== 0) throw new StepFailed(`${[cmd, ...args].join(" ")} exited ${r.code}: ${tail(r.stderr || r.stdout)}`);
    return r.stdout;
  };

  let step: Step = "check";
  try {
    // 1. check
    if (!resume) {
      const dirty = (await sh("git", ["status", "--porcelain"])).trim();
      if (dirty) throw new StepFailed(`working tree is not clean (${dirty.split("\n").length} changed path(s)); commit or stash first`);
      const branch = (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (branch !== "main") throw new StepFailed(`on branch "${branch}", releases are cut from main`);
    }
    const origin = (await sh("git", ["remote", "get-url", "origin"])).trim();
    const githubOrigin = isGithubUrl(origin);
    const forgeName = githubOrigin ? "none, origin is GitHub" : `forge ${deriveForge(origin).repo}`;
    const gh = githubRepoOf(pkg) ?? parseGithubRepo(await run("git", ["remote", "get-url", "github"], { cwd: repo }).then((r) => (r.code === 0 ? r.stdout : ""))) ?? parseGithubRepo(origin);
    if (!gh) throw new StepFailed("no GitHub repository: set package.json repository or a `github` remote");
    if (!pkg.name) throw new StepFailed("package.json has no name");
    // a resume after `tag` releases the tag on HEAD; from build on, the bump is already in package.json
    const tag = resume ? await headTag() : `v${fromIdx > STEPS.indexOf("bump") ? (pkg.version ?? "0.0.0") : bumpVersion(pkg.version ?? "0.0.0", opts.bump ?? "patch")}`;
    const version = tag.slice(1);
    if (!resume && (await sh("git", ["tag", "--list", tag])).trim()) throw new StepFailed(`tag ${tag} already exists`);
    state.version = version;
    if (opts.from === "release") throw new StepFailed("release needs the packed files; resume with --from pack");
    if (resume) {
      Object.assign(state, { version, bumped: true, committed: true, tagged: true, pushed: fromIdx > STEPS.indexOf("push"), mirrored: fromIdx > STEPS.indexOf("mirror") });
      print(`check: resuming from ${opts.from} on ${tag} (${forgeName}; GitHub ${gh.owner}/${gh.repo})`);
    } else print(`check: ok (main, clean; ${forgeName}; GitHub ${gh.owner}/${gh.repo})`);

    // 2. bump
    if (at("bump")) {
      step = "bump";
      state.version = version;
      state.bumped = true;
      await sh("npm", ["version", version, "--no-git-tag-version"]);
      if (existsSync(join(repo, "scripts", "sync-versions.mjs"))) await sh("node", ["scripts/sync-versions.mjs"]);
      print(`bump: ${pkg.version} -> ${version}`);
    }

    // 3. build
    if (at("build")) {
      step = "build";
      if (pkg.scripts?.build) {
        await sh("npm", ["run", "build"]);
        print("build: ok");
      } else print("build: skipped (no build script)");
    }

    // 4. test
    if (at("test")) {
      step = "test";
      const t = testCommand(repo, pkg);
      if (t) {
        await sh(t.cmd, t.args);
        print(`test: ok (${[t.cmd, ...t.args].join(" ")})`);
      } else print("test: skipped (no unit tests)");
    }

    // 5. commit
    if (at("commit")) {
      step = "commit";
      await sh("git", ["add", "-A"]);
      await sh("git", ["commit", "-m", `chore: release ${version}`]);
      state.committed = true;
      print(`commit: chore: release ${version}`);
    }

    // 6. tag
    if (at("tag")) {
      step = "tag";
      await sh("git", ["tag", tag]);
      state.tagged = true;
      print(`tag: ${tag}`);
    }

    // 7. push
    if (at("push")) {
      step = "push";
      await sh("git", ["push", "origin", "main", "--tags"]);
      state.pushed = true;
      print("push: origin main + tags");
    }

    // 8. mirror
    if (at("mirror")) {
      step = "mirror";
      const hasGithubRemote = (await run("git", ["remote", "get-url", "github"], { cwd: repo })).code === 0;
      const target = githubOrigin ? "origin" : hasGithubRemote ? "github" : `https://github.com/${gh.owner}/${gh.repo}.git`;
      const onGithub = async (): Promise<boolean> => {
        const r = await run("git", ["ls-remote", target, `refs/tags/${tag}`], { cwd: repo });
        return r.code === 0 && r.stdout.includes(`refs/tags/${tag}`);
      };
      if (githubOrigin) {
        state.mirrored = true;
        print("mirror: skipped (origin is GitHub)");
      } else if ((opts.from || skipMirror) && (await onGithub())) {
        state.mirrored = true;
        print(`mirror: skipped (${tag} already on GitHub)`);
      } else {
        let sync: MirrorSyncResult;
        try {
          sync = await (deps.syncMirrors ?? ((cwd: string) => realSyncMirrors(cwd)))(repo);
        } catch (e) {
          const env = /^no forge token: set (\S+)/.exec(e instanceof Error ? e.message : "")?.[1];
          if (env) throw new StepFailed(`no forge token (set $${env}) — sync the push mirror in the forge UI, then run: pai release --from mirror`);
          throw e;
        }
        const bad = sync.mirrors.filter((m) => !m.ok);
        if (!sync.mirrors.length) throw new StepFailed("the forge has no push mirror to GitHub");
        if (bad.length) throw new StepFailed(bad.map(formatMirror).join("; "));
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
      }
    }

    // 9. pack
    step = "pack";
    const dir = (deps.packDir ?? (() => mkdtempSync(join(tmpdir(), "pai-release-"))))();
    // Pack from a clean build of the tag, never the live dist (it accumulates stale chunks).
    const work = mkdtempSync(join(tmpdir(), "pai-pack-"));
    const tree = join(work, "tree");
    const shIn = async (cwd: string, cmd: string, args: string[]): Promise<string> => {
      const r = await run(cmd, args, { cwd });
      if (r.code !== 0) throw new StepFailed(`${[cmd, ...args].join(" ")} exited ${r.code}: ${tail(r.stderr || r.stdout)}`);
      return r.stdout;
    };
    let packed: string;
    let facts = "";
    try {
      await shIn(repo, "git", ["worktree", "add", "--detach", tree, tag]);
      const [icmd, ...iargs] = installCommand(tree);
      await shIn(tree, icmd, iargs);
      if (pkg.scripts?.build) await shIn(tree, "npm", ["run", "build"]);
      const out = await shIn(tree, "npm", ["pack", "--pack-destination", dir, "--json"]);
      const info = parsePackJson(out);
      // the pack destination is fresh, so its single .tgz is the source of truth when the JSON is unreadable
      const tgzs = readdirSync(dir).filter((f) => f.endsWith(".tgz"));
      packed = info?.filename ?? (tgzs.length === 1 ? tgzs[0] : versionedAssetName(pkg.name, version));
      if (info) facts = ` (${(info.size / 1048576).toFixed(1)} MB packed, ${info.entryCount} files)`;
    } finally {
      try { await run("git", ["worktree", "remove", "--force", tree], { cwd: repo }); } catch { /* best effort */ }
      try { rmSync(work, { recursive: true, force: true }); } catch { /* temp dir */ }
      try { await run("git", ["worktree", "prune"], { cwd: repo }); } catch { /* best effort */ }
    }
    const versioned = join(dir, packed);
    const stable = join(dir, stableAssetName(pkg.name));
    if (!existsSync(versioned)) throw new StepFailed(`npm pack reported ${packed} but it is not in ${dir}`);
    copyFileSync(versioned, stable);
    print(`pack: ${stableAssetName(pkg.name)} + ${packed}${facts}`);


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
