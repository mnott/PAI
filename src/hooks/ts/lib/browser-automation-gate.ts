/**
 * browser-automation-gate.ts — operator rule: no headless browsers, ever (workers and interactive sessions).
 *
 * Evidence 2026-11-18: a worker used Playwright to inspect a theme's hover rules; the operator stopped it by hand.
 * The browser tools are claude-in-chrome (mcp__claude-in-chrome__*) and clickr (mcp__clickr__*).
 * Bash: playwright/puppeteer/selenium runs, installs, browser-binary downloads, `--headless` Chrome, and a runner
 * (node/tsx/python…) on a script that imports one. Edit/Write: adding such an import to a source file, except in a repo
 * whose package.json already lists one (an existing product dependency).
 * Pure but for reading the named script files / package.json (read errors allow).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseCommand } from "./worker-guard.js";

export const BROWSER_AUTOMATION_DENY_MESSAGE =
  "No headless browsers (operator rule). Use the claude-in-chrome MCP tools (navigate, find, read_page, javascript_tool, computer screenshot/zoom) for web pages, or clickr for native apps.";

const JS_PKGS = new Set(["playwright", "@playwright/test", "playwright-core", "puppeteer", "puppeteer-core", "selenium-webdriver", "@puppeteer/browsers"]);
const PY_PKGS = new Set(["playwright", "selenium", "pyppeteer"]);
const PY_MODS = new Set(["playwright", "pyppeteer", "selenium"]);
const RUNNERS = /^(node|nodejs|tsx|ts-node|bun|deno|python|python3(\.\d+)?|python2|uv|pipx)$/;
const SCRIPT_EXT = /\.(m?[jt]s|cjs|cts|tsx|jsx|py)$/;
const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\(\s*)['"]?(playwright(?:-core)?|@playwright\/test|puppeteer(?:-core)?|selenium(?:-webdriver)?|pyppeteer)\b/;
const PREFIXES = new Set(["nohup", "sudo", "exec", "env", "setsid", "time", "command", "caffeinate", "nice", "arch"]);
const CHROME_BIN = /^(google[- ]chrome(-stable)?|google chrome( for testing)?|chromium(-browser)?|chrome|chrome-headless-shell)$/i;
const isAssignment = (w: string): boolean => /^[A-Za-z_]\w*=/.test(w);
const pos = (args: string[]): string[] => args.filter((a) => !a.startsWith("-"));
const pkgName = (a: string): string => a.replace(/^(@[^/@]+\/[^@]+|[^@]+)@.*$/, "$1");

export function importsBrowserAutomation(text: string): boolean {
  return IMPORT_RE.test(text);
}

function scriptImports(word: string, cwds: string[]): boolean {
  for (const d of cwds) {
    try {
      const p = resolve(d, word);
      if (existsSync(p) && IMPORT_RE.test(readFileSync(p, "utf8"))) return true;
    } catch { /* unreadable: allow */ }
  }
  return false;
}

function segmentDenied(words: string[], cwds: string[], raw: string): boolean {
  let i = 0;
  while (i < words.length && (isAssignment(words[i]) || PREFIXES.has(words[i]))) i++;
  const w = words.slice(i);
  if (!w.length) return false;
  const cmd = basename(w[0]);
  const args = w.slice(1);
  const p = pos(args);

  if (cmd === "playwright" || cmd === "puppeteer" || cmd === "playwright-core") return true;
  if (CHROME_BIN.test(cmd) && args.some((a) => a === "--headless" || a.startsWith("--headless="))) return true;
  if (/^(npx|bunx|pnpx)$/.test(cmd) || (/^(pnpm|yarn|bun)$/.test(cmd) && /^(dlx|x|exec)$/.test(p[0] ?? ""))) {
    const rest = /^(npx|bunx|pnpx)$/.test(cmd) ? p : p.slice(1);
    if (rest[0] && JS_PKGS.has(pkgName(rest[0]))) return true;
    // `npx tsx script.ts` / `npx node x.js`: the runner form below
    if (rest[0] && RUNNERS.test(basename(rest[0]))) return segmentDenied(rest.length ? [rest[0], ...args.slice(args.indexOf(rest[0]) + 1)] : [], cwds, raw);
    return false;
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd) && /^(add|install|i)$/.test(p[0] ?? "")) return p.slice(1).some((a) => JS_PKGS.has(pkgName(a)));
  if (/^pip3?(\.\d+)?$/.test(cmd) && /^install$/.test(p[0] ?? "")) return p.slice(1).some((a) => PY_PKGS.has(pkgName(a).replace(/[=<>~!].*$/, "")));
  if (cmd === "uv" || cmd === "pipx") {
    const sub = p[0] === "pip" ? p.slice(1) : p;
    if (/^(install|add)$/.test(sub[0] ?? "")) return sub.slice(1).some((a) => PY_PKGS.has(pkgName(a).replace(/[=<>~!].*$/, "")));
  }
  if (RUNNERS.test(cmd)) {
    const m = args.indexOf("-m");
    if (/^python/.test(cmd) && m >= 0) {
      const mod = args[m + 1];
      if (mod && PY_MODS.has(mod.split(".")[0])) return true;
      if (mod === "pip") return pos(args.slice(m + 2)).slice(1).some((a) => PY_PKGS.has(pkgName(a).replace(/[=<>~!].*$/, "")));
    }
    if (args.some((a) => SCRIPT_EXT.test(a) && scriptImports(a, cwds))) return true;
    // inline code or a heredoc fed to the interpreter
    if (args.some((a) => a === "-e" || a === "-c" || a === "-" || a === "--eval") || /<<-?\s*['"]?\w+/.test(raw)) return IMPORT_RE.test(raw);
  }
  return false;
}

/** Deny message when a Bash command runs, installs or downloads headless-browser automation, else null. */
export function browserAutomationBashReason(command: string, cwd: string, scratch?: string): string | null {
  const cwds = [cwd, scratch, "."].filter((d): d is string => !!d);
  const segs = parseCommand(command);
  const nested = (ws: string[]): string[] => (/^(bash|sh|zsh)$/.test(basename(ws[0] ?? "")) && ws[1] === "-c" && ws[2] ? [ws[2]] : []);
  for (const s of segs) {
    if (segmentDenied(s.words, cwds, command)) return BROWSER_AUTOMATION_DENY_MESSAGE;
    for (const inner of nested(s.words)) if (browserAutomationBashReason(inner, cwd, scratch)) return BROWSER_AUTOMATION_DENY_MESSAGE;
  }
  return null;
}

const SOURCE_EXT = /\.(m?[jt]sx?|cjs|cts|py|sh|zsh|bash)$/;

/** True when a package.json at or above `file` lists a browser-automation package as a dependency. */
function repoDependsOnAutomation(file: string): boolean {
  let d = dirname(file);
  for (let n = 0; n < 40; n++) {
    const pj = resolve(d, "package.json");
    try {
      if (existsSync(pj)) {
        const j = JSON.parse(readFileSync(pj, "utf8")) as Record<string, Record<string, string> | undefined>;
        for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          if (Object.keys(j[k] ?? {}).some((x) => JS_PKGS.has(x) || x === "selenium-webdriver")) return true;
        }
      }
    } catch { /* unreadable: keep walking */ }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}

/** Deny message when an Edit/Write adds a browser-automation import to a source file, else null. */
export function browserAutomationEditReason(filePath: string, added: string | undefined): string | null {
  if (!added || !SOURCE_EXT.test(filePath) || !IMPORT_RE.test(added)) return null;
  return repoDependsOnAutomation(filePath) ? null : BROWSER_AUTOMATION_DENY_MESSAGE;
}

/** The text an Edit/Write/MultiEdit adds. */
export function addedText(ti: { content?: unknown; new_string?: unknown; edits?: unknown }): string {
  const parts: string[] = [];
  if (typeof ti.content === "string") parts.push(ti.content);
  if (typeof ti.new_string === "string") parts.push(ti.new_string);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (typeof (e as { new_string?: unknown })?.new_string === "string") parts.push((e as { new_string: string }).new_string);
  return parts.join("\n");
}
