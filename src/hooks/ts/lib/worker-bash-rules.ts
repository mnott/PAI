/**
 * worker-bash-rules.ts — enforce bash command rules in workers.
 *
 * Pure functions that return deny reason strings or null, for use in worker-guard.ts.
 * These functions are called after prefix stripping but before other processing.
 */
import { parseCommand } from "./worker-guard.js";
import { dropHeredocBodies } from "./heredoc.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * The arguments after `git add`, plus the directory that `git add` itself runs
 * in: the hook cwd advanced past the preceding `cd` segments of the same
 * command, overridden by a `git -C <dir>` on the add itself. Checking ignore
 * status from the hook cwd alone misjudged relative paths when the shell had
 * `cd`-ed into an ignored dir (observed 2026-10-28: every path of
 * `cd .. && git add …` counted as ignored).
 * `dir` stays the hook cwd when it cannot be resolved (a `cd` to a path with
 * unresolvable variables falls back, as before). cd tracking follows the
 * parseCommand segments directly; `cwdAfterCds` splits on a different grammar
 * and misses `cd` inside `&&` chains.
 */
function gitAddSegments(command: string, cwd: string): { args: string[]; dir: string }[] {
  const out: { args: string[]; dir: string }[] = [];
  let here = cwd;
  for (const { words } of parseCommand(command)) {
    const i = commandStart(words, WRAPPERS);
    if (i < words.length && words[i] === "cd") {
      const arg = words.slice(i + 1).find((w) => !w.startsWith("-"));
      if (arg !== undefined && !/[$`]/.test(arg)) here = resolve(here, arg);
      continue;
    }
    if (i >= words.length || words[i] !== "git") continue;
    // `git -C <dir>` / `git -C=<dir>` retargets the add (and any -C before it).
    let dir = here;
    let j = i + 1;
    while (j < words.length && words[j].startsWith("-")) {
      if (words[j] === "-C") dir = resolve(dir, words[j + 1] ?? ""), j += 2;
      else if (words[j].startsWith("-C=")) dir = resolve(dir, words[j].slice(3)), j += 1;
      else j += 1;
    }
    if (words[j] !== "add") continue;
    out.push({ args: words.slice(j + 1), dir });
  }
  return out;
}

/** A `git add` argument that names a path: not a flag, not `.`. */
const isGitAddPath = (arg: string): boolean => !arg.startsWith("-") && arg !== ".";

/**
 * The arg as git resolves it: relative to the directory the add runs in. The
 * result is absolute — a relative one would be re-resolved against the check
 * dir by git and land somewhere else. An absolute arg is unchanged.
 */
function rebase(p: string, dir: string): string {
  return p.startsWith("/") ? p : resolve(dir, p);
}


/** node flags that take a separate value word: the next word is the flag's argument, not a file. */
const NODE_VALUE_FLAGS = new Set(["--import", "--experimental-loader", "--loader", "-r", "--require", "-c", "--conditions", "--env-file", "--permissions"]);

/** True when `w` names the tsx loader: bare `tsx`, an alias like `tsx/esm`, or a path into a tsx package. */
function isTsxName(w: string): boolean {
  return w === "tsx" || w.startsWith("tsx/") || /(^|\/)tsx(\/|$)/.test(w);
}

/** True when the command word is tsx, or node carrying a tsx loader flag (--import tsx / --loader=tsx / -r tsx). */
function runsTsx(cmd: string, rest: string[]): boolean {
  if (cmd === "tsx") return true;
  if (cmd !== "node") return false;
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    if (w === "--import" || w === "--loader" || w === "-r" || w === "--experimental-loader") {
      if (j + 1 < rest.length && isTsxName(rest[j + 1])) return true;
      continue;
    }
    if (w.startsWith("--import=") || w.startsWith("--loader=")) {
      const v = w.slice(w.indexOf("=") + 1);
      if (isTsxName(v) || /(^|\/)tsx(\.|$)/.test(v)) return true;
    }
  }
  return false;
}

/** Commands that never load a source file themselves: chains around a test runner in a tsx-test repo. */
const INERT_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "cat", "sort", "uniq", "wc", "cut", "tr", "ls", "echo", "printf", "true", "false", "test", "[", "[[", "sed", "awk"]);
/** Package managers and build tools: run their own code, never a worker's .ts file (inert in a tsx-test repo). */
const TOOL_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "node_modules/.bin/tsc", "./node_modules/.bin/tsc"]);

/** True when the segment is inert in a tsx-test repo: a shell utility, a package manager or build tool (`npm run build`, `npx tsc --noEmit`), or a git pathspec command. Plain node segments are NOT inert here — only the runner form (--test with a preload script) gets the exemption below; `node x.ts` stays denied. */
function isInertSegment(cmd: string, rest: string[]): boolean {
  return INERT_COMMANDS.has(cmd) || TOOL_COMMANDS.has(cmd) || cmd === "env" || isGitPathspecCommand(cmd, rest);
}

/** True when a plain-node segment matches the repo's tsx test script (`tsx --import ./test/home-guard.ts --test …`): `node --import ./test/home-guard.ts --test x.test.ts` is that runner under env/var prefixes. */
function matchesTestScriptRunner(rest: string[], testScript: string): boolean {
  if (!rest.includes("--test")) return false;
  const scriptFlags = new Set(testScript.split(/\s+/).filter((w) => w.startsWith("-") && !w.includes("=")));
  for (const f of rest) {
    if (f === "--test") continue;
    if (!f.startsWith("-")) break; // flags end at the first positional
    const base = f.split("=")[0];
    if (base === "--import" || base === "--loader" || base === "-r" || base === "--experimental-loader") {
      if (!scriptFlags.has(base)) return false;
      break; // its .ts value is the preload script: the form matches
    }
    if (!scriptFlags.has(base)) return false;
  }
  return true;
}

/** True when the segment runs a git command whose operands are pathspecs, not source files: `git stash` (push/pop/… with .ts paths), `git add`/`rm`/`mv`/`checkout`/`restore`/`diff`. */
function isGitPathspecCommand(cmd: string, rest: string[]): boolean {
  if (cmd !== "git") return false;
  let j = 0;
  while (j < rest.length && rest[j].startsWith("-")) {
    if ((rest[j] === "-C" || rest[j] === "-c") && j + 1 < rest.length) j += 2;
    else j += 1;
  }
  const sub = rest[j];
  return sub === "stash" || sub === "add" || sub === "rm" || sub === "mv" || sub === "checkout" || sub === "restore" || sub === "diff";
}

/** Returns exactly "node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`." when any segment (after prefix strip) is:
 * - `node` without a tsx loader whose positional argument ends in `.ts`/`.tsx`/`.mts` (`node --test x.ts` included);
 * - `node -e <code>` or `node --eval <code>` or `node -p <code>` where the code string contains `require(` or `import(` or `from "` / `from '` of a path that contains `src/` and ends in `.js` or `.ts` (regex like /(?:require|import)\s*\(?\s*['"][^'"]*src\/[^'"]*\.(?:js|ts)['"]/ or `from ['"][^'"]*src/[^'"]*\.(?:js|ts)['"]`).
 * Note parseCommand already removes quotes, so the -e code arrives as one word.
 * Must NOT trigger for: `node scripts/build-hooks.mjs`, `node dist/x.js`, `npx tsx foo.ts`, `node -e "console.log(1)"`, `node --version`.
 * tsx loads TypeScript, so every tsx form passes in any segment: bare `tsx x.ts`, `npx tsx … --test x.test.ts`, `node --import tsx …`, `node --loader tsx …`. The AIBroker test-runner form denied 2026-11-17 (`git stash push -q -m w1 -- src/x.ts; npx tsx --import ./test/home-guard.ts --test x.test.ts …`) passes on both counts: the `npx tsx` segment already skipped its `.ts` flag values (a preload script is not a plain-node file argument), and git operands ending in `.ts` are pathspecs (`git stash`/`add`/`diff` …).
 * A package's own test runner is allowed too: when the tree's package.json `scripts.test` runs tsx (AIBroker's `tsx --import ./test/home-guard.ts --test …`) — pass it as `testScript` — a command whose every segment is inert, a tsx run or a plain node run passes; its third line `node --import ./test/home-guard.ts --test x.test.ts` would otherwise read as plain node on TypeScript.
 */
export function nodeOnTypeScriptReason(command: string, testScript?: string | null): string | null {
  const segments = parseCommand(command);
  // the project runs its own tests through tsx: any segment that is inert or runs tsx/node is that runner
  const repoRunsTsx = !!testScript && /\btsx\b/.test(testScript);
  for (const segment of segments) {
    const words = segment.words;
    if (words.length === 0) continue;

    let i = commandStart(words, [...WRAPPERS, "npx", "pnpm", "bun"]);
    if (i >= words.length) continue;
    // reach the command word past npx/pnpm-exec flags (`npx --no-install tsc`)
    if (words[i] === "npx" || (words[i] === "pnpm" && words[i + 1] === "exec")) {
      let j = i + 1;
      while (j < words.length && words[j].startsWith("-")) j++;
      if (j < words.length) i = j;
    }
    if (i >= words.length) continue;

    const cmd = words[i];
    const rest = words.slice(i + 1);
    // tsx runs TypeScript: bare tsx, or node carrying a tsx loader (--import tsx / --loader=tsx / -r tsx)
    if (runsTsx(cmd, rest)) continue;
    // git operands ending in .ts are pathspecs, not source to load (`git stash push -m w1 -- src/x.ts`)
    if (isGitPathspecCommand(cmd, rest)) continue;
    // a tsx-running repo's own test command chains package managers, build tools and shell utilities around its runner: those segments never load the worker's .ts
    if (repoRunsTsx && isInertSegment(cmd, rest)) continue;

    if (cmd !== "node") continue;

    // node -e, node --eval, node -p with code that requires/imports src files
    if (rest[0] === "-e" || rest[0] === "--eval" || rest[0] === "-p") {
      const code = rest[1];
      if (code && (/(?:require|import)\s*\(\s*['"][^'"]*src\/[^'"]*\.(?:js|ts)['"]/.test(code) || /from\s+['"][^'"]*src\/[^'"]*\.(?:js|ts)['"]/.test(code))) {
        return NODE_ON_TS_REASON;
      }
      continue;
    }

    // positional arguments: walk the flags, skipping each value-taking flag's own argument. The old scan treated `--import ./x.ts` as a plain .ts file argument and denied tsx-preloaded node runs (observed 2026-11-17, worker 20261117-022500-23088).
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j];
      if (w === "--") break; // after -- node passes the rest to the script, not itself: nothing left that node loads as .ts here
      if (w.startsWith("-")) {
        const base = w.split("=")[0];
        if (!w.includes("=") && NODE_VALUE_FLAGS.has(base)) j++; // value is the next word, not a file arg
        continue;
      }
      if (/\.(ts|tsx|mts)$/.test(w)) {
        // in a tsx-test repo this node segment may be the package's own runner form (`node --import ./test/home-guard.ts --test x.test.ts`); `node x.ts` matches no test script and stays denied
        if (repoRunsTsx && testScript && matchesTestScriptRunner(rest, testScript)) break;
        return NODE_ON_TS_REASON;
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
 * For a segment `git add ...` (also `git -C dir add`): if args include `-f` or `--force` (or a combined short flag containing f like `-fA`; NOT `-A`, `-u`, `-p`) return the reason; else if any positional path (not `.`, not `-A`) makes isIgnored(path, dir) true return the reason. `dir` is where that `git add` actually runs (cd-tracked, `git -C` honoured); `path` is rebased to that dir, so the hook's `git check-ignore` sees the same path git would.
 * Reason text exactly: "Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)".
 */
export function forceAddReason(command: string, isIgnored: (path: string, dir: string) => boolean, cwd: string): string | null {
  for (const { args, dir } of gitAddSegments(command, cwd)) {
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
      if (arg.split("/").includes(".pai-scratch") || isIgnored(rebase(arg, dir), dir)) {
        return IGNORED_PATH_REASON;
      }
    }
  }
  return null;
}

/**
 * Returns the positional paths of all `git add` segments in the command, each
 * rebased to the directory its add runs in (cd-tracked from `cwd`, `git -C`
 * honoured). Used by the caller to check ignore status from that directory.
 */
export function gitAddPaths(command: string, cwd: string): { path: string; dir: string }[] {
  return gitAddSegments(command, cwd).flatMap(({ args, dir }) => args.filter(isGitAddPath).map((arg) => ({ path: rebase(arg, dir), dir })));
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

// ---------------------------------------------------------------------------
// Live-database writes (2026-11-18: a worker ran `docker exec <container> psql -U`
// with `-d <db> -c "INSERT INTO session …"` against a project's LIVE index; briefs
// alone had failed three times in two days). A SQL client whose SQL writes is
// denied in workers unless the statement declares itself read-only, the target is
// a scratch/test database (an sqlite/duckdb file in the worktree or scratch dir,
// or a container/db matching workers `guard.dbWriteAllow`), or the run started
// with --allow-db-writes (PAI_ALLOW_DB_WRITES=1).
// ---------------------------------------------------------------------------

/** The allowlist shape of workers `guard.dbWriteAllow`: globs matched case-insensitively. */
export interface DbWriteAllow {
  containers: string[];
  databases: string[];
}

/** Default allowlist (workers guard.dbWriteAllow): scratch and test db names. Container entries have no default: a container is allowed only when the user's config names it. */
export const DEFAULT_DB_WRITE_ALLOW: DbWriteAllow = { containers: [], databases: ["*_test", "*_scratch"] };

/** A workers.yaml glob against a name: `*` spans anything, case-insensitive. */
function matchGlob(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : "\\" + c)) + "$", "i");
  return re.test(name);
}

const SQL_CLIENTS = new Set(["psql", "pg_restore", "mysql", "mariadb", "sqlite3", "duckdb", "clickhouse-client", "mongosh", "mongo"]);

/** Statement keywords that change data or schema. */
const WRITE_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "ALTER", "DROP", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "VACUUM", "REINDEX"];
/** `COPY … FROM` loads data; bare `COPY` (to stdout) does not. */
const COPY_FROM = /\bCOPY\b[\s\S]{0,200}?\bFROM\b/;
/** NoSQL write calls in a mongosh/mongo payload. */
const MONGO_WRITE = /\.\s*(insert(?:One|Many)?|insert|update(?:One|Many)?|update|remove|delete(?:One|Many)?|drop(?:Database)?|dropdb)\s*\(/i;

/** SQL text with comments and string literals blanked, so a SELECT whose string contains "insert" passes. */
function stripSqlText(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:''|[^'])*'/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, " ");
}

/** True when SQL text (already stripped) contains a write statement. */
function hasWriteStatement(sql: string): boolean {
  const up = sql.toUpperCase();
  if (WRITE_KEYWORDS.some((k) => new RegExp(`\\b${k}\\b`).test(up))) return true;
  return COPY_FROM.test(up);
}

/** The first write statement in the text, for the deny message. */
function matchedStatement(sql: string): string {
  const stripped = stripSqlText(sql);
  const up = stripped.toUpperCase();
  let best = -1;
  let kw = "";
  for (const k of WRITE_KEYWORDS) {
    const m = new RegExp(`\\b${k}\\b`).exec(up);
    if (m && (best < 0 || m.index < best)) ((best = m.index), (kw = k));
  }
  if (best >= 0) return stripped.slice(best, best + 48).replace(/\s+/g, " ").trim();
  const c = COPY_FROM.exec(up);
  if (c) return stripped.slice(c.index, c.index + 48).replace(/\s+/g, " ").trim();
  const g = MONGO_WRITE.exec(sql);
  return g ? sql.slice(g.index, g.index + 40).replace(/\s+/g, " ").trim() : "write statement";
}

/** True when the SQL declares itself read-only before any write. */
function declaresReadOnly(sql: string): boolean {
  const up = stripSqlText(sql).toUpperCase();
  return /SET\s+(?:SESSION\s+)?(?:DEFAULT_TRANSACTION_)?READ_ONLY\b/.test(up) || /SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\s+READ\s+ONLY/.test(up);
}

/** Flags that carry SQL or a db name: when one opens the exec line, there is no container/service name before it. */
const SQL_PAYLOAD_FLAGS = new Set(["-c", "-e", "--command", "--query", "-f", "-d", "--dbname", "-D", "--database"]);

/** The words after `docker exec`/`docker compose exec`/`docker-compose exec`: past the flags, the command line. Its first word is the container/service name (absent for `exec -i mysql -e "…"`) and the next the client. */
function execInner(args: string[]): { service: string | null; client: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    // value-taking exec flags (`-i`/`-T` take none; `-u user`, `--env K=V`, `-w dir` take one)
    if (/^-[a-z]$/.test(args[i]) && !"iITnNd".includes(args[i][1])) i += 2;
    else if (/^--(env|workdir|user)$/.test(args[i])) i += 2;
    else if (/^--(env|workdir|user)=/.test(args[i])) i += 1;
    else i += 1;
  }
  // a payload flag right after the flags means no container/service name was given: the client is args[i-1]
  if (i > 0 && i < args.length && SQL_PAYLOAD_FLAGS.has(args[i])) return { service: null, client: args[i - 1], rest: args.slice(i) };
  // the first positional is the container/service name; the next, the client. A payload flag as the second
  // word means there was no name and the client is the first (`exec mysql -e "…"`).
  if (i + 1 >= args.length) return null;
  if (SQL_PAYLOAD_FLAGS.has(args[i + 1])) return { service: null, client: args[i], rest: args.slice(i + 1) };
  return { service: args[i], client: args[i + 1], rest: args.slice(i + 2) };
}

/** The bare command name of a possibly-pathed word. */
const baseName = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** Words the SQL payload of `-c`/`-e`/`--command`/`--query` carries, plus files named by `-f`. */
function sqlPayload(args: string[]): { inline: string[]; files: string[] } {
  const inline: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "-c" || w === "-e" || w === "--command" || w === "--query") {
      if (args[i + 1] !== undefined) inline.push(args[++i]);
    } else if (w.startsWith("--command=")) {
      inline.push(w.slice(10));
    } else if (w.startsWith("--query=")) {
      inline.push(w.slice(8));
    } else if (w === "-f" || w === "--file") {
      if (args[i + 1] !== undefined) files.push(args[++i]);
    } else if (/^-[cf]$/.test(w) && w.length > 2) {
      // `-cFILE` / `-fFILE`: short flag with its value attached
      (w[1] === "c" ? inline : files).push(w.slice(2));
    }
  }
  return { inline, files };
}

/** The target database name of a SQL-client invocation: psql's positional db or -d/--dbname, mysql/mariadb/clickhouse-client's positional db. */
function dbName(client: string, args: string[]): string | null {
  const pos = args.filter((a) => !a.startsWith("-"));
  if (client === "psql") {
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "-d" || args[i] === "--dbname") && args[i + 1]) return args[i + 1];
      if (args[i].startsWith("--dbname=")) return args[i].slice(9);
    }
    const p = pos.find((w) => !/\.(db|sqlite|sqlite3|duckdb)$/.test(w));
    return p ?? null;
  }
  if (client === "mysql" || client === "mariadb" || client === "clickhouse-client") {
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "-D" || args[i] === "--database") && args[i + 1]) return args[i + 1];
      if (args[i].startsWith("--database=")) return args[i].slice(11);
    }
    // the db name is the first positional, but never a payload flag's value (`mysql -e "DROP …"` has no db)
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (w === "-e" || w === "--command" || w === "-D" || w === "--database") { i++; continue; }
      if (!w.startsWith("-")) return w;
    }
    return null;
  }
  if (client === "mongosh" || client === "mongo") {
    // the positional db name in front of a JS payload: `mongosh appdb --eval "db.users.insertOne(…)"`
    const p = pos.find((w) => !/\.js$/.test(w));
    return p ?? null;
  }
  return null;
}

/** True when `p` lies inside `root`. */
const isInside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

export interface DbWriteContext {
  cwd: string;
  home: string;
  /** The worker's worktree root, null outside git. */
  worktreeRoot: string | null;
  /** workers `guard.dbWriteAllow`; absent = defaults (no container entries). */
  dbWriteAllow?: DbWriteAllow;
  /** workers `guard.liveContainers` globs (config.yaml); absent = none. */
  liveContainers?: string[];
}

/** Absolute path with `$TMPDIR`/`${TMPDIR}`/`$HOME`/`~` expanded; null when other variables remain. */
function expandPath(p: string, cwd: string, ctx: DbWriteContext, env: Record<string, string | undefined>): string | null {
  let e = p.replace(/^~(?=\/|$)/, ctx.home);
  e = e.replace(/\$\{?TMPDIR\}?/g, env.TMPDIR ?? "");
  e = e.replace(/\$\{?HOME\}?/g, ctx.home);
  if (/[$`]/.test(e)) return null;
  return resolve(cwd, e);
}

/** True when a file path lies in the worker's worktree or its own scratch dir ($TMPDIR / <tmp>/pai-scratch/*). */
function isScratchPath(p: string, ctx: DbWriteContext, env: Record<string, string | undefined>): boolean {
  if (ctx.worktreeRoot && isInside(p, ctx.worktreeRoot)) return true;
  const tmp = env.TMPDIR?.replace(/\/+$/, "");
  if (tmp && isInside(p, tmp.replace(/^\/private/, "/"))) return true;
  return /(^|\/)pai-scratch\//.test(p);
}

const DB_WRITE_REASON_TAIL =
  "workers never write a live database: prefix the SQL with `SET default_transaction_read_only = on`, target a scratch/test db " +
  "(an sqlite/duckdb file in your worktree or $TMPDIR, or a container/db matching workers guard.dbWriteAllow), " +
  "or have the operator start this run with --allow-db-writes (PAI_ALLOW_DB_WRITES=1)";

/**
 * The live-database write rule: reason when a segment runs a SQL client whose SQL writes
 * (INSERT/UPDATE/DELETE/MERGE/UPSERT/ALTER/DROP/TRUNCATE/CREATE/GRANT/REVOKE/COPY…FROM/VACUUM FULL/REINDEX;
 * mongosh/mongo write calls), directly or via docker exec / docker compose exec / kubectl exec / ssh, with SQL from
 * -c/-e/--command, a heredoc, `<<<`, a piped echo/cat, or -f <file> (read when it exists). Case-insensitive, after
 * stripping SQL comments and string literals. Allows: a leading read-only statement (`SET default_transaction_read_only = on`,
 * `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, `BEGIN READ ONLY`); a scratch/test target (an sqlite/duckdb file in the
 * worktree or scratch dir, or a container/db matching dbWriteAllow globs); an explicit run flag (env PAI_ALLOW_DB_WRITES=1).
 */
export function dbWriteReason(command: string, env: Record<string, string | undefined>, ctx: DbWriteContext): string | null {
  if (env.PAI_ALLOW_DB_WRITES === "1") return null;
  const allow = ctx.dbWriteAllow ?? DEFAULT_DB_WRITE_ALLOW;
  const raw = command; // heredoc bodies kept: a psql <<EOF payload is the rule's target
  for (const seg of parseCommand(command)) {
    let words = seg.words;
    if (!words.length) continue;
    let container: string | null = null;
    let client: string | null = null;
    let args: string[] = [];

    // `pg_restore <dump>` carries its SQL in the file, not on the line: any run of it changes schema
    const isPgRestore = (c: string | null): boolean => c === "pg_restore";

    const [head, ...rest] = words;
    let h = baseName(head);
    // `npx docker exec …` and friends: reach the real command word past a package runner
    if (h === "npx" || h === "pnpm" || h === "yarn" || h === "bun") {
      let q = 0;
      while (q < rest.length && rest[q].startsWith("-")) q++;
      if (q < rest.length) {
        const real = baseName(rest[q]);
        if (real === "docker" || real === "docker-compose") ((h = real), rest.splice(0, q + 1));
      }
    }
    // the standalone `docker-compose` binary speaks `exec <service> <client> …` directly
    if (h === "docker" || h === "docker-compose") {
      // the subcommand is the first non-flag word: `docker exec …`, or `docker [-f x.yml] compose exec …`
      let k = 0;
      while (k < rest.length && rest[k].startsWith("-")) {
        if (/^--(file|project-name|profile)$/.test(rest[k])) k += 2;
        else if (/^--(file|project-name|profile)=/.test(rest[k])) k += 1;
        else if (rest[k + 1] && rest[k + 1].startsWith("-") && !["exec", "compose"].includes(rest[k + 1])) k += 2;
        else k += 1;
      }
      const sub = h === "docker-compose" ? "exec" : rest[k];
      const srest = h === "docker-compose" ? rest : rest.slice(k + 1);
      if (sub === "exec") {
        const inner = execInner(srest);
        if (inner && SQL_CLIENTS.has(baseName(inner.client))) ((container = inner.service), (client = baseName(inner.client)), (args = inner.rest));
      } else if (sub === "compose") {
        // `docker compose [-f x.yml] exec …`: reach the exec past compose's global flags
        let m = 0;
        while (m < srest.length && srest[m].startsWith("-")) {
          if (/^--(file|project-name|profile)$/.test(srest[m])) m += 2;
          else if (/^--(file|project-name|profile)=/.test(srest[m])) m += 1;
          else if (srest[m + 1] && srest[m + 1].startsWith("-") && !["exec"].includes(srest[m + 1])) m += 2;
          else m += 1;
        }
        if (srest[m] !== "exec") continue;
        const inner = execInner(srest.slice(m + 1));
        if (inner && SQL_CLIENTS.has(baseName(inner.client))) ((container = inner.service), (client = baseName(inner.client)), (args = inner.rest));
      }
    } else if (h === "kubectl" && rest[0] === "exec") {
      const di = words.indexOf("--");
      if (di >= 0) {
        const inner = words.slice(di + 1);
        if (inner.length && SQL_CLIENTS.has(baseName(inner[0]))) ((client = baseName(inner[0])), (args = inner.slice(1)));
      }
    } else if (h === "ssh") {
      // ssh [-opts] host <cmd…>: the first positional is the host, the rest a remote command line
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i++;
      const host = words[i] ?? null;
      const remote = words.slice(i + 1);
      if (host && remote.length && SQL_CLIENTS.has(baseName(remote[0]))) {
        ((container = host), (client = baseName(remote[0])), (args = remote.slice(1)));
      } else if (host) {
        // a remote pipeline: `ssh host 'psql -c "DROP …"'` arrives as one word; scan it like a command line
        const inner = dbWriteReason(remote.join(" "), env, ctx);
        if (inner) return inner;
      }
    } else if (SQL_CLIENTS.has(h)) {
      client = h;
      args = rest;
    }
    if (!client) continue;

    // the SQL this invocation receives: inline flags, a -f file (read when readable), a heredoc body, `<<<`, or a piped echo/cat
    const payload = sqlPayload(args);
    let sql = payload.inline.join("\n");
    for (const f of payload.files) {
      const p = expandPath(f, ctx.cwd, ctx, env);
      if (p && existsSync(p) && isScratchPath(p, ctx, env)) {
        try {
          sql += "\n" + readFileSync(p, "utf8");
        } catch {
          /* unreadable: treated as no SQL from it */
        }
      }
    }
    // the payload a heredoc or here-string carries to this client: `psql <<SQL … SQL`, `psql <<< 'DELETE …'`
    const lines = raw.split("\n");
    const startLine = lines.find((l) => new RegExp(`\\b${client}\\b`).test(l)) ?? "";
    const hm = /(?<!<)<<(?!<)(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_]\w*))/.exec(startLine);
    if (hm && hm[4] === undefined) {
      // a quoted-tagged heredoc on the client's own line: its body lines run between the start and the terminator
      const tag = hm[2] ?? hm[3]!;
      for (let i = lines.indexOf(startLine) + 1; i < lines.length; i++) {
        const l = hm[1] ? lines[i].replace(/^\t+/, "") : lines[i];
        if (l === tag) break;
        sql += "\n" + lines[i];
      }
    } else if (hm && /<<</.test(startLine)) {
      // `psql <<< 'DELETE …'`: parseCommand drops the here-string, so read it from the raw line
      const hs = /<<<\s*(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(startLine);
      if (hs) sql += "\n" + (hs[1] ?? hs[2] ?? hs[3]);
    } else if (!payload.inline.length) {
      // no inline SQL, no heredoc: a piped echo/cat feeds it — the quoted payloads of the client's line and its neighbours
      const idx = lines.indexOf(startLine);
      const around = [lines[idx - 1] ?? "", startLine, lines[idx + 1] ?? ""].join("\n");
      for (const q of around.matchAll(/'([^']*)'|"([^"]*)"/g)) sql += "\n" + (q[1] ?? q[2]);
    }

    const isNoSql = client === "mongosh" || client === "mongo";
    const writes = isPgRestore(client) || (isNoSql ? MONGO_WRITE.test(sql) : hasWriteStatement(stripSqlText(sql)));
    if (!writes) continue;

    // allow (a): the SQL declares itself read-only before any write
    if (!isNoSql && declaresReadOnly(sql)) continue;

    // allow (b): a scratch/test target — an sqlite/duckdb file in the worktree or scratch dir, or an allowlisted container/db
    if (client === "sqlite3" || client === "duckdb") {
      const files = args.filter((a) => !a.startsWith("-") && !/\.(db|sqlite|sqlite3|duckdb)$/.test(a));
      const allScratch = files.length > 0 && files.every((f) => {
        const p = expandPath(f, ctx.cwd, ctx, env);
        return !!p && isScratchPath(p, ctx, env);
      });
      if (allScratch) continue;
    } else {
      const db = dbName(client, args);
      if (db && allow.databases.some((g) => matchGlob(g, db))) continue;
      if (container && allow.containers.some((g) => matchGlob(g, container))) continue;
    }

    return `live database write blocked: ${client} ${matchedStatement(sql)} — ${DB_WRITE_REASON_TAIL}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live containers (2026-11-18 08:54: a worker `docker cp`-ed a python script into a
// LIVE app container and ran it with `docker exec`; the script opened a read-write DB
// connection, which the SQL rule cannot see). Containers matching config
// `workers.guard.liveContainers` (config.yaml) and not `dbWriteAllow.containers`
// take no copy-in and no exec beyond SQL clients (judged by dbWriteReason) and
// read-only inspection commands.
// ---------------------------------------------------------------------------

/** Read-only inspection commands allowed inside a live container. */
const READ_ONLY_EXEC = new Set(["ls", "cat", "head", "tail", "env", "printenv", "ps", "df", "du", "stat", "find", "grep", "wc", "date", "id", "whoami", "uname"]);

/** True when `cmd args` is a read-only inspection command (find without -delete/-exec; env without a command). */
function isReadOnlyExec(cmd: string, args: string[]): boolean {
  const c = baseName(cmd);
  if (!READ_ONLY_EXEC.has(c)) return false;
  if (c === "find") return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a));
  if (c === "env") return args.length === 0; // `env X=1 cmd` would run cmd
  return true;
}

/** Message tail naming the allowed routes. */
function liveContainerReason_(container: string, what: string): string {
  return (
    `live container protected: ${what} on ${container} blocked (rule: workers.guard.liveContainers in config.yaml) — ` +
    "workers do not copy into or run code in a live container. Allowed: use the trial container (a name matching guard.dbWriteAllow.containers), " +
    "read-only commands (ls, cat, head, tail, env, printenv, ps, df, du, stat, find without -delete/-exec, grep, wc, date, id, whoami, uname) or a SQL client judged by the SQL rule, " +
    "or have the operator start this run with --allow-db-writes (allow writes to live databases and containers; PAI_ALLOW_DB_WRITES=1)"
  );
}

/**
 * The live-container rule: reason when a docker segment copies into (`docker cp <src> <live>:<path>`), runs a non-read-only command in
 * (`docker exec` / `docker compose exec`) or mounts the volumes of (`docker run --volumes-from <live>`) a container matching liveContainers
 * and not dbWriteAllow.containers. SQL clients are left to dbWriteReason. Not detected: `-v`/`--mount` of a live container's named volumes
 * (a volume name does not reliably identify its container), so those pass. Off with PAI_ALLOW_DB_WRITES=1.
 */
export function liveContainerReason(command: string, env: Record<string, string | undefined>, ctx: DbWriteContext): string | null {
  if (env.PAI_ALLOW_DB_WRITES === "1") return null;
  const live = ctx.liveContainers ?? [];
  if (!live.length) return null;
  const allow = (ctx.dbWriteAllow ?? DEFAULT_DB_WRITE_ALLOW).containers;
  const isLive = (n: string): boolean => live.some((g) => matchGlob(g, n)) && !allow.some((g) => matchGlob(g, n));
  for (const seg of parseCommand(command)) {
    const words = seg.words;
    if (!words.length) continue;
    const [head, ...rest0] = words;
    let h = baseName(head);
    const rest = [...rest0];
    if (h === "npx" || h === "pnpm" || h === "yarn" || h === "bun") {
      let q = 0;
      while (q < rest.length && rest[q].startsWith("-")) q++;
      if (q < rest.length && ["docker", "docker-compose"].includes(baseName(rest[q]))) ((h = baseName(rest[q])), rest.splice(0, q + 1));
    }
    if (h !== "docker" && h !== "docker-compose") continue;
    // past global flags to the subcommand (compose's -f/-p/--profile take a value)
    const skipFlags = (a: string[]): number => {
      let k = 0;
      while (k < a.length && a[k].startsWith("-")) {
        if (/^(--file|--project-name|--profile|--context|-f|-p|-H|--host|-c)$/.test(a[k])) k += 2;
        else k += 1;
      }
      return k;
    };
    let args = rest;
    let sub: string | undefined;
    let compose = h === "docker-compose";
    if (compose) sub = args[skipFlags(args)], (args = args.slice(skipFlags(args) + 1));
    else {
      const k = skipFlags(args);
      sub = args[k];
      args = args.slice(k + 1);
      if (sub === "compose") {
        compose = true;
        const m = skipFlags(args);
        sub = args[m];
        args = args.slice(m + 1);
      }
    }
    if (sub === "container" && args[0]) ((sub = args[0]), (args = args.slice(1))); // docker container cp/exec/run
    if (sub === "cp" && !compose) {
      const pos = args.filter((a) => !a.startsWith("-"));
      const dest = pos[pos.length - 1];
      const ci = dest?.indexOf(":") ?? -1;
      if (pos.length >= 2 && ci > 0 && isLive(dest.slice(0, ci))) return liveContainerReason_(dest.slice(0, ci), "docker cp into the container");
    } else if (sub === "exec") {
      const inner = execArgs(args);
      if (!inner || !isLive(inner.service)) continue;
      if (SQL_CLIENTS.has(baseName(inner.cmd))) continue;
      if (isReadOnlyExec(inner.cmd, inner.rest)) continue;
      return liveContainerReason_(inner.service, `${compose ? "docker compose exec" : "docker exec"} ${baseName(inner.cmd)}`);
    } else if (sub === "run") {
      for (let i = 0; i < args.length; i++) {
        const v = args[i] === "--volumes-from" ? args[i + 1] : args[i].startsWith("--volumes-from=") ? args[i].slice(15) : undefined;
        if (v && isLive(v.split(":")[0])) return liveContainerReason_(v.split(":")[0], `${compose ? "docker compose run" : "docker run"} --volumes-from`);
      }
    }
  }
  return null;
}

/** `docker exec` words (past the subcommand): the container/service, its command word and arguments. */
function execArgs(args: string[]): { service: string; cmd: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (/^-[a-z]$/.test(args[i]) && !"iItTdD".includes(args[i][1])) i += 2;
    else if (/^--(env|env-file|workdir|user|detach-keys|index)$/.test(args[i])) i += 2;
    else i += 1;
  }
  if (i >= args.length) return null;
  if (i + 1 >= args.length) return { service: args[i], cmd: "", rest: [] };
  return { service: args[i], cmd: args[i + 1], rest: args.slice(i + 2) };
}
