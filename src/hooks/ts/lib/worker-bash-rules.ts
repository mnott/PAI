/**
 * worker-bash-rules.ts — enforce bash command rules in workers.
 *
 * Pure functions that return deny reason strings or null, for use in worker-guard.ts.
 * These functions are called after prefix stripping but before other processing.
 */
import { parseCommand } from "./worker-guard.js";

/** Guard reason texts; tool-errors.ts builds its guard-redirect rule from these. */
const NODE_ON_TS_PREFIX = "node cannot load TypeScript source";
export const NODE_ON_TS_REASON = NODE_ON_TS_PREFIX + ". Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.";
const IGNORED_PATH_PREFIX = "Notes/ and other ignored paths stay untracked";
export const IGNORED_PATH_REASON = IGNORED_PATH_PREFIX + "; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)";

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

    // Skip prefix stripping - we handle that ourselves
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    while (i < words.length && ["sudo", "time", "env", "nohup", "npx"].includes(words[i])) i++;

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

    // Skip prefix stripping - we handle that ourselves
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    while (i < words.length && ["sudo", "time", "env", "nohup"].includes(words[i])) i++;

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
  const segments = parseCommand(command);
  for (const segment of segments) {
    const words = segment.words;
    if (words.length === 0) continue;

    // Skip prefix stripping - we handle that ourselves
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    while (i < words.length && ["sudo", "time", "env", "nohup"].includes(words[i])) i++;

    if (i >= words.length) continue;

    // Check if it's a git add command
    const cmd = words[i];
    if (cmd === "git" && words[i + 1] === "add") {
      const args = words.slice(i + 2);
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

      // Check positional paths
      for (const arg of args) {
        // Skip flags and special arguments
        if (arg.startsWith("-") || arg === "." || arg === "-A" || arg === "-u" || arg === "-p") continue;

        // Helper to check if a path should be ignored, including paths containing .pai-scratch
        const ignoredPath = (p: string, isIgnored: (p: string) => boolean) => p.split("/").includes(".pai-scratch") || isIgnored(p);

        // Check if path is ignored
        if (ignoredPath(arg, isIgnored)) {
          return IGNORED_PATH_REASON;
        }
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
  const paths: string[] = [];
  const segments = parseCommand(command);
  for (const segment of segments) {
    const words = segment.words;
    if (words.length < 2) continue;

    // Skip prefix stripping - we handle that ourselves
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    while (i < words.length && ["sudo", "time", "env", "nohup"].includes(words[i])) i++;

    if (i >= words.length) continue;

    // Check if it's a git add command
    const cmd = words[i];
    if (cmd === "git" && words[i + 1] === "add") {
      const args = words.slice(i + 2);
      for (const arg of args) {
        // Skip flags and special arguments
        if (arg.startsWith("-") || arg === "." || arg === "-A" || arg === "-u" || arg === "-p") continue;
        paths.push(arg);
      }
    }
  }
  return paths;
}