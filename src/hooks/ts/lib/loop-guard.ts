/**
 * loop-guard.ts — repeat detection for worker Bash commands.
 *
 * A worker that re-runs the exact same command with nothing changed in between
 * is stuck (seen: 68x one probe, 12x one vitest run after committing, 9x an
 * A/B proof alternation, 6x one sed read). The window is the Bash commands
 * since the last Edit/Write/MultiEdit/NotebookEdit; the 5th copy of a command
 * is denied. Alternating A,B,A,B is covered the same way: each of the two
 * commands reaches 4 copies in the window, so the next of either is denied.
 * Different sed ranges are different commands and never repeat.
 */

export const LOOP_MAX_REPEATS = 4;
const WINDOW_CAP = 64;

export const LOOP_DENY_REASON =
  "loop guard: you ran this exact command 4 times without changing anything. Stop repeating it. If your part is done, commit and write your R report. If you are stuck, report the blocker in R x= (or use pai worker help if available).";

export function loopDenyReason(testRun: boolean): string {
  return testRun
    ? `loop guard: you are re-running the same tests on an unchanged tree (${LOOP_MAX_REPEATS} times, flags varied). Stop repeating it. If your part is done, commit and write your R report. If you are stuck, report the blocker in R x= (or use pai worker help if available).`
    : LOOP_DENY_REASON;
}

export interface LoopState {
  /** Normalised commands run since the last edit, oldest first. */
  window: string[];
}

export function emptyLoopState(): LoopState {
  return { window: [] };
}

const RUNNERS: Array<[RegExp, string]> = [
  [/^(?:(?:npx|bunx|pnpm exec|pnpm dlx|yarn) )?vitest\b/, "vitest"],
  [/^(?:(?:npx|bunx|pnpm exec|pnpm dlx|yarn) )?jest\b/, "jest"],
  [/^(?:npm|pnpm|yarn) (?:run )?test\b/, "npm test"],
  [/^bun test\b/, "bun test"],
  [/^(?:(?:python3?|uv run|poetry run) (?:-m )?)?pytest\b/, "pytest"],
  [/^go test\b/, "go test"],
  [/^swift test\b/, "swift test"],
  [/^xcodebuild\b.*\btest\b/, "xcodebuild test"],
];

/** Flags whose next token is a value, not a target. */
const VALUE_FLAGS = new Set([
  "--config", "-c", "--dir", "--root", "-r", "--reporter", "--project", "--outputFile", "--testNamePattern", "-t",
  "-k", "-m", "--timeout", "--testTimeout", "--pool", "--shard", "--environment", "--workspace", "--mode", "-p",
  "--rootdir", "--tb", "--maxfail", "--count", "--run", "-run", "-tags", "-scheme", "-destination", "-project",
  "-workspace", "-only-testing", "--filter", "--maxWorkers", "-w", "--cache-dir", "--ignore", "--deselect",
]);

/** Test-run key: runner plus sorted target paths; flags, quotes, redirections and pipes dropped. Null for non-test commands. */
function testRunKey(command: string): string | null {
  for (const raw of command.split(/&&|\|\||;|\|/)) {
    let seg = raw.replace(/\d*>>?&?\S*/g, " ").replace(/\s+/g, " ").trim();
    seg = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )+/, "");
    const hit = RUNNERS.find(([re]) => re.test(seg));
    if (!hit) continue;
    const targets = new Set<string>();
    const toks = seg.replace(/["']/g, "").split(" ").slice(1);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === "--") continue;
      if (t.startsWith("-")) {
        if (VALUE_FLAGS.has(t)) i++;
        continue;
      }
      if (/^(?:run|test|exec|vitest|jest|pytest)$/.test(t) || (hit[1] === "xcodebuild test" && !/[/.]/.test(t))) continue;
      targets.add(t.replace(/^\.\//, ""));
    }
    return TEST_PREFIX + (targets.size ? `${hit[1]} ${[...targets].sort().join(" ")}` : `${hit[1]} (all)`);
  }
  return null;
}

const TEST_PREFIX = "test-run: ";

/** True when the key was derived from a test-runner command. */
export function isTestRunKey(key: string): boolean {
  return key.startsWith(TEST_PREFIX);
}

/** Whitespace-normalised; digits inside /tmp/... paths collapsed so a numbered output file does not hide a repeat. */
export function loopKey(command: string): string {
  const test = testRunKey(command);
  if (test) return test;
  return command
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\/private)?\/tmp\/[^\s'";|&<>)]*/g, (p) => p.replace(/\d+/g, "N"));
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Next state and whether this tool call is a loop repeat to deny. */
export function stepLoopGuard(state: LoopState, tool: string, command?: string): { state: LoopState; deny: boolean; testRun?: boolean } {
  if (EDIT_TOOLS.has(tool)) return { state: emptyLoopState(), deny: false };
  if (tool !== "Bash" || typeof command !== "string" || !command.trim()) return { state, deny: false };
  const key = loopKey(command);
  const copies = state.window.filter((k) => k === key).length;
  if (copies >= LOOP_MAX_REPEATS) return { state, deny: true, testRun: isTestRunKey(key) };
  return { state: { window: [...state.window, key].slice(-WINDOW_CAP) }, deny: false };
}
