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

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
function stripPrefix(ws: string[]): string[] {
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

function isDoor(ws: string[], cfg: BuildsConfig, cwd: string): boolean {
  if (!cfg.doors.length) return false;
  let w = ws;
  if (SHELLS.has(base(w[0] ?? "")) && w[1] && !w[1].startsWith("-")) w = w.slice(1);
  const first = w[0];
  if (!first) return false;
  const abs = isAbsolute(first) ? resolve(first) : resolve(cwd, first);
  return cfg.doors.some((d) => resolve(cfg.root, d) === abs);
}

function reasonFor(segment: string, cfg: BuildsConfig | null, cwd: string, depth: number): string | null {
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
  if (h) return h;
  for (const p of cfg?.patterns ?? []) {
    try {
      if (new RegExp(p).test(ws.join(" "))) return `pattern ${p}`;
    } catch {
      /* bad pattern in the project file: ignore it */
    }
  }
  return null;
}

/** Deny message when `command` runs a raw heavy builder outside the queue, else null. */
export function buildGateReason(command: string, cwd: string, cfg: BuildsConfig | null = loadBuildsConfig(cwd)): string | null {
  for (const seg of splitSegments(command)) {
    const why = reasonFor(seg, cfg, cwd, 0);
    if (why) return `${BUILD_DENY_MESSAGE(cfg?.doors[0])} (blocked: ${why})`;
  }
  return null;
}
