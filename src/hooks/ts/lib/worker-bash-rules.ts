/**
 * worker-bash-rules.ts — enforce bash command rules in workers.
 *
 * Pure functions that return deny reason strings or null, for use in worker-guard.ts.
 * These functions are called after prefix stripping but before other processing.
 */
import { parseCommand } from "./worker-guard.js";
import { dropHeredocBodies } from "./heredoc.js";

/** Guard reason texts; tool-errors.ts builds its guard-redirect rule from these. */
const NODE_ON_TS_PREFIX = "node cannot load TypeScript source";
export const NODE_ON_TS_REASON = NODE_ON_TS_PREFIX + ". Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.";
const IGNORED_PATH_PREFIX = "Notes/ and other ignored paths stay untracked";
export const IGNORED_PATH_REASON = IGNORED_PATH_PREFIX + "; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)";

const WRAPPERS = ["sudo", "time", "env", "nohup"];

/** Index of the command word: past leading `VAR=value` assignments and the given wrapper words. */
function commandStart(words: string[], wrappers: string[]): number {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
  while (i < words.length && wrappers.includes(words[i])) i++;
  return i;
}

/** The arguments after `git add` of every such segment of the command. */
function gitAddArgs(command: string): string[][] {
  const out: string[][] = [];
  for (const { words } of parseCommand(command)) {
    const i = commandStart(words, WRAPPERS);
    if (i < words.length && words[i] === "git" && words[i + 1] === "add") out.push(words.slice(i + 2));
  }
  return out;
}

/** A `git add` argument that names a path: not a flag, not `.`. */
const isGitAddPath = (arg: string): boolean => !arg.startsWith("-") && arg !== ".";


/** Returns exactly "node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`." when any segment (after prefix strip) is:
 * - `node` (not `tsx`, not `npx tsx`) whose positional (non-flag) first argument ends in `.ts` or `.tsx` or `.mts`;
 * - `node --test` (flag --test present) with any argument ending in `.ts`;
 * - `node -e <code>` or `node --eval <code>` or `node -p <code>` where the code string contains `require(` or `import(` or `from "` / `from '` of a path that contains `src/` and ends in `.js` or `.ts` (regex like /(?:require|import)\s*\(?\s*['"][^'"]*src\/[^'"]*\.(?:js|ts)['"]/ or `from ['"][^'"]*src/[^'"]*\.(?:js|ts)['"]`).
 * Note parseCommand already removes quotes, so the -e code arrives as one word.
 * Must NOT trigger for: `node scripts/build-hooks.mjs`, `node dist/x.js`, `npx tsx foo.ts`, `node -e "console.log(1)"`, `node --version`.
 */
export function nodeOnTypeScriptReason(command: string): string | null {
  const segments = parseCommand(command);
  for (const segment of segments) {
    const words = segment.words;
    if (words.length === 0) continue;

    let i = commandStart(words, [...WRAPPERS, "npx"]);

    if (i >= words.length) continue;

    const cmd = words[i];
    if (cmd === "node") {
      // Check if this is `npx tsx` or `tsx`
      if (i > 0 && words[i - 1] === "npx" && words[i + 1] === "tsx") {
        continue;
      }

      // Check for `node --test` with .ts argument
      if (words[i + 1] === "--test") {
        const args = words.slice(i + 2);
        for (const arg of args) {
          if (arg.endsWith(".ts") && !arg.endsWith(".mjs")) {
            return NODE_ON_TS_REASON;
          }
        }
        continue;
      }

      // Check for node -e, node --eval, node -p with code that requires/import src files
      if (words[i + 1] === "-e" || words[i + 1] === "--eval" || words[i + 1] === "-p") {
        const code = words[i + 2];
        if (code && (/(?:require|import)\s*\(\s*['"][^'"]*src\/[^'"]*\.(?:js|ts)['"]/.test(code) || /from\s+['"][^'"]*src\/[^'"]*\.(?:js|ts)['"]/.test(code))) {
          return NODE_ON_TS_REASON;
        }
        continue;
      }

      // Check for node with .ts/.tsx/.mts file argument
      const args = words.slice(i + 1);
      for (const arg of args) {
        if (arg.endsWith(".ts") || arg.endsWith(".tsx") || arg.endsWith(".mts")) {
          // Skip cases that are allowed
          if (arg.endsWith(".mjs") || arg.endsWith(".js")) continue;
          return NODE_ON_TS_REASON;
        }
      }
    }
  }
  return null;
}

/**
 * Returns exactly "tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file" when a segment (after prefix strip; `npx tsc`, `tsc`, `npx --no-install tsc`, `./node_modules/.bin/tsc`) has any positional argument ending in `.ts`/`.tsx`/`.mts`. Not for `tsc --noEmit`, `tsc -p tsconfig.json`, `tsc --noEmit -p tsconfig.json`.
 */
export function tscFileArgReason(command: string): string | null {
  const segments = parseCommand(command);
  for (const segment of segments) {
    const words = segment.words;
    if (words.length === 0) continue;

    let i = commandStart(words, WRAPPERS);

    if (i >= words.length) continue;

    // Skip npx flags that directly follow npx
    if (words[i] === "npx") {
      let j = i + 1;
      while (j < words.length && words[j].startsWith("-")) j++;
      if (j < words.length && words[j] === "tsc") {
        i = j; // Move i to point to "tsc"
      }
    }

    const cmd = words[i];
    if (cmd === "tsc" || (cmd === "npx" && words[i + 1] === "tsc") || cmd === "./node_modules/.bin/tsc") {
      // Check for positional arguments ending in .ts/.tsx/.mts
      const args = words.slice(i + 1);
      for (const arg of args) {
        if (arg.endsWith(".ts") || arg.endsWith(".tsx") || arg.endsWith(".mts")) {
          // Check if this is a tsc command that should be allowed
          // Allow tsc --noEmit -p tsconfig.json or tsc -p tsconfig.json (but not just tsc -p)
          const isNoEmit = words.includes("--noEmit");
          const hasPFlag = words.includes("-p") || words.some(w => w.startsWith("--p"));

          // If it's a flag that's being passed, and not a file arg, it's not a deny
          if (arg === "--noEmit" || arg === "-p" || arg.startsWith("--p")) {
            continue;
          }

          // If we have --noEmit and -p, it's allowed
          if (isNoEmit && hasPFlag) {
            continue;
          }

          // If we have a file argument and no explicit --noEmit, deny it
          return "tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file";
        }
      }

      // If it's a direct tsc call without file args, it's fine
      if (cmd === "tsc" && args.length === 0) {
        continue;
      }

      // If it's an npx tsc call without file args, it's also fine
      if (cmd === "npx" && words[i + 1] === "tsc" && args.length === 0) {
        continue;
      }

      // If it's a direct tsc call with file args but without --noEmit, it's a deny
      if (cmd === "tsc" && args.some(arg => arg.endsWith(".ts") || arg.endsWith(".tsx") || arg.endsWith(".mts")) && !words.includes("--noEmit")) {
        return "tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file";
      }
    }
  }
  return null;
}

/**
 * For a segment `git add ...` (also `git -C dir add`): if args include `-f` or `--force` (or a combined short flag containing f like `-fA`; NOT `-A`, `-u`, `-p`) return the reason; else if any positional path (not `.`, not `-A`) makes isIgnored(path) true return the reason.
 * Reason text exactly: "Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)".
 */
export function forceAddReason(command: string, isIgnored: (path: string) => boolean): string | null {
  for (const args of gitAddArgs(command)) {
    for (const arg of args) {
      // Check for -f, --force flags
      if (arg === "-f" || arg === "--force") {
        return IGNORED_PATH_REASON;
      }
      // Check for combined flags like -fA, -Af
      if (arg.length > 1 && arg.startsWith("-") && arg.includes("f") && !arg.includes("A") && !arg.includes("u") && !arg.includes("p")) {
        return IGNORED_PATH_REASON;
      }
    }

    // Paths containing .pai-scratch count as ignored too
    for (const arg of args.filter(isGitAddPath)) {
      if (arg.split("/").includes(".pai-scratch") || isIgnored(arg)) {
        return IGNORED_PATH_REASON;
      }
    }
  }
  return null;
}

/**
 * Returns the positional paths of all `git add` segments in the command.
 * Used by the caller to pre-compute ignore status.
 */
export function gitAddPaths(command: string): string[] {
  return gitAddArgs(command).flatMap((args) => args.filter(isGitAddPath));
}

export const MASKED_PROOF_REASON = "proof command with a masked result (`> /dev/null`, `||`, `; true`): run it bare and read the output";

const PROOF_COMMAND = /(?:^|\s)(?:(?:npx|pnpm exec|\.\/node_modules\/\.bin\/)\s*)?(?:tsc|vitest)(?:\s|$)|\bnpm\s+(?:run\s+)?test\b|\bpai\s+worker\s+merge\b[^|;&\n]*--verify\b/;

/** Reason when a tsc/vitest/npm test/`pai worker merge --verify` segment hides its result: output to /dev/null, followed by `||`, or followed by a bare `true`/`:`. Heredoc bodies are ignored. */
export function maskedProofReason(command: string): string | null {
  const parts = dropHeredocBodies(command).split(/(\|\||&&|;|\n|\|)/);
  for (let i = 0; i < parts.length; i += 2) {
    if (!PROOF_COMMAND.test(parts[i])) continue;
    if (/(?:^|[\s\d&])>>?\s*\/dev\/null/.test(parts[i])) return MASKED_PROOF_REASON;
    const delim = parts[i + 1];
    if (delim === "||") return MASKED_PROOF_REASON;
    if (delim === ";" && /^\s*(?:true|:)\s*$/.test(parts[i + 2] ?? "")) return MASKED_PROOF_REASON;
  }
  return null;
}

const SHARED_TMP = /^(?:\/private)?\/tmp\/(?!claude-)[^/\s]/;
const INTERPRETERS = new Set(["python", "python3", "node", "tsx", "sh", "bash", "zsh", "ruby", "perl"]);
export function tmpScratchMessage(): string {
  const dir = process.env.TMPDIR?.replace(/\/+$/, "");
  const where = dir ? ` — your scratch dir is ${dir} (write that absolute path; the Write tool does not expand $TMPDIR)` : "";
  return `literal /tmp/<name> is shared by every concurrent worker (another worker's file of that name runs in your tree): use "$TMPDIR/<name>", which is private to this worker${where}`;
}

/** Reason when a command writes (`>`, `>>`, tee, cp/mv target) or runs (python3/node/sh/bash <file>) a literal fixed /tmp path. Reading, /tmp/claude-*, and $TMPDIR paths pass. */
export function tmpScratchReason(command: string): string | null {
  for (const { words, redirects } of parseCommand(command)) {
    if (redirects.some((r) => SHARED_TMP.test(r))) return tmpScratchMessage();
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    const cmd = words[0];
    if ((cmd === "bash" || cmd === "sh" || cmd === "zsh") && words[1] === "-c" && words[2]) {
      const inner = tmpScratchReason(words[2]);
      if (inner) return inner;
    }
    if (cmd === "tee" && args.some((w) => SHARED_TMP.test(w))) return tmpScratchMessage();
    if ((cmd === "cp" || cmd === "mv") && args.length > 0 && SHARED_TMP.test(args[args.length - 1])) return tmpScratchMessage();
    if (INTERPRETERS.has(cmd) && args.length > 0 && SHARED_TMP.test(args[0])) return tmpScratchMessage();
  }
  return null;
}
