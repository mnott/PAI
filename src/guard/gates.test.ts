import { describe, expect, it } from "vitest";
import { decidePreGates } from "./gates.js";

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
