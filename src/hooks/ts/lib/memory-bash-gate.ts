/**
 * memory-bash-gate.ts — Bash rules that used to live only as memory notes (memory audit 2026-10-26).
 *
 * Pure: the gate chain in guard/gates.ts passes the command, environment and cwd. Each rule names the exact
 * replacement command in its deny text. A rule that only warns returns `note`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseCommand } from "./worker-guard.js";

export interface MemoryBashResult {
  deny?: string;
  note?: string;
}

const PREFIX = new Set(["time", "nice", "nohup", "command", "exec", "env", "sudo", "caffeinate"]);
const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** Words of a segment after env assignments and wrapper commands. */
function strip(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_]\w*=/.test(ws[i]) || PREFIX.has(base(ws[i])))) i++;
  return ws.slice(i);
}

/** Is `cwd` inside the PAI repo (or one of its worktrees)? Nearest package.json decides. */
export function isPaiRepo(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    const f = join(dir, "package.json");
    if (existsSync(f)) {
      try {
        return (JSON.parse(readFileSync(f, "utf8")) as { name?: string }).name === "@tekmidian/pai";
      } catch {
        return false;
      }
    }
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

const TEST_RUNNER_REASON = (what: string): string =>
  `${what} blocked in the main session: test suites and builds run in a worker, not on the live machine. Delegate with \`pai worker run --label "<what>" -p "$(cat spec.txt)"\` (the merge gate runs the tests on \`pai worker merge <id>\`).`;
const BUN_TEST_REASON = "bun test blocked in PAI: it wipes the live ~/.claude.json config. Use `npx vitest run <files>` inside a worker (`pai worker run`).";
const PKILL_REASON = (what: string): string =>
  `${what} blocked: a name pattern kills unrelated processes (\`pkill -f vitest\` killed three workers whose specs mentioned vitest). List with \`pgrep -fl <pattern>\`, then \`kill <pid>\` by PID.`;
const MERGE_PIPE_REASON =
  "a pipe to grep/head/tail before merge hides the failure (the pipeline exits with the last command's status). Run the first command alone, or use `set -o pipefail; <cmd> | tail -20 && pai worker merge <id>`.";
const PANE_WORKER_REASON =
  "`pai pane run -- pai worker run` is blocked: a worker opens its own pane. Run `pai worker run --label <what> -p \"$(cat spec.txt)\"` directly (run_in_background).";
const TODO_SED_REASON =
  "line-number `sed -i` on Notes/TODO.md is blocked: the file shifts under concurrent edits. Anchor on text instead: `sed -i '' '/^- \\[ \\] <exact item text>/s/\\[ \\]/[x]/' Notes/TODO.md`, or use the Edit tool with the item's text as old_string.";
const AGENT_BROWSER_REASON =
  "`agent-browser install` rewrites ~/.claude.json. Back it up in the same command (`cp ~/.claude.json ~/.claude/backups/.claude.json.backup.$(date +%s) && agent-browser install`); to restore use the newest ~/.claude/backups/.claude.json.backup.<epoch>.";
const TSDOWN_REASON = "`npx tsdown` alone is not the PAI build (it skips hooks and generated rules). Use `npm run build`.";
const SIMULATOR_REASON = "workers are headless: do not start a simulator or emulator (`open -a Simulator`, `xcrun simctl boot`, `emulator`). Verify by build and unit run only; report the device step as pending.";
const VOICEINK_SHORTCUT_REASON = "`defaults write` of Shortcut_ keys for app.voiceink is blocked: leave VoiceInk's shortcut defaults alone; the operator changes them in the app.";
const VOICEINK_MERGE_REASON = "`git merge upstream/...` is blocked in VoiceInk: the fork follows upstream by rebase. Use `git rebase upstream/<branch>`.";
const PROVIDER_NOTE =
  "`pai worker run --provider` pins a route: workers use the default route (no --provider) unless the operator asked for a specific provider. Drop the flag unless they did.";

const RUNNER_SUBS = new Set(["test", "t", "tst"]);

function testRunner(w: string[], isWorker: boolean, pai: boolean): string | null {
  const c = base(w[0] ?? "");
  const a = w.slice(1).filter((x) => !x.startsWith("-"));
  if (c === "bun" && a[0] === "test" && pai) return BUN_TEST_REASON;
  if (isWorker) return null;
  if (c === "vitest") return TEST_RUNNER_REASON("vitest");
  if ((c === "npx" || c === "bunx" || c === "pnpx") && a[0] === "vitest") return TEST_RUNNER_REASON("npx vitest");
  if ((c === "npm" || c === "pnpm" || c === "yarn") && (RUNNER_SUBS.has(a[0] ?? "") || (a[0] === "run" && /^test(:|$)/.test(a[1] ?? "")))) {
    return TEST_RUNNER_REASON(`${c} test`);
  }
  if (c === "bun" && a[0] === "run" && /^test(:|$)/.test(a[1] ?? "")) return TEST_RUNNER_REASON("bun run test");
  if ((c === "npm" || c === "pnpm" || c === "yarn") && a[0] === "run" && a[1] === "build") return TEST_RUNNER_REASON(`${c} run build`);
  return null;
}

export function memoryBashRules(command: string, env: Record<string, string | undefined>, cwd: string): MemoryBashResult {
  const isWorker = env.PAI_WORKER === "1";
  const segs = parseCommand(command).map((s) => strip(s.words)).filter((w) => w.length);
  const pai = segs.some((w) => base(w[0]) === "bun") && isPaiRepo(cwd);
  let note: string | undefined;

  if (!isWorker && /\|\s*(?:grep|egrep|head|tail)\b[^;&|\n]*&&\s*(?:pai\s+worker\s+merge|git\s+merge)\b/.test(command) && !/pipefail/.test(command)) {
    return { deny: MERGE_PIPE_REASON };
  }

  for (const w of segs) {
    const c = base(w[0]);
    const rest = w.slice(1);
    const t = testRunner(w, isWorker, pai);
    if (t) return { deny: t };

    if (c === "npx" && rest.filter((x) => !x.startsWith("-"))[0] === "tsdown" && isPaiRepo(cwd)) return { deny: TSDOWN_REASON };

    if (c === "pkill" && rest.some((x) => /^-\w*f/.test(x))) {
      const pat = rest.filter((x) => !x.startsWith("-"))[0];
      if (pat !== undefined && !/\s/.test(pat)) return { deny: PKILL_REASON(`pkill -f ${pat}`) };
    }
    if (c === "killall" && rest.some((x) => /^(node|bun|claude)$/.test(x))) return { deny: PKILL_REASON(`killall ${rest.filter((x) => !x.startsWith("-")).join(" ")}`) };

    if (c === "pai" && rest[0] === "pane" && rest[1] === "run") {
      const i = rest.indexOf("--");
      if (i >= 0) {
        const inner = strip(rest.slice(i + 1));
        if (base(inner[0] ?? "") === "pai" && inner[1] === "worker" && inner[2] === "run") return { deny: PANE_WORKER_REASON };
      }
    }

    if (c === "sed" && rest.some((x) => /^-\w*i/.test(x) || x.startsWith("--in-place"))) {
      const onTodo = rest.some((x) => /(^|\/)TODO\.md$/.test(x));
      const lineAddr = rest.filter((x) => !x.startsWith("-")).some((x) => /^\d+(,\d+)?[a-z]/.test(x) || /(^|[;{])\d+[acid]/.test(x));
      if (onTodo && lineAddr) return { deny: TODO_SED_REASON };
    }

    if (c === "agent-browser" && rest[0] === "install" && !/cp\s+[^;&|]*\.claude\.json/.test(command)) return { deny: AGENT_BROWSER_REASON };

    if (isWorker) {
      if ((c === "open" && rest.some((x) => /^Simulator(\.app)?$/.test(x))) || c === "emulator" || (c === "xcrun" && rest[0] === "simctl" && rest[1] === "boot")) return { deny: SIMULATOR_REASON };
      if (c === "osascript" && /Simulator/.test(command)) return { deny: SIMULATOR_REASON };
    }

    if (c === "defaults" && rest[0] === "write" && rest.some((x) => /voiceink/i.test(x)) && rest.some((x) => /^Shortcut_/.test(x))) return { deny: VOICEINK_SHORTCUT_REASON };
    if (c === "git" && /voiceink/i.test(cwd) && rest.includes("merge") && rest.some((x) => x.startsWith("upstream/"))) return { deny: VOICEINK_MERGE_REASON };

    if (!isWorker && c === "pai" && rest[0] === "worker" && rest[1] === "run" && rest.some((x) => x === "--provider" || x.startsWith("--provider="))) note = PROVIDER_NOTE;
  }
  return note ? { note } : {};
}
