/**
 * edit-gate.ts — the decision behind the PreToolUse edit-routing gate.
 *
 * Pure: no stdin, no filesystem, no process.env read of its own. The hook
 * entry (pre-tool-use/route-edits-to-worker.ts) resolves paths and checks the
 * filesystem/env, then hands this module the already-computed facts to
 * decide on — same split as lib/agent-gate.ts.
 */

import { basename, extname } from "node:path";
import { scriptWritesRepoCode } from "./orchestrator-script-writes.js";

export const SCRATCH_DIR = ".pai-scratch";

export interface EditGateContext {
  /** Absolute, already-resolved target path. */
  filePath: string;
  isPaiWorker: boolean;
  isExemptPrefix: boolean;
  isGitWorkTree: boolean;
}

export type EditGateDecision = { decision: "allow" } | { decision: "block"; reason: string };

/** Extensions that are prose regardless of which directory they live in. */
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/**
 * True for notes, session logs, handovers and other prose the outer session
 * writes directly instead of routing through a worker — a `Notes`/`notes`
 * directory segment anywhere in the path, or a prose file extension.
 * Extension check runs first: a source file that happens to live under a
 * `notes/` directory is still code, but `src/foo.md` is still prose.
 */
export function isProseEdit(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (PROSE_EXTENSIONS.has(ext)) return true;
  return filePath.split(/[\\/]/).some((segment) => segment === "Notes" || segment === "notes");
}

export function isOrchestratorScratch(filePath: string): boolean {
  return filePath.split(/[\\/]/).some((segment) => segment === SCRATCH_DIR);
}

export function decideOrchestratorEdit(filePath: string): EditGateDecision {
  if (isProseEdit(filePath)) return { decision: "allow" };
  if (
    filePath === "/tmp" ||
    filePath.startsWith("/tmp/") ||
    filePath === "/private/tmp" ||
    filePath.startsWith("/private/tmp/")
  ) {
    return { decision: "allow" };
  }
  if (isOrchestratorScratch(filePath)) {
    return { decision: "allow" };
  }
  return {
    decision: "block",
    reason: `orchestrator mode: this worker plans and reviews and does not edit code — retrying Edit/Write on ${filePath} or any other code file will be denied the same way. Next step: write a unit spec to a file under /tmp, then run pai worker run --provider <the local provider named in your brief> --class implement -p "$(cat <spec>)" and review its diff when it finishes (target: ${filePath}). Throwaway verification files (test scripts, dumps) may be written under ${SCRATCH_DIR}/ in your worktree (gitignored, never committed); run them with npx vitest run --dir ${SCRATCH_DIR}.`,
  };
}

const CODE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|c|cc|cpp|h|sh|css|html|yml|yaml|toml)";
const IN_PLACE = /\bsed\s+(?:-[A-Za-z]*i|--in-place)|\bperl\s+-[A-Za-z0-9]*i/;
const REDIRECT = new RegExp(`(?<![>&\\d])>>?\\s*(\\S+\\.${CODE_EXT})(?=\\s|$|[;&|)])`, "g");
const TEE = new RegExp(`\\btee\\s+(?:-[a-z]+\\s+)*(\\S+\\.${CODE_EXT})(?=\\s|$|[;&|)])`, "g");

const isScratch = (p: string): boolean => /^(?:\/private)?\/tmp\//.test(p) || isOrchestratorScratch(p);

const CODE_PATH = new RegExp(`\\.${CODE_EXT}$`, "i");
const HAS_EXT = /\.[A-Za-z0-9]+$/;

/** Quote-aware split of one shell segment into words (quotes removed; empty quoted words kept). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  for (const m of segment.matchAll(/(?:"([^"]*)"|'([^']*)'|[^\s"']+)+/g)) {
    words.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b));
  }
  return words;
}

/**
 * Target files of one in-place sed/perl segment, or null when they cannot be
 * determined. Skips options and the script (first positional for sed unless
 * -e/-f was given; the argument of -e for perl).
 */
function inPlaceTargets(segment: string): string[] | null {
  const words = shellWords(segment);
  const start = words.findIndex((w) => w === "sed" || w === "perl");
  if (start < 0) return null;
  const isSed = words[start] === "sed";
  const targets: string[] = [];
  let scriptSeen = !isSed;
  for (let i = start + 1; i < words.length; i++) {
    const w = words[i];
    if (w === "") continue;
    if (/^-[A-Za-z0-9]*[ef]$/.test(w)) {
      i++;
      scriptSeen = true;
      continue;
    }
    if (w.startsWith("-")) continue;
    if (!scriptSeen) {
      scriptSeen = true;
      continue;
    }
    targets.push(w);
  }
  return targets.length > 0 ? targets : null;
}

const GLOB_OR_VAR = /[$`(){}~]/;

function isNonCodeTarget(path: string, inScratchDir: boolean): boolean {
  if (GLOB_OR_VAR.test(path)) return false;
  if (isScratch(path) || (inScratchDir && !path.startsWith("/"))) return true;
  if (/[*?[]/.test(path)) {
    // glob: only the literal extension is known
    return HAS_EXT.test(path) && !/[*?[]/.test(path.slice(path.lastIndexOf(".")));
  }
  return HAS_EXT.test(path) && !CODE_PATH.test(path);
}

/** True when every in-place sed/perl segment in the command has only non-code targets. */
function inPlaceTargetsAllNonCode(command: string): boolean {
  let scratchCwd = false;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const cd = /^\s*cd\s+(\S+)/.exec(segment);
    if (cd) scratchCwd = isScratch(cd[1].replace(/^["']|["']$/g, "") + "/");
    if (!IN_PLACE.test(segment)) continue;
    const targets = inPlaceTargets(segment);
    if (!targets || !targets.every((t) => isNonCodeTarget(t, scratchCwd))) return false;
  }
  return true;
}

const ORCHESTRATOR_BASH_PREFIX = "orchestrator mode: Bash may not write code files";

/** Bash for an orchestrator worker: blocks in-place code writes, allows git mv/rm/merge and running tests. */
export function decideOrchestratorBash(command: string): EditGateDecision {
  const writesCode =
    (IN_PLACE.test(command) && !inPlaceTargetsAllNonCode(command)) ||
    [...command.matchAll(REDIRECT), ...command.matchAll(TEE)].some((m) => !isScratch(m[1])) ||
    scriptWritesRepoCode(command);
  if (!writesCode) return { decision: "allow" };
  return {
    decision: "block",
    reason:
      ORCHESTRATOR_BASH_PREFIX + " in place. Write a unit spec to a file under /tmp and run pai worker run --provider <the local provider named in your brief> --class implement -p \"$(cat <spec>)\" instead; git mv, git rm, git merge and running tests are allowed. Scratch files go under .pai-scratch/ (allowed).",
  };
}

export function decideEditGate(ctx: EditGateContext): EditGateDecision {
  if (ctx.isPaiWorker) return { decision: "allow" };
  if (ctx.isExemptPrefix) return { decision: "allow" };
  if (isProseEdit(ctx.filePath)) return { decision: "allow" };
  if (!ctx.isGitWorkTree) return { decision: "allow" };

  const label = basename(ctx.filePath).slice(0, 60) || "edit";
  return {
    decision: "block",
    reason:
      `main session does not edit code — this is a standing policy for the whole session, not a problem ` +
      `with this edit: retrying Edit/Write on ${ctx.filePath} or any other code file will be denied the ` +
      `same way. Next step: write a spec file, then run ` +
      `pai worker run --label "${label}" --class implement --provider anthropic --output-format json -p "$(cat <spec>)" ` +
      `(target: ${ctx.filePath})`,
  };
}
