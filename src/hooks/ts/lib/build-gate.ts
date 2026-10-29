/**
 * build-gate.ts — deny raw heavy builders in Bash.
 *
 * Builds go through the machine-wide queue (`pai build run -- <cmd>`) or a
 * door the project registered in `.pai/builds.yaml`. This file decides; it
 * imports nothing heavy because the PreToolUse hook runs on every Bash call.
 * A door is trusted by the guard (it cannot read the script's mind): the door
 * owner must call `pai build lock -- <real command>` inside it, and
 * `pai build doctor` flags doors that do not.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

export interface BuildsConfig {
  /** Directory holding `.pai/builds.yaml`. */
  root: string;
  doors: string[];
  patterns: string[];
}

export const BUILD_DENY_MESSAGE = (door?: string): string =>
  `Builds go through the machine-wide queue: use \`pai build run -- <cmd>\` (or this project's door ${door ?? "- none registered"}); deltas by default, --full only for a release.`;

/** Tiny reader for the two keys of builds.yaml: flow `[a, b]` or block `- a` lists. */
export function parseBuildsYaml(text: string): { doors: string[]; patterns: string[] } {
  const res: { doors: string[]; patterns: string[] } = { doors: [], patterns: [] };
  let key: "doors" | "patterns" | null = null;
  const unq = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, "$2");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    if (!line.trim()) continue;
    const m = /^(doors|patterns)\s*:\s*(.*)$/.exec(line);
    if (m) {
      key = m[1] as "doors" | "patterns";
      const rest = m[2].trim();
      if (rest.startsWith("[")) {
        res[key].push(...rest.replace(/^\[|\]$/g, "").split(",").map(unq).filter(Boolean));
        key = null;
      }
      continue;
    }
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && key) res[key].push(unq(li[1]));
    else if (!/^\s/.test(line)) key = null;
  }
  return res;
}

/** The nearest `.pai/builds.yaml` at or above `cwd`. */
export function loadBuildsConfig(cwd: string): BuildsConfig | null {
  let dir = resolve(cwd);
  for (;;) {
    const f = join(dir, ".pai", "builds.yaml");
    if (existsSync(f)) {
      try {
        return { root: dir, ...parseBuildsYaml(readFileSync(f, "utf8")) };
      } catch {
        return null;
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Split on unquoted && || ; | & and newlines. */
export function splitSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === "\\" && q === '"') cur += cmd[++i] ?? "";
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "\\") cur += c + (cmd[++i] ?? "");
    else if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")") {
      segs.push(cur);
      cur = "";
    } else cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function words(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(seg); m; m = re.exec(seg)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const WRAPPERS = new Set(["time", "nice", "nohup", "command", "exec", "env", "sudo", "caffeinate", "taskpolicy", "arch"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** Drop env assignments and wrapper commands (with their flags) from the front. */
export function stripPrefix(ws: string[]): string[] {
  let i = 0;
  for (;;) {
    if (i >= ws.length) return [];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i])) i++;
    else if (WRAPPERS.has(base(ws[i]))) {
      i++;
      while (i < ws.length && (/^-/.test(ws[i]) || /^\d+$/.test(ws[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]))) i++;
    } else return ws.slice(i);
  }
}

const GRADLE_TASK = /^(build|test|assemble\w*|check|connected\w*|bundle\w*|install\w*|lint\w*)$/;

export type BuildKind = "build" | "test";

/** Which pool a heavy command belongs to: simulator/device test runs are "test", everything else "build". */
function kindOf(ws: string[]): BuildKind {
  let [c, ...a] = ws;
  c = base(c);
  if (c === "xcrun" && a.length) {
    if (base(a[0]) === "simctl") return a.slice(1).some((x) => /^(test|launch|boot)$/.test(x)) ? "test" : "build";
    c = base(a[0]);
    a = a.slice(1);
  }
  return c === "xcodebuild" && a.some((x) => x === "test" || x === "test-without-building") ? "test" : "build";
}

/** Is this command (already stripped) a raw heavy builder? */
function heavy(ws: string[]): string | null {
  if (!ws.length) return null;
  let [c, ...a] = ws;
  c = base(c);
  if (c === "xcrun" && a.length) {
    const sub = base(a[0]);
    if (sub === "simctl") return a.slice(1).some((x) => /^(test|launch|boot|bootstatus|install)$/.test(x)) ? "xcrun simctl" : null;
    c = sub;
    a = a.slice(1);
  }
  if (c === "xcodebuild") return a.some((x) => /^-(version|showsdks|list|usage|help|showBuildSettings|showdestinations)$/.test(x)) ? null : "xcodebuild";
  if (c === "swift") return a.some((x) => x === "build" || x === "test") && !a.includes("--version") ? `swift ${a.find((x) => x === "build" || x === "test")}` : null;
  if (c === "cargo") return a.some((x) => x === "build" || x === "test") ? `cargo ${a.find((x) => x === "build" || x === "test")}` : null;
  if (c === "gradle" || c === "gradlew") return a.some((x) => GRADLE_TASK.test(x.replace(/^:?([\w-]+:)*/, ""))) ? c : null;
  return null;
}

/** Git worktree root containing `dir` (a worktree of the same repo has its own root), or null. */
function gitTop(dir: string): string | null {
  try {
    let d = resolve(dir);
    while (!existsSync(d)) {
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
    const out = execFileSync("git", ["-C", d, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return out ? realpathSync(out) : null;
  } catch {
    return null;
  }
}

const normDoor = (d: string): string => normalize(d).replace(/^(\.\/)+/, "");

/**
 * Is `script` (as written in a command run from `cwd`) a door registered in `.pai/builds.yaml`? The script path is
 * resolved to a path relative to the git worktree root that holds it and compared with the repo-relative door list, so
 * `tools/build.sh`, `./tools/build.sh` and an absolute path into any worktree of the repo all match alike.
 */
export function isDoorScript(script: string, cwd: string, cfg: BuildsConfig | null = loadBuildsConfig(cwd)): boolean {
  const abs = isAbsolute(script) ? resolve(script) : resolve(cwd, script);
  if (cfg?.doors.some((d) => resolve(cfg.root, d) === abs)) return true;
  const top = gitTop(dirname(abs));
  if (!top) return false;
  let real = abs;
  try {
    real = join(realpathSync(dirname(abs)), base(abs));
  } catch {
    /* script not on disk: compare the lexical path */
  }
  const rel = relative(top, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const doors = new Set<string>();
  for (const c of [loadBuildsConfig(top), cfg]) for (const d of c?.doors ?? []) doors.add(normDoor(d));
  return doors.has(rel);
}

/** The script a command segment runs: after env/wrapper prefixes and an optional `sh|bash|zsh` (not `-c`). */
function scriptOf(ws: string[]): string | null {
  let w = stripPrefix(ws);
  if (SHELLS.has(base(w[0] ?? ""))) {
    w = w.slice(1);
    while (w[0]?.startsWith("-") && w[0] !== "-c") w = w.slice(1);
    if (w[0] === "-c") return null;
  }
  return w[0] ?? null;
}

/** Does this segment (words) run a registered door? Not `cd`: callers track the directory themselves. */
export function runsDoor(ws: string[], cwd: string, cfg: BuildsConfig | null = loadBuildsConfig(cwd)): boolean {
  const s = scriptOf(ws);
  return !!s && isDoorScript(s, cwd, cfg);
}

function isDoor(ws: string[], cfg: BuildsConfig, cwd: string): boolean {
  if (!cfg.doors.length) return false;
  return runsDoor(ws, cwd, cfg);
}

interface Reason {
  why: string;
  kind: BuildKind;
}

function reasonFor(segment: string, cfg: BuildsConfig | null, cwd: string, depth: number): Reason | null {
  const ws = stripPrefix(words(segment));
  if (!ws.length) return null;
  if (base(ws[0]) === "pai" && ws[1] === "build" && (ws[2] === "run" || ws[2] === "lock")) return null;
  if (cfg && isDoor(ws, cfg, cwd)) return null;
  if (depth < 3 && SHELLS.has(base(ws[0]))) {
    const ci = ws.indexOf("-c");
    const ci2 = ws.findIndex((x) => /^-\w*c$/.test(x));
    const at = ci >= 0 ? ci : ci2;
    if (at >= 0 && ws[at + 1]) return splitSegments(ws[at + 1]).map((s) => reasonFor(s, cfg, cwd, depth + 1)).find(Boolean) ?? null;
  }
  const h = heavy(ws);
  if (h) return { why: h, kind: kindOf(ws) };
  for (const p of cfg?.patterns ?? []) {
    try {
      if (new RegExp(p).test(ws.join(" "))) return { why: `pattern ${p}`, kind: "build" };
    } catch {
      /* bad pattern in the project file: ignore it */
    }
  }
  return null;
}

/** Deny message when `command` runs a raw heavy builder outside the queue, else null. */
export function buildGateReason(command: string, cwd: string, cfg: BuildsConfig | null = loadBuildsConfig(cwd)): string | null {
  let dir = cwd;
  for (const seg of splitSegments(command)) {
    const cd = /^cd\s+(\S+)$/.exec(seg);
    if (cd) {
      dir = isAbsolute(cd[1]) ? cd[1] : resolve(dir, cd[1]);
      continue;
    }
    const r = reasonFor(seg, cfg, dir, 0);
    if (r) return `${BUILD_DENY_MESSAGE(cfg?.doors[0])} (blocked: ${r.why}; kind ${r.kind}${r.kind === "test" ? ": use \`pai build run --kind test -- <cmd>\`" : ""})`;
  }
  return null;
}
