import { describe, expect, it } from "vitest";
import { decideSleepPollGate } from "../hooks/ts/lib/sleep-poll-gate.js";
import { decidePreGates, decideWorkerGate } from "./gates.js";
import { modelServerReason } from "../hooks/ts/lib/model-server-guard.js";
import { WORKER_CHILD_ROUTE_REASON, type WorkerGuardContext } from "../hooks/ts/lib/worker-guard.js";

const base = { PAI_WORKER: "1", PAI_WORKER_CLASS: "orchestrate", TMPDIR: "/var/folders/x/T" } as NodeJS.ProcessEnv;
const run = (tool: string, input: unknown, env: NodeJS.ProcessEnv, failed = false) =>
  decidePreGates({ tool, input, cwd: "/w/tree", env }, { planner: { childFailed: () => failed } });

describe("L1 planner lock", () => {
  it("denies edits, in-place writes and redirects without a failed child", () => {
    expect(run("Edit", { file_path: "a.txt" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "sed -i '' s/a/b/ a.txt" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "echo x >> NOTES.txt" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "sed -i '' s/a/b/ a.txt && echo x >> NOTES.txt && git commit -m x" }, base)?.action).toBe("deny");
  });
  it("allows scratch, tmp specs and git", () => {
    expect(run("Write", { file_path: ".pai-scratch/x" }, base)).toBeNull();
    expect(run("Write", { file_path: "/var/folders/x/T/spec.txt" }, base)).toBeNull();
    expect(run("Bash", { command: "cat > $TMPDIR/spec.txt" }, base)).toBeNull();
    expect(run("Bash", { command: "git commit -m 'a > b'" }, base)).toBeNull();
    expect(run("Bash", { command: "ls 2>&1 | grep a" }, base)).toBeNull();
  });
  it("reads quoted redirect targets", () => {
    const spec = "cat > \"$TMPDIR/s882.txt\" <<'EOF'\nbody > x\nEOF";
    const loop = "for n in 881 882 883; do pai worker run --class implement --label \"caseleaf-$n\" -p \"$(cat $TMPDIR/s$n.txt)\" --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json --max-minutes 30 > \"$TMPDIR/o$n.json\" 2>&1 & echo $! > \"$TMPDIR/p$n.pid\"; done";
    expect(run("Bash", { command: spec }, base)).toBeNull();
    expect(run("Bash", { command: loop }, base)).toBeNull();
    expect(run("Bash", { command: "echo x > \"greet.txt\"" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "printf a > 'NOTES.txt'" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "pai worker run --class implement -p \"use > to redirect\" --label x" }, base)).toBeNull();
  });
  it("resolves cd and variables: scratch writes pass, worktree writes deny", () => {
    const s = "/var/folders/x/T/s";
    const cmd1 = `cd "$TMPDIR/s"; for n in 881 882 883; do pai worker run --class implement --label "fix $n" --spec $TMPDIR/s/$n.txt --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json > $n.out 2>&1 & echo $! > $n.pid; done; sleep 10; tail -n2 881.out`;
    const cmd2 = `cd "$TMPDIR/s"; for n in 881 882 883; do nohup sh go.sh $n > /dev/null 2>&1 & echo $! > $n.pid; done`;
    expect(run("Bash", { command: cmd1 }, base)?.action).not.toBe("deny");
    expect(run("Bash", { command: cmd2 }, base)?.action).not.toBe("deny");
    // a variable holding $TMPDIR is tracked like cd (S=$TMPDIR, then > $S/a.out)
    const varCmd = `S=$TMPDIR; pai worker run --class implement --label x --spec "$S/a.txt" --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json > $S/a.out 2>&1 & echo $! > $S/a.pid`;
    expect(run("Bash", { command: varCmd }, base)?.action).not.toBe("deny");
    // a cd into the worktree still locks its writes; a relative cd resolves against it
    const g = { planner: { childFailed: () => false, worktreeRoot: () => "/w/tree" } };
    const w = (command: string) => decidePreGates({ tool: "Bash", input: { command }, cwd: "/w/tree", env: base }, g)?.action;
    expect(w("cd src && echo x > a.ts")).toBe("deny");
    expect(w("echo x > ../outside.txt")).not.toBe("deny");
    expect(w(`cd ${s} && echo x > out.json`)).not.toBe("deny");
  });
  it("resolves ../ targets without moving the effective dir", () => {
    const g = { planner: { childFailed: () => false, worktreeRoot: () => "/w/tree" } };
    const w = (command: string) => decidePreGates({ tool: "Bash", input: { command }, cwd: "/w/tree", env: base }, g)?.action;
    expect(w("echo a > ../outside.txt")).not.toBe("deny");
    expect(w("echo a > ../outside.txt; echo b > inside.txt")).toBe("deny");
  });
  it("lifts after a failed child", () => {
    expect(run("Edit", { file_path: "a.txt" }, base, true)).toBeNull();
    expect(run("Bash", { command: "echo x >> NOTES.txt" }, base, true)).toBeNull();
  });
  it("leaves class implement alone", () => {
    expect(run("Edit", { file_path: "a.txt" }, { ...base, PAI_WORKER_CLASS: "implement" })).toBeNull();
  });
  it("does not touch the --orchestrate path", () => {
    expect(run("Edit", { file_path: "a.txt" }, { ...base, PAI_WORKER_ORCHESTRATOR: "1" })).toBeNull();
  });
});

describe("background pane gate: worker verbs run in the background, everything else needs a pane", () => {
  const bg = (command: string) => decidePreGates({ tool: "Bash", input: { command, run_in_background: true }, cwd: "/w/tree", env: {} }, { bash: { localAnswer: () => "" } });
  it("allows a background worker run and resume (each opens its own pane)", () => {
    expect(bg('pai worker run --class implement --label x -p "y"')).toBeNull();
    expect(bg('pai worker resume w-20260101-abc "t"')).toBeNull();
    expect(bg("cd /w/tree && pai worker resume w-20260101-abc \"t\"")).toBeNull();
  });
  it("denies a worker verb wrapped in a pane", () => {
    const d = bg("pai pane run -- pai worker resume w-20260101-abc");
    expect(d?.action).toBe("deny");
    expect(d?.message).toContain("a resume with text starts a new worker");
    expect(bg("pai pane run -- pai worker run -p x")?.action).toBe("deny");
  });
  it("still requires a pane for unrelated background commands", () => {
    expect(bg("sleep 5; echo x")?.action).toBe("deny");
    expect(bg("nohup sh go.sh &")?.action).toBe("deny"); // a plain background job still needs a pane
  });
});

describe("queued child kill", () => {
  const states: Record<string, string> = { q1: "queued", r1: "running" };
  const kill = (cmd: string, env: NodeJS.ProcessEnv = { PAI_WORKER: "1" }) =>
    decidePreGates({ tool: "Bash", input: { command: cmd }, cwd: "/w/tree", env }, { ownChildState: (id) => states[id] });
  it("denies killing a queued own child", () => {
    const d = kill('pai worker kill q1 --reason "local queue saturated, rerun on cloud"');
    expect(d?.action).toBe("deny");
    expect(d?.message).toContain("A queued child waits for its slot");
  });
  it("allows killing a running own child and an unknown id", () => {
    expect(kill("pai worker kill r1 --reason loops")).toBeNull();
    expect(kill("pai worker kill zz")).toBeNull();
  });
  it("leaves non-worker callers alone", () => {
    expect(kill("pai worker kill q1", {})).toBeNull();
  });
});

describe("worker child routing: --model/--provider only when the brief names it", () => {
  const ctx = (taskText?: string): WorkerGuardContext => ({ cwd: "/w/tree", home: "/h", worktreeRoot: "/w/tree", inWorktree: false, mainCheckout: null, testScript: () => null, ...(taskText === undefined ? {} : { taskText: () => taskText }) });
  const g = (command: string, taskText?: string) => decideWorkerGate({ tool: "Bash", input: { command }, cwd: "/w/tree", env: { PAI_WORKER: "1" } }, { worker: () => ctx(taskText) });
  const run = 'pai worker run --class implement --provider anthropic --label x -p "do the thing"';
  it("denies --provider when the brief does not name it", () => {
    const d = g(run, "fix the bug");
    expect(d?.action).toBe("deny");
    expect(d?.message).toContain(WORKER_CHILD_ROUTE_REASON);
  });
  it("allows --provider the brief names", () => {
    expect(g(run, "run the children on anthropic")).toBeNull();
  });
  it("allows a run without --model/--provider", () => {
    expect(g('pai worker run --class implement --label x -p "y"', "fix the bug")).toBeNull();
  });
  it("denies --model the brief does not name, allows one it names", () => {
    expect(g('pai worker run --class implement --model claude-opus-5-5 -p x', "fix the bug")?.action).toBe("deny");
    expect(g('pai worker run --class implement --model claude-opus-5-5 -p x', "start the two children on opus")).toBeNull();
  });
  it("denies when the task text cannot be read (fail closed)", () => {
    expect(g(run)?.action).toBe("deny"); // no taskText in the context at all
    expect(g(run, "")?.action).toBe("deny");
  });
  it("leaves resume covered and help allowed", () => {
    expect(g("pai worker resume abc123 --provider anthropic", "fix the bug")?.action).toBe("deny");
    expect(g('pai worker help --task "exactly this" --files a.ts', "fix the bug")).toBeNull();
  });
});

describe("GNU sed relative-range denial on macOS", () => {
  const ctx: WorkerGuardContext = { cwd: "/w/tree", home: "/h", worktreeRoot: "/w/tree", inWorktree: false, mainCheckout: null, testScript: () => null };
  const gnu = (command: string) => decideWorkerGate({ tool: "Bash", input: { command }, cwd: "/w/tree", env: { PAI_WORKER: "1" } }, { worker: () => ctx });
  const darwin = process.platform === "darwin";
  (darwin ? it : it.skip)("rewrites numeric `,+N` ranges, denies other GNU forms, absolute ends and s/// bodies pass", () => {
    const a = gnu('sed -n "18,+8p" f.ts');
    expect(a?.action).toBe("allow");
    expect(a?.updatedInput?.command).toBe('sed -n "18,26p" f.ts');
    expect(gnu("sed -n '18,+8p' f.ts")?.updatedInput?.command).toBe("sed -n '18,26p' f.ts"); // single-quoted too
    expect(gnu('sed -n "$(grep -n x f | cut -d: -f1),+8d" f.ts')?.action).toBe("deny"); // computed start rewrites only for `p`
    expect(gnu("sed -n '/x/,+8p' f.ts")?.action).toBe("deny"); // regex start
    expect(gnu("sed -n '/re/,+8p' f.ts")?.action).toBe("deny");
    expect(gnu('sed -n "18,26p" f.ts')).toBeNull();
    expect(gnu("sed -n 1,8p")).toBeNull();
    expect(gnu("sed 's/a,+b/c/' f")).toBeNull(); // a substitution containing ",+" is not an address
  });
  (darwin ? it : it.skip)("rewrites sed -i followed by a script, denies ambiguous, allows a real backup suffix", () => {
    for (const c of ["sed -i '/re/d' f", "sed -i s f"]) {
      expect(gnu(c)?.action, c).toBe("deny");
    }
    for (const c of ["sed -i '1953s/x/y/' f", "sed -i '$d' f", "sed -i '1,5d' f", "sed -i 's/a/b/' f", "sed -i '1953s/a/b/; 1969s/c/d/' f.swift"]) {
      expect(gnu(c)?.action, c).toBe("allow");
      expect(gnu(c)?.updatedInput?.command, c).toContain("sed -i '' ");
    }
    for (const c of ["sed -i '' -e 's/a/b/' f", "sed -i.bak 's/a/b/' f", "sed -i '.bak' 's/a/b/' f", "sed -i '~' 's/a/b/' f", "sed -n 1,8p f"]) {
      expect(gnu(c), c).toBeNull();
    }
  });
});

describe("ANTHROPIC_API_KEY is never set on a process (workers and L0)", () => {
  const g = (command: string, env: NodeJS.ProcessEnv = {}) =>
    decidePreGates({ tool: "Bash", input: { command }, cwd: "/w/tree", env }, {})?.action ?? null;
  it("denies every way of setting it", () => {
    expect(g("ANTHROPIC_API_KEY=x claude -p hi")).toBe("deny");
    expect(g('ANTHROPIC_BASE_URL=http://127.0.0.1:8037 ANTHROPIC_API_KEY=x claude --model apple-fm -p "hi"')).toBe("deny");
    expect(g('export ANTHROPIC_API_KEY="sk-leak"')).toBe("deny");
    expect(g("export -n ANTHROPIC_API_KEY=x")).toBe("deny");
    expect(g("env ANTHROPIC_API_KEY=x claude -p hi")).toBe("deny");
    expect(g("env -iS 'ANTHROPIC_API_KEY=x claude' -p hi")).toBe("deny");
    expect(g("launchctl setenv ANTHROPIC_API_KEY x")).toBe("deny");
    expect(g('launchctl setenv "ANTHROPIC_API_KEY" x')).toBe("deny");
    expect(g("ls; ANTHROPIC_API_KEY=x claude -p hi")).toBe("deny"); // a later segment still denies
    expect(g("echo done && ANTHROPIC_API_KEY= claude")).toBe("deny"); // an empty value is still a set
    expect(g('sh -c "ANTHROPIC_API_KEY=$KEY claude -p hi"')).toBe("deny"); // inside a quoted shell payload
    expect(g("PAI_WORKER=1 ANTHROPIC_API_KEY=x claude")).toBe("deny"); // after other assignments
    expect(g("/usr/bin/env ANTHROPIC_API_KEY=x claude")).toBe("deny"); // a pathed env is still env
  });
  it("leaves unset, env -u and reads alone", () => {
    expect(g("unset ANTHROPIC_API_KEY")).toBeNull();
    expect(g("env -u ANTHROPIC_API_KEY claude -p hi")).toBeNull();
    expect(g("env -i -u ANTHROPIC_API_KEY claude -p hi")).toBeNull(); // combined and separate -u flags
    expect(g("grep -rn ANTHROPIC_API_KEY src/ --include=*.ts")).toBeNull();
    expect(g('echo ${ANTHROPIC_API_KEY:+"set"}')).toBeNull();
    expect(g("echo $ANTHROPIC_API_KEY")).toBeNull();
    expect(g('printf "%s" "never set ANTHROPIC_API_KEY on a process"')).toBeNull(); // prose about the rule is text
    expect(g("git commit -m 'guard denies setting ANTHROPIC_API_KEY'")).toBeNull();
  });
  it("applies to workers and L0 alike", () => {
    expect(g("ANTHROPIC_API_KEY=x claude", { PAI_WORKER: "1" })).toBe("deny");
    expect(g("ANTHROPIC_API_KEY=x claude", {})).toBe("deny");
  });
});

describe("git grep option order denial", () => {
  const ctx: WorkerGuardContext = { cwd: "/w/tree", home: "/h", worktreeRoot: "/w/tree", inWorktree: false, mainCheckout: null, testScript: () => null };
  const g = (command: string) => decideWorkerGate({ tool: "Bash", input: { command }, cwd: "/w/tree", env: { PAI_WORKER: "1" } }, { worker: () => ctx });
  it("denies an option after the bare pattern, allows options before it and -e patterns", () => {
    expect(g('git grep -n "export function parentInfo" -A 20 -- src/a.ts')?.action).toBe("deny");
    expect(g('git grep -n -A 20 "export function parentInfo" -- src/a.ts')).toBeNull();
    expect(g("git grep -n -e foo -A 3")).toBeNull(); // the pattern is an option argument: -A after it is fine
    expect(g('git grep -n "x" -- src')).toBeNull();
  });
});

describe("headless-browser automation is denied in the interactive session hook layer", () => {
  const g = { browserAutomation: true, bash: { localAnswer: () => "" } };
  const w = (tool: string, input: unknown) => decidePreGates({ tool, input, cwd: "/w/tree", env: {} }, g);
  it("denies Bash runs and installs with the operator message", () => {
    for (const command of ["npx playwright test", "npm install puppeteer", "pip install selenium"]) {
      const d = w("Bash", { command });
      expect(d?.action).toBe("deny");
      expect(d?.message).toContain("Playwright/Puppeteer/Selenium are not used here (operator rule)");
    }
    expect(w("Bash", { command: "grep playwright package.json" })?.action).not.toBe("deny");
    for (const command of ["chromium --headless --dump-dom x", "google-chrome --headless=new --print-to-pdf=x y"]) expect(w("Bash", { command })?.action).not.toBe("deny");
  });
  it("denies an Edit/Write import of playwright", () => {
    expect(w("Write", { file_path: "/nonexistent-ba/x.ts", content: `import { chromium } from "playwright";` })?.action).toBe("deny");
    expect(w("Edit", { file_path: "/nonexistent-ba/x.ts", new_string: "const a = 1;" })?.action).not.toBe("deny");
  });
});

describe("sleep-poll gate: per-step rule", () => {
  const verdict = (tool: string, command: string) => decideSleepPollGate({ tool_name: tool, tool_input: { command } }, {}).decision;
  const loops = [
    'for i in $(seq 1 9); do curl -sf -m 2 127.0.0.1:8035/v1/models >/dev/null && { echo up; break; }; sleep 5; done; echo done',
    'for i in $(seq 1 15); do curl -sf -m 1 127.0.0.1:8035/v1/models >/dev/null && { echo "up"; exit 0; }; sleep 2; done; echo "not up"',
    'until curl -sf -m 2 127.0.0.1:8035/v1/models >/dev/null; do sleep 2; done; echo up',
  ];
  it("allows bounded wait loops in Bash and Monitor", () => {
    for (const c of loops) {
      expect(verdict("Bash", c)).toBe("allow");
      expect(verdict("Monitor", c)).toBe("allow");
    }
  });
  it("denies a single sleep over 60s and a chained sleep sequence over 60s", () => {
    expect(verdict("Bash", "sleep 65")).toBe("deny");
    expect(verdict("Bash", "sleep 61; curl x")).toBe("deny");
    expect(verdict("Bash", "sleep 40; sleep 40; curl x")).toBe("deny");
  });
});

describe("L0 foreground wait denial: an interactive session may not block on pai worker wait", () => {
  const REASON = "L0 never waits in the foreground: run it with run_in_background, or hand the merge/verify loop to an L1 (--class orchestrate)";
  const l0 = (command: string, run_in_background = false) =>
    decideSleepPollGate({ tool_name: "Bash", tool_input: { command, run_in_background } }, {}).decision;
  const worker = (command: string, run_in_background = false) =>
    decideSleepPollGate({ tool_name: "Bash", tool_input: { command, run_in_background } }, { PAI_WORKER: "1" }).decision;
  it("denies a foreground wait in L0 with the exact reason", () => {
    const d = decideSleepPollGate({ tool_name: "Bash", tool_input: { command: "pai worker wait abc --max 590" } }, {});
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe(REASON);
  });
  it("allows the same call backgrounded in L0", () => {
    expect(l0("pai worker wait abc --max 590", true)).toBe("allow");
  });
  it("leaves a worker's foreground wait allowed", () => {
    expect(worker("pai worker wait abc --max 590")).toBe("allow");
  });
  it("denies a sleep prefix before a wait in L0", () => {
    expect(l0("sleep 20; pai worker wait abc")).toBe("deny");
    expect(l0("sleep 20 && pai worker wait abc")).toBe("deny");
  });
  it("denies wait-on, wait-url and wait-file in L0", () => {
    expect(l0("pai worker wait-on 123 --log x")).toBe("deny");
    expect(l0("pai worker wait-url http://127.0.0.1:8016/v1/models")).toBe("deny");
    expect(l0("pai worker wait-file /tmp/job.rc")).toBe("deny");
  });
  it("leaves quoted text alone", () => {
    expect(l0('echo "pai worker wait"')).toBe("allow");
    expect(l0("git commit -m 'wait for pai worker wait to finish'")).toBe("allow");
  });
});

describe("model-server guard matches only commands that start a server", () => {
  const r = (command: string, env: Record<string, string | undefined> = {}) => modelServerReason(command, env, "signal-2 8044");
  it("allows probes and quoted text", () => {
    expect(r('for p in 8044 8045; do curl -sf -m 3 127.0.0.1:$p/v1/models >/dev/null && echo "$p up" || echo "$p DOWN"; done; pai worker ps')).toBeNull();
    expect(r(`printf -- '- Guard false positive for p in 8044 8045; do curl 127.0.0.1:$p; server.py --engine strata --port 8045' >> ~/.pai/Notes/TODO.md`)).toBeNull();
    expect(r("lsof -nP -iTCP:8044 -sTCP:LISTEN")).toBeNull();
  });
  it("blocks real starts unless opted in", () => {
    expect(r("cd x && exec python serve/server.py --engine strata --config y --port 8045")).toContain("Local model servers");
    expect(r("mtplx serve --port 8042")).toContain("Local model servers");
    expect(r("PAI_ALLOW_MODEL_SERVER=1 mtplx serve --port 8042")).toBeNull();
    expect(r("mtplx serve --port 8042", { PAI_ALLOW_MODEL_SERVER: "1" })).toBeNull();
  });
});

describe("build gate routes plain builds through the queue", () => {
  const g = { bash: { localAnswer: () => "" } };
  const w = (command: string) => decidePreGates({ tool: "Bash", input: { command }, cwd: "/w/tree", env: {} }, g);
  it("rewrites one plain build, with or without a cd prefix", () => {
    expect(w("swift build")?.updatedInput).toEqual({ command: "pai build run -- swift build" });
    expect(w("cd /w/tree/app && xcodebuild test -scheme X")?.updatedInput).toEqual({ command: "cd /w/tree/app && pai build run --kind test -- xcodebuild test -scheme X" });
    expect(w("xcodebuild -scheme X build")?.message).toContain("routed through the build queue: pai build run -- xcodebuild");
  });
  it("keeps complex forms denied and wrapped commands untouched", () => {
    for (const c of ["swift build | tail", "swift build; echo x", "swift build && echo x", "swift build > out.txt", "swift build &", "FOO=1 swift build", "cd a && cd b && swift build", "bash -c 'swift build'"]) expect(w(c)?.action, c).toBe("deny");
    expect(w("pai build run -- swift build")).toBeNull();
  });
});
