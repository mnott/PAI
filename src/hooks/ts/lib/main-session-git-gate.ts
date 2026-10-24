/**
 * main-session-git-gate.ts — Bash commands the main (non-worker) session may not run.
 *
 * Pure: the hook entry (pre-tool-use/block-sleep-poll.ts) does the I/O.
 *  - slot worktrees (<logDir>/slots/<name>) belong to running local units:
 *    no git checkout|switch|reset|clean|stash aimed at one (`-C <dir>` or an earlier `cd`);
 *  - worktrees and worker/ branches are removed by `pai worker discard|gc`,
 *    which salvage gitignored notes and archive commits first.
 */

import { resolve } from "node:path";
import { parseCommand } from "./worker-guard.js";

export const SLOT_GIT_REASON =
  "slot worktrees are used by running local units: do not check out, switch, reset, clean or stash in them; inspect with `git -C <slot> diff --stat` or `pai worker replay <id>`";
export const AD_HOC_REMOVAL_REASON =
  "do not remove worktrees or worker branches by hand: use `pai worker discard <id>`, `pai worker discard --worktree <path>` (any linked worktree, any repo) or `pai worker gc` (they salvage gitignored notes and archive commits first)";

const SLOT_MUTATING = new Set(["checkout", "switch", "reset", "clean", "stash"]);
const inSlots = (p: string): boolean => /(^|\/)workers\/slots(\/|$)/.test(p);

/** The git subcommand, its args, and the `-C` directories of a segment's words (after env/sudo prefixes), or null when not git. */
function parseGit(words: string[]): { dirs: string[]; sub: string; args: string[] } | null {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || ["sudo", "time", "env", "nohup"].includes(words[i]))) i++;
  if (words[i] !== "git") return null;
  const dirs: string[] = [];
  for (i++; i < words.length; i++) {
    if (words[i] === "-C" && i + 1 < words.length) dirs.push(words[++i]);
    else if (words[i] === "-c" && i + 1 < words.length) i++;
    else if (words[i].startsWith("-")) continue;
    else break;
  }
  return i < words.length ? { dirs, sub: words[i], args: words.slice(i + 1) } : null;
}

/** Deny reason for a main-session Bash command, or null. `cwd` is the session's working directory. */
export function mainSessionBashReason(command: string, cwd: string): string | null {
  let at = cwd;
  for (const { words } of parseCommand(command)) {
    if (words[0] === "cd" && words[1]) {
      at = resolve(at, words[1]);
      continue;
    }
    const g = parseGit(words);
    if (!g) continue;
    if (SLOT_MUTATING.has(g.sub)) {
      let dir = at;
      for (const d of g.dirs) dir = resolve(dir, d);
      if (inSlots(dir)) return SLOT_GIT_REASON;
    }
    if (g.sub === "worktree" && (g.args[0] === "remove" || g.args[0] === "prune")) return AD_HOC_REMOVAL_REASON;
    if (g.sub === "branch" && g.args.some((a) => /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(a) || a === "--delete") && g.args.some((a) => a.startsWith("worker/"))) {
      return AD_HOC_REMOVAL_REASON;
    }
  }
  return null;
}
