import { describe, it, expect } from "vitest";
import { evaluate, type GuardContext } from "./evaluate.js";
import { emptyLoopState, REVERT_STOP_AT, type LoopState } from "../hooks/ts/lib/loop-guard.js";
import { loadRules, allRuleDirs } from "../hooks/ts/lib/rules/load.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";

const cwd = process.cwd();
const rules = loadRules(allRuleDirs(cwd)).rules;
const fired: unknown[] = [];
const base = (): GuardContext => ({ env: {}, record: (f) => fired.push(f) });

const bash = (command: string) => ({ kind: "tool_call" as const, tool: "Bash", input: { command }, cwd });

/** Feeds Write calls through evaluate, threading the loop state like the hook does. */
function writes(contents: string[]) {
  let state: LoopState = emptyLoopState();
  return contents.map((content) => {
    const d = evaluate({ kind: "tool_call", tool: "Write", input: { file_path: "/tmp/out/a.py", content }, cwd }, { ...base(), loop: { state, now: 1 } });
    state = d.loop!.state;
    return d;
  });
}

describe("evaluate", () => {
  it("denies a command matching a shell rule", () => {
    const d = evaluate(bash("git reset --hard HEAD~1"), { ...base(), shellRules: rules });
    expect(d.action).toBe("deny");
    expect(d.mode).toBe("enforce");
    expect(d.rule?.severity).toBeDefined();
    expect(fired).toContainEqual(expect.objectContaining({ id: d.patternId, category: "shell", action: "deny", mode: "enforce" }));
  });

  it("allows an ordinary command", () => {
    expect(evaluate(bash("ls -la"), { ...base(), shellRules: rules })).toEqual({ action: "allow" });
  });

  it("notes an identical Write repeat", () => {
    const d = writes(["x = 1\n", "x = 1\n"])[1];
    expect(d).toMatchObject({ action: "note", patternId: "identical-write", mode: "enforce" });
    expect(d.message).toContain("already contains exactly this content");
  });

  it("stops an A,B,A,B revert oscillation", () => {
    const ds = writes(Array.from({ length: REVERT_STOP_AT + 2 }, (_, i) => (i % 2 ? "B" : "A")));
    expect(ds[ds.length - 1]).toMatchObject({ action: "stop", patternId: "revert", mode: "enforce" });
    expect(ds.slice(0, -1).every((d) => d.action !== "stop")).toBe(true);
  });

  it("continues on a final text that is an unparsed tool call", () => {
    const d = evaluate({ kind: "final_text", text: "Done.\n<invoke name=\"Bash\"><parameter name=\"command\">ls</parameter></invoke>", cwd }, base());
    expect(d).toMatchObject({ action: "continue", patternId: "unparsed-tool-call", mode: "enforce", unparsed: { name: "Bash" } });
    expect(evaluate({ kind: "final_text", text: "All done.", cwd }, base())).toEqual({ action: "allow" });
  });

  it("records a monitor-mode rule and lets the command through", () => {
    const monitorRule: Rule = { id: "demo-monitor", severity: "block", match: "\\bdemo-danger\\b", reason: "demo", mode: "monitor" };
    const before = fired.length;
    const d = evaluate(bash("demo-danger now"), { ...base(), shellRules: [monitorRule] });
    expect(d).toMatchObject({ action: "allow", patternId: "demo-monitor", mode: "monitor" });
    expect(fired.slice(before)).toEqual([expect.objectContaining({ id: "demo-monitor", action: "deny", mode: "monitor" })]);
  });
});

describe("evaluate: command gates", () => {
  const worker = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
  const call = (command: string, extra: Record<string, unknown> = {}) => ({ kind: "tool_call" as const, tool: "Bash", input: { command, ...extra }, cwd });
  const wctx = (): import("../hooks/ts/lib/worker-guard.js").WorkerGuardContext => ({ cwd, home: "/home/x", worktreeRoot: cwd, inWorktree: true, mainCheckout: "/home/x/main", testScript: () => "vitest run" });
  const plu = (...args: string[]) => ["plu" + "til", ...args].join(" ");

  it("plutil: denies an in-place edit verb with the guard message and category, allows -o", () => {
    const d = evaluate(call(plu("-extract", "Key", "json", "/tmp/a.plist")), { ...base(), gates: { plutil: true } });
    expect(d).toMatchObject({ action: "deny", patternId: "plutil-guard", guard: { category: "plutil_guard" } });
    expect(d.message).toContain("rewrites the file in place");
    expect(evaluate(call(plu("-extract", "Key", "raw", "-o", "-", "/tmp/a.plist")), { ...base(), gates: { plutil: true } }).action).toBe("allow");
  });

  it("worker git: denies a tree rewrite in a shared checkout, allows it in a private clone and for non-workers", () => {
    const gates = (priv: boolean) => ({ workerGit: { worktreesRoot: "/nonexistent/worktrees", privateClone: () => priv } });
    const d = evaluate(call("git stash"), { ...base(), env: worker, gates: gates(false) });
    expect(d).toMatchObject({ action: "deny", guard: { category: "worker_git_guard", pattern: "git stash" } });
    expect(d.message).toContain("in-place worker: git stash");
    expect(evaluate(call("git stash"), { ...base(), env: worker, gates: gates(true) }).action).toBe("allow");
    expect(evaluate(call("git stash"), { ...base(), gates: gates(false) }).action).toBe("allow");
  });

  it("model server / port scan: denies two 80xx ports with the cached answer, allows one port and the operator override", () => {
    const gates = { bash: { localAnswer: () => "none running" } };
    const d = evaluate(call("curl 127.0.0.1:8010/x; curl 127.0.0.1:8011/y"), { ...base(), gates });
    expect(d.action).toBe("deny");
    expect(d.message).toContain("Running now: none running");
    expect(evaluate(call("curl 127.0.0.1:8010/x"), { ...base(), gates }).action).toBe("allow");
    expect(evaluate(call("vllm-mlx serve m"), { ...base(), env: { PAI_ALLOW_MODEL_SERVER: "1" }, gates }).action).toBe("allow");
  });

  it("sleep-poll and background: denies a long sleep and a session background run, allows a short sleep", () => {
    const gates = { bash: { localAnswer: () => "x" } };
    expect(evaluate(call("sleep 120"), { ...base(), gates }).action).toBe("deny");
    expect(evaluate(call("sleep 5"), { ...base(), gates }).action).toBe("allow");
    expect(evaluate(call("make all", { run_in_background: true }), { ...base(), gates }).message).toContain("pai pane run");
  });

  it("worker guard: denies a live-config write and a bench start, allows a plain edit and a plain command", () => {
    const gates = { worker: wctx };
    const edit = (file_path: string) => ({ kind: "tool_call" as const, tool: "Write", input: { file_path, content: "x" }, cwd });
    const d = evaluate(edit("/home/x/.pai/config.json"), { ...base(), env: worker, gates });
    expect(d.action).toBe("deny");
    expect(d.message).toContain("edit of /home/x/.pai/config.json blocked");
    expect(evaluate(edit(`${cwd}/a.ts`), { ...base(), env: worker, gates }).action).toBe("allow");
    expect(evaluate(call("pai models start"), { ...base(), env: worker, gates }).action).toBe("deny");
    expect(evaluate(call("ls"), { ...base(), env: worker, gates }).action).toBe("allow");
    expect(evaluate(call("pai models start"), { ...base(), gates }).action).toBe("allow");
  });

  it("worker guard: a loop-clean call reaches the worker gate and keeps its loop step", () => {
    const d = evaluate(call("ls"), { ...base(), env: worker, gates: { worker: wctx }, loop: { state: emptyLoopState(), now: 1 } });
    expect(d.action).toBe("allow");
    expect(d.loop).toBeDefined();
  });

  it("orchestrator bash: denies an in-place code write for an orchestrator worker, allows tests and other sessions", () => {
    const orch = { PAI_WORKER: "1", PAI_WORKER_ORCHESTRATOR: "1" } as NodeJS.ProcessEnv;
    const gates = { orchestrator: true };
    const d = evaluate(call("sed -i s/a/b/ src/x.ts"), { ...base(), env: orch, gates });
    expect(d).toMatchObject({ action: "deny", patternId: "orchestrator-bash" });
    expect(evaluate(call("npx vitest run"), { ...base(), env: orch, gates }).action).toBe("allow");
    expect(evaluate(call("sed -i s/a/b/ src/x.ts"), { ...base(), gates }).action).toBe("allow");
  });

  it("edit gate: denies a code edit in a git work tree, allows prose, exempt prefixes and non-repos", () => {
    const edit = (file_path: string) => ({ kind: "tool_call" as const, tool: "Edit", input: { file_path }, cwd });
    const gates = (exempt: boolean, repo: boolean) => ({ edit: { isExemptPrefix: () => exempt, isGitWorkTree: () => repo } });
    const d = evaluate(edit("/r/src/a.ts"), { ...base(), gates: gates(false, true) });
    expect(d).toMatchObject({ action: "deny", patternId: "edit-gate" });
    expect(d.message).toContain("Code changes are delegated");
    expect(evaluate(edit("/r/notes.md"), { ...base(), gates: gates(false, true) }).action).toBe("allow");
    expect(evaluate(edit("/r/src/a.ts"), { ...base(), gates: gates(true, true) }).action).toBe("allow");
    expect(evaluate(edit("/r/src/a.ts"), { ...base(), gates: gates(false, false) }).action).toBe("allow");
  });

  it("credential literal: denies a literal secret in a worker test file, allows other files and non-workers", () => {
    const secret = ["xox", "b-1234567890-1234567890-abcdefghijklmnopqrstuvwx"].join("");
    const write = (file_path: string) => ({ kind: "tool_call" as const, tool: "Write", input: { file_path, content: `const t = "${secret}";` }, cwd });
    const gates = { credential: true };
    const d = evaluate(write("/r/a.test.ts"), { ...base(), env: worker, gates });
    expect(d).toMatchObject({ action: "deny", patternId: "credential-literal" });
    expect(d.message).toContain("fake-secret.ts");
    expect(evaluate(write("/r/a.ts"), { ...base(), env: worker, gates }).action).toBe("allow");
    expect(evaluate(write("/r/a.test.ts"), { ...base(), gates }).action).toBe("allow");
  });
});
