/**
 * headless-gate.ts — a worker runs headless: nothing may appear on the operator's screen.
 *
 * Evidence: a worker compiled throwaway Swift probes that set an NSApplication activation policy and
 * showed an NSWindow; the windows popped up on the operator's desktop. Worker-only (PAI_WORKER=1).
 * Denies, at command position: `open`, `osascript` that activates/displays, `swift`/`swiftc` of a source
 * (a .swift file's content or -e text) that creates windows, and a .app bundle binary run directly.
 * `swift build`, `xcodebuild`, `swift test` and text like `git log --open` or `grep open` stay allowed.
 * Pure but for reading the named .swift files (read errors allow).
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseCommand } from "./worker-guard.js";

export const HEADLESS_DENY_MESSAGE = "workers are headless: nothing may appear on the operator's screen; render offscreen to a file and read it";

const PREFIXES = new Set(["nohup", "sudo", "exec", "env", "setsid", "time", "command", "caffeinate", "nice", "xcrun", "arch"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const OSA_SCREEN = /\bactivate\b|display\s+dialog|display\s+notification|tell\s+application\s+("[^"]*"|\S+)\s+to\s+open/i;
const SWIFT_WINDOW = /setActivationPolicy|NSWindow\s*\(|makeKeyAndOrderFront|orderFront|NSApp\.run|NSApplication\.shared\.run|NSApplicationMain|@main\s+struct\s+\w+\s*:\s*App\b/;
const isAssignment = (w: string): boolean => /^[A-Za-z_]\w*=/.test(w);
const bare = (w: string): string => w.replace(/^(\$\(|[({`])+/, "");

function swiftSourceOpensWindow(words: string[], cwd: string): boolean {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-e" && words[i + 1] !== undefined) {
      if (SWIFT_WINDOW.test(words[i + 1])) return true;
    } else if (w.endsWith(".swift")) {
      try {
        if (SWIFT_WINDOW.test(readFileSync(resolve(cwd, w), "utf8"))) return true;
      } catch { /* unreadable: allow */ }
    }
  }
  return false;
}

const APP_BIN = /\.app\/Contents\/MacOS\//;
const APP_ARG = /\.app(\/|\b)/;
const DEBUGGERS = new Set(["lldb", "gdb", "lldb-rpc-server"]);

/** Names of variables assigned a .app/Contents/MacOS path anywhere in the command. */
function appVars(segments: { words: string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const s of segments) for (const w of s.words) {
    const m = /^([A-Za-z_]\w*)=(.*)$/.exec(w);
    if (m && APP_BIN.test(m[2])) out.add(m[1]);
  }
  return out;
}

function segmentDenied(words: string[], cwd: string, depth: number, vars: Set<string> = new Set()): boolean {
  let i = 0;
  while (i < words.length && (isAssignment(words[i]) || PREFIXES.has(bare(words[i])) || /^-/.test(words[i]) && i > 0)) i++;
  const w = words.slice(i);
  if (!w.length) return false;
  const first = bare(w[0]);
  const bin = basename(first);
  if (bin === "open") return true;
  if (bin === "osascript") return OSA_SCREEN.test(w.join(" "));
  if (bin === "swift" || bin === "swiftc") return swiftSourceOpensWindow(w, cwd);
  if (APP_BIN.test(first)) return true;
  const v = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(first);
  if (v && vars.has(v[1])) return true;
  if (DEBUGGERS.has(bin)) return w.slice(1).some((a) => APP_ARG.test(a));
  if (bin === "launchctl") return /^(submit|asuser)$/.test(w[1] ?? "") && w.slice(2).some((a) => APP_ARG.test(a));
  if (SHELLS.has(bin) && depth < 2) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined) return headlessDenied(w[c + 1], cwd, depth + 1);
  }
  return false;
}

function headlessDenied(command: string, cwd: string, depth: number): boolean {
  if (/(\$\(|`)\s*open\s/.test(command)) return true;
  const segs = parseCommand(command);
  const vars = appVars(segs);
  return segs.some((s) => segmentDenied(s.words, cwd, depth, vars));
}

/** Deny reason for a worker's Bash command that would show something on screen, else null. */
export function headlessReason(command: string, env: Record<string, string | undefined>, cwd: string): string | null {
  if (env.PAI_WORKER !== "1") return null;
  return headlessDenied(command, cwd, 0) ? HEADLESS_DENY_MESSAGE : null;
}
