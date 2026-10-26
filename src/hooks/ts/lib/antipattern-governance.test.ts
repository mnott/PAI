import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { activeAntipattern, shippedAntipattern, getAntipattern, loadAntipatterns, resetAntipatternCache, validateAntipattern } from "./antipatterns.js";
import { dispositionOf, parseLifecycle, type Lifecycle } from "./antipattern-lifecycle.js";
import { candidatesDir, excerptOf, firingsPath, outcomesPath, readFirings, readOutcomes, recordFiring, recordRunOutcomes, writeCandidate } from "./antipattern-log.js";
import { recordLoopTelemetry } from "./loop-guard-telemetry.js";
import { emptyLoopState, recordLoopResult, stepLoopGuard, type LoopState } from "./loop-guard.js";
import { BUILTIN_RULES } from "./rules/builtin.generated.js";
import { unparsedCallDecision } from "../../../workers/run/unparsed-call.js";
import { finaliseRun } from "../../../workers/run.js";
import { requestLoopStop } from "../../../workers/loop-stop.js";
import { saveStatus, type WorkerStatus } from "../../../workers/status.js";
import { candidates, conflicts, label, promote, retire, setMode, setParam, setProxy, stats } from "../../../antipatterns/govern.js";
import { allRuleDirs, loadRules, projectRuleDirs } from "./rules/load.js";

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-apg-"));
  prevHome = process.env.PAI_HOME;
  process.env.PAI_HOME = home;
  resetAntipatternCache();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  resetAntipatternCache();
});

const lines = (p: string): any[] => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const userFile = (...p: string[]): string => join(home, "antipatterns", ...p);
const noop = () => undefined;

describe("lifecycle fields", () => {
  it("every shipped pattern and shell rule is stable, enforce, version 1, with a created date", () => {
    for (const a of loadAntipatterns().filter((x) => x.source === "shipped")) {
      // distinct-rewrites went stable/enforce as version 2 (the Bash-write blind spot closed)
      expect([a.status, a.mode, a.version]).toEqual(["stable", "enforce", a.id === "distinct-rewrites" ? 2 : 1]);
      expect(a.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.proxy).toBe("monitor"); // shipped patterns never act on the proxy until a user override says so
    }
    for (const r of BUILTIN_RULES) {
      expect([r.status, r.mode, r.version]).toEqual(["stable", "enforce", 1]);
      expect(r.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.proxy).toBe("monitor");
    }
  });
  it("defaults keep today's behaviour and bad values are rejected", () => {
    const lc = parseLifecycle({});
    expect(lc).toMatchObject({ status: "stable", mode: "enforce", version: 1, supersedes: [], falsepositives: [] });
    expect(parseLifecycle({ status: "wip" })).toMatch(/status/);
    expect(parseLifecycle({ mode: "dry" })).toMatch(/mode/);
    expect(parseLifecycle({})).toMatchObject({ proxy: "monitor" });
    expect(parseLifecycle({ proxy: "enforce" })).toMatchObject({ proxy: "enforce" });
    expect(parseLifecycle({ proxy: "dry" })).toMatch(/proxy/);
    expect(parseLifecycle({ version: 0 })).toMatch(/version/);
    expect(parseLifecycle({ exceptions: [{ match: "(", reason: "x" }] })).toMatch(/regex/);
    const raw = { id: "x", category: "tool-loop", detector: { kind: "observed" }, action: "note", message: "m", status: "nope" };
    expect(validateAntipattern(raw, null, "t")).toMatch(/status/);
  });
  it("monitor, deprecated, expired and live exceptions, applies_to", () => {
    const base: Pick<Lifecycle, "status" | "mode" | "proxy" | "exceptions"> = { status: "stable", mode: "enforce", proxy: "monitor", exceptions: [] };
    expect(dispositionOf({ ...base, mode: "monitor" })).toBe("monitor");
    expect(dispositionOf({ ...base, status: "deprecated" })).toBe("off");
    const ex = (expires?: string): typeof base => ({ ...base, exceptions: [{ match: "safe", reason: "r", expires }] });
    expect(dispositionOf(ex("2999-01-01"), "a safe thing")).toBe("off");
    expect(dispositionOf(ex("2000-01-01"), "a safe thing")).toBe("enforce");
    expect(dispositionOf({ ...base, applies_to: { models: ["glm-5"] } }, "", { PAI_WORKER_MODEL: "other" })).toBe("off");
    expect(dispositionOf({ ...base, applies_to: { models: ["glm-5"] } }, "", { PAI_WORKER_MODEL: "glm-5" })).toBe("enforce");
  });
  it("the proxy path: proxy off records nothing, proxy monitor records only, proxy enforce acts only with lifecycle enforce", () => {
    const base: Pick<Lifecycle, "status" | "mode" | "proxy" | "exceptions"> = { status: "stable", mode: "enforce", proxy: "monitor", exceptions: [] };
    expect(dispositionOf(base, "", {}, Date.now(), "proxy")).toBe("monitor");
    expect(dispositionOf({ ...base, proxy: "off" }, "", {}, Date.now(), "proxy")).toBe("off");
    expect(dispositionOf({ ...base, proxy: "enforce" }, "", {}, Date.now(), "proxy")).toBe("enforce");
    expect(dispositionOf({ ...base, mode: "monitor", proxy: "enforce" }, "", {}, Date.now(), "proxy")).toBe("monitor");
    expect(dispositionOf({ ...base, status: "deprecated", proxy: "enforce" }, "", {}, Date.now(), "proxy")).toBe("off");
    // the hook path ignores proxy entirely
    expect(dispositionOf({ ...base, proxy: "off" })).toBe("enforce");
  });
});

describe("firing record", () => {
  it("has the documented fields, no raw input, home paths as ~", () => {
    const secret = `${homedir()}/private/${"x".repeat(200)}`;
    const ts = recordFiring({ id: "revert", version: 2, category: "tool-loop", action: "stop", mode: "enforce", input: secret, cwd: "/some/where/proj", env: { PAI_WORKER_PROVIDER: "glm", PAI_WORKER_MODEL: "glm-5", PAI_WORKER_ID: "w-9" } });
    const [f] = lines(firingsPath());
    expect(f).toMatchObject({ ts, id: "revert", version: 2, category: "tool-loop", action: "stop", mode: "enforce", provider: "glm", model: "glm-5", workerId: "w-9", project: "proj", disposition: "undetermined" });
    expect(f.inputHash).toMatch(/^[0-9a-f]{40}$/);
    expect(f.excerpt.length).toBe(120);
    expect(f.excerpt.startsWith("~/private/")).toBe(true);
    expect(JSON.stringify(f)).not.toContain(homedir());
    expect(JSON.stringify(f)).not.toContain("/some/where");
  });
  it("model is session outside a worker; PAI_ALLOW_* marks a denied firing fp", () => {
    recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x", env: { PAI_ALLOW_X: "1" } });
    recordFiring({ id: "a", category: "shell", action: "note", mode: "enforce", input: "x", env: { PAI_ALLOW_X: "1" } });
    const f = readFirings();
    expect(f[0]).toMatchObject({ model: "session", provider: "session", disposition: "fp" });
    expect(f[1].disposition).toBe("undetermined");
  });
  it("never throws and is fast", () => {
    writeFileSync(join(home, "antipatterns"), "a file where the directory should be");
    expect(recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x" })).toBeNull();
    rmSync(join(home, "antipatterns"));
    recordFiring({ id: "warm", category: "shell", action: "deny", mode: "enforce", input: "x" });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x" });
    expect((performance.now() - t0) / 100).toBeLessThan(1);
  });
  it("rotates at 10 MB", () => {
    mkdirSync(userFile(), { recursive: true });
    writeFileSync(firingsPath(), "x".repeat(10 * 1024 * 1024 + 1));
    recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x" });
    expect(existsSync(`${firingsPath()}.1`)).toBe(true);
    expect(lines(firingsPath())).toHaveLength(1);
  });
  it("excerptOf hides other users' home paths too", () => {
    expect(excerptOf("cat /Users/someone/.ssh/id_rsa /home/bob/x")).toBe("cat ~/.ssh/id_rsa ~/x");
  });
});

describe("a firing from every kind of source", () => {
  it("loop guard: a pattern step is recorded with its id, version and action", () => {
    let state: LoopState = emptyLoopState();
    let last = stepLoopGuard(state, "Write", { file_path: "f", content: "A" });
    for (let i = 0; i < 25 && !last.stop; i++) {
      state = last.state;
      last = stepLoopGuard(state, "Write", { file_path: "f", content: "A" });
    }
    expect(last.stop).toBe(true);
    expect(last.id).toBe("identical-write");
    recordLoopTelemetry(last, { fallbackText: "Write" });
    expect(readFirings().at(-1)).toMatchObject({ id: "identical-write", category: "tool-loop", action: "stop", mode: "enforce", version: 1 });
  });

  it("unparsed-call continuation decision: enforce acts, monitor does not, retired is off", () => {
    const text = "Files written.\n<tool_call>\n<function=Bash>\n<parameter=command>\nls run\n</parameter>\n</function>\n</tool_call>";
    expect(unparsedCallDecision(text)).toMatchObject({ name: "Bash", mode: "enforce" });
    setMode("unparsed-tool-call", "monitor");
    expect(unparsedCallDecision(text)).toMatchObject({ name: "Bash", mode: "monitor", version: 2 });
    retire("unparsed-tool-call");
    expect(unparsedCallDecision(text)).toBeNull();
  });

  const hook = (script: string, input: object, env: NodeJS.ProcessEnv = {}) => {
    const { PAI_WORKER: _w, ...base } = process.env;
    try {
      return { status: 0, stdout: execFileSync("node_modules/.bin/tsx", [script], { input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 50_000, env: { ...base, PAI_HOME: home, ...env } }), stderr: "" };
    } catch (e) {
      const x = e as { status: number | null; stdout: string; stderr: string };
      return { status: x.status, stdout: x.stdout, stderr: x.stderr };
    }
  };

  it("shell rule in the security validator: enforce denies and records, monitor records and allows", { timeout: 60_000 }, () => {
    const input = { session_id: "s1", tool_name: "Bash", tool_input: { command: "git reset --hard HEAD~1" }, cwd: process.cwd() };
    const v = "src/hooks/ts/pre-tool-use/security-validator.ts";
    expect(hook(v, input).status).toBe(2);
    expect(lines(firingsPath()).at(-1)).toMatchObject({ id: "git-reset-hard", category: "shell", action: "deny", mode: "enforce", sessionId: "s1" });
    setMode("git-reset-hard", "monitor");
    expect(existsSync(userFile("shell", "git-reset-hard.yaml"))).toBe(true);
    expect(hook(v, input).status).toBe(0);
    expect(lines(firingsPath()).at(-1)).toMatchObject({ id: "git-reset-hard", action: "deny", mode: "monitor", version: 2 });
  });

  it("path-repair deny: recorded; monitor lets the call through", { timeout: 60_000 }, () => {
    const v = "src/hooks/ts/pre-tool-use/worker-tool-name-repair.ts";
    const input = { tool_name: "Read", tool_input: { file_path: "/nonexistent-dir-for-ap-test/file.ts" }, cwd: process.cwd() };
    const env = { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "glm", PAI_WORKER_MODEL: "glm-5" };
    expect(hook(v, input, env).stdout).toContain("does not exist");
    expect(lines(firingsPath()).at(-1)).toMatchObject({ id: "does-not-exist", category: "paths", action: "deny", mode: "enforce", provider: "glm", model: "glm-5" });
    setMode("does-not-exist", "monitor");
    expect(hook(v, input, env).stdout).not.toContain("does not exist");
    expect(lines(firingsPath()).at(-1)).toMatchObject({ id: "does-not-exist", mode: "monitor" });
  });
});

describe("monitor mode in the loop guard", () => {
  it("records what it would have done and takes no action", () => {
    setMode("repeated-failure", "monitor");
    let state: LoopState = emptyLoopState();
    let last = stepLoopGuard(state, "Bash", { command: "npx vitest run a.test.ts" });
    for (let i = 0; i < 6; i++) {
      state = recordLoopResult(last.state, "Bash", { command: "npx vitest run a.test.ts" }, "same");
      last = stepLoopGuard(state, "Bash", { command: "npx vitest run a.test.ts" });
    }
    expect(last.deny).toBe(false);
    expect(last.stop).toBe(false);
    expect(last.monitored).toEqual({ action: "stop" });
    recordLoopTelemetry(last, { fallbackText: "Bash" });
    expect(readFirings().at(-1)).toMatchObject({ id: "repeated-failure", action: "stop", mode: "monitor", version: 2 });
  });
  it("enforce is unchanged", () => {
    let state: LoopState = emptyLoopState();
    let last = stepLoopGuard(state, "Bash", { command: "npx vitest run a.test.ts" });
    for (let i = 0; i < 2; i++) {
      state = recordLoopResult(last.state, "Bash", { command: "npx vitest run a.test.ts" }, "same");
      last = stepLoopGuard(state, "Bash", { command: "npx vitest run a.test.ts" });
    }
    expect(last.deny).toBe(true);
    expect(last.monitored).toBeUndefined();
  });
});

describe("distinct-rewrites", () => {
  const W = (i: number) => ({ file_path: "out/27.py", content: `v${i}` });
  const run = (n: number, between?: (i: number) => void) => {
    let state: LoopState = emptyLoopState();
    const steps: ReturnType<typeof stepLoopGuard>[] = [];
    for (let i = 0; i < n; i++) {
      const r = stepLoopGuard(state, "Write", W(i));
      steps.push(r);
      state = r.state;
      if (between && i % 2 === 1) state = stepLoopGuard(state, "Bash", { command: `pytest t${i}` }).state;
    }
    return steps;
  };
  it("monitor (user override): 9 distinct writes without a read record one firing and add no note", () => {
    setMode("distinct-rewrites", "monitor");
    const steps = run(9);
    for (const r of steps) recordLoopTelemetry(r, { fallbackText: "Write" });
    expect(steps.every((r) => !r.note && !r.deny)).toBe(true);
    const f = readFirings().filter((x) => x.id === "distinct-rewrites");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ action: "note", mode: "monitor", version: 3 });
  });
  it("writes interleaved with a Bash test run do not fire", () => {
    expect(run(20, () => undefined).some((r) => r.monitored || r.note)).toBe(false);
  });
  it("enforce (shipped): the note is emitted once", () => {
    const steps = run(9);
    const notes = steps.filter((r) => r.note);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toContain("out/27.py");
    expect(notes[0].note).toContain("8 times");
    expect(notes[0].id).toBe("distinct-rewrites");
  });
});

describe("outcome linking", () => {
  const status = (id: string): WorkerStatus => ({
    id, pid: -1, label: "task", cwd: home, term: "", provider: "p", model: "m", state: "running",
    started: "2026-09-29 10:00:00", updated: "2026-09-29 10:00:00", turns: 0, tools: 0, last: "", rc: null, secs: null,
  });
  const fire = (workerId: string, action: "deny" | "continue") => recordFiring({ id: "revert", category: "tool-loop", action, mode: "enforce", input: "x", env: { PAI_WORKER_ID: workerId } });

  it("one outcome line per firing of the run, other runs untouched, no double write", () => {
    const a = fire("w-1", "deny");
    const b = fire("w-1", "continue");
    fire("w-2", "deny");
    expect(recordRunOutcomes("w-1", "succeeded")).toHaveLength(2);
    expect(recordRunOutcomes("w-1", "succeeded")).toHaveLength(0);
    const out = readOutcomes();
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.firingTs === a)).toMatchObject({ id: "revert", workerId: "w-1", outcome: "run-succeeded", final: "succeeded" });
    expect(out.find((o) => o.firingTs === b)).toMatchObject({ outcome: "run-continued", final: "succeeded" });
  });

  it("finaliseRun writes run-stopped for a loop-stopped run and run-failed for a failed one", async () => {
    const logDir = join(home, "logs");
    mkdirSync(logDir);
    fire("w-1", "deny");
    const s = status("w-1");
    saveStatus(logDir, s);
    requestLoopStop(logDir, "w-1", "Bash x repeated 5 times", { kill: noop, claudePid: () => 1 });
    await finaliseRun({ logDir, ledger: join(logDir, "ledger.log"), status: s, ok: false, rc: 143, secs: 5, end: {}, report: null });
    expect(readOutcomes().filter((o) => o.workerId === "w-1")).toMatchObject([{ outcome: "run-stopped", final: "stopped" }]);

    fire("w-3", "deny");
    const s3 = status("w-3");
    saveStatus(logDir, s3);
    await finaliseRun({ logDir, ledger: join(logDir, "ledger.log"), status: s3, ok: false, rc: 1, secs: 5, end: {}, report: null });
    expect(readOutcomes().filter((o) => o.workerId === "w-3")).toMatchObject([{ outcome: "run-failed" }]);
  });
});

describe("candidates", () => {
  it("an uncovered loop-guard stop writes an inactive candidate once", () => {
    // a build-door poll that finished 5 times: denied by the guard, covered by no pattern id
    const cmd = "pai build run npm test";
    const step = { state: emptyLoopState(), deny: true, stop: true, key: `${homedir()}/proj ${cmd}`, reason: "loop guard: gone nowhere" } as const;
    recordLoopTelemetry(step, { fallbackText: "Bash" });
    recordLoopTelemetry(step, { fallbackText: "Bash" });
    const files = readdirSync(candidatesDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.yaml$/);
    const doc = parse(readFileSync(join(candidatesDir(), files[0]), "utf8"));
    expect(doc).toMatchObject({ status: "experimental", mode: "monitor", category: "tool-loop", action: "stop" });
    expect(doc.tests.match[0]).toBe(`~/proj ${cmd}`);
    expect(doc.provenance).toMatchObject({ model: "session" });
    expect(readFirings()).toHaveLength(0);
    // never active
    expect(getAntipattern(doc.id)).toBeUndefined();
    expect(candidates().map((c) => c.id)).toEqual([doc.id]);
  });
  it("a covered step writes no candidate", () => {
    recordLoopTelemetry({ state: emptyLoopState(), deny: true, id: "growing-command", key: "ls" }, { fallbackText: "Bash" });
    expect(existsSync(candidatesDir())).toBe(false);
  });
});

describe("governance commands", () => {
  it("promote moves a candidate into its category as status test, mode monitor", () => {
    const path = writeCandidate({ category: "tool-loop", action: "deny", message: "m", input: "some observed input" })!;
    const id = candidates()[0].id;
    const target = promote(id);
    expect(target).toBe(userFile("tool-loop", `${id}.yaml`));
    expect(existsSync(path)).toBe(false);
    expect(candidates()).toHaveLength(0);
    const ap = getAntipattern(id)!;
    expect([ap.status, ap.mode, ap.category]).toEqual(["test", "monitor", "tool-loop"]);
    expect(() => promote("nope")).toThrow(/no candidate/);
  });

  it("monitor / enforce / retire write user overrides and never touch shipped files", () => {
    const shipped = readFileSync("antipatterns/tool-loop/revert.yaml", "utf8");
    setMode("revert", "monitor");
    const f = userFile("tool-loop", "revert.yaml");
    expect(parse(readFileSync(f, "utf8"))).toMatchObject({ id: "revert", mode: "monitor", status: "stable", version: 2 });
    expect(activeAntipattern("revert").mode).toBe("monitor");
    setMode("revert", "enforce");
    expect(parse(readFileSync(f, "utf8"))).toMatchObject({ mode: "enforce", version: 3 });
    retire("revert", "no longer needed");
    expect(parse(readFileSync(f, "utf8"))).toMatchObject({ status: "deprecated", reason: "no longer needed", version: 4 });
    expect(activeAntipattern("revert").status).toBe("deprecated");
    expect(readFileSync("antipatterns/tool-loop/revert.yaml", "utf8")).toBe(shipped);
    // a shell rule: override lands in the user shell directory and a retired rule is not loaded
    retire("git-push-force");
    const sh = parse(readFileSync(userFile("shell", "git-push-force.yaml"), "utf8"));
    expect(sh).toMatchObject({ id: "git-push-force", status: "deprecated", severity: expect.any(String) });
    expect(() => setMode("no-such", "monitor")).toThrow(/unknown pattern/);
  });

  it("conflicts finds a constructed overlapping pair and a duplicate id", () => {
    expect(conflicts()).toEqual([]);
    const rule = (id: string, sev: string, re: string, fixture: string) =>
      `id: ${id}\nseverity: ${sev}\nreason: r\nmatch: "${re}"\ntests:\n  match: ["${fixture}"]\n  no_match: ["zzz"]\n`;
    mkdirSync(userFile("shell"), { recursive: true });
    writeFileSync(userFile("shell", "a-rule.yaml"), rule("a-rule", "block", "frobnicate", "frobnicate now"));
    writeFileSync(userFile("shell", "b-rule.yaml"), rule("b-rule", "warn", "frob", "frobnicate later"));
    const found = conflicts();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "overlap", ids: ["a-rule", "b-rule"] });
    writeFileSync(userFile("shell", "c-rule.yaml"), rule("a-rule", "block", "frobnicate", "frobnicate now"));
    expect(conflicts().some((c) => c.kind === "duplicate-id" && c.ids[0] === "a-rule")).toBe(true);
    retire("b-rule");
    expect(conflicts().some((c) => c.kind === "overlap")).toBe(false);
  });
});

describe("stats", () => {
  const put = (o: Partial<Parameters<typeof recordFiring>[0]> & { id: string }, workerId: string, model: string) =>
    recordFiring({ category: "tool-loop", action: "deny", mode: "enforce", input: `${o.id}-${workerId}`, env: { PAI_WORKER_ID: workerId, PAI_WORKER_MODEL: model, PAI_WORKER_PROVIDER: "p" }, ...o });

  it("aggregates count, last fired, models, actions, outcomes and flags", () => {
    for (let i = 0; i < 5; i++) put({ id: "revert" }, `w-${i}`, "glm-5");
    put({ id: "revert", action: "stop" }, "w-9", "glm-5");
    put({ id: "growing-command", action: "note" }, "w-a", "qwen");
    put({ id: "growing-command" }, "w-b", "glm-5");
    recordRunOutcomes("w-1", "succeeded");
    recordRunOutcomes("w-2", "failed");
    recordRunOutcomes("w-9", "stopped");
    recordRunOutcomes("w-b", "succeeded");

    const rows = stats();
    const rev = rows.find((r) => r.id === "revert")!;
    expect(rev.count).toBe(6);
    expect(rev.byModel).toEqual({ "glm-5": 6 });
    expect(rev.actions).toEqual({ deny: 5, stop: 1 });
    expect(rev.outcomes).toMatchObject({ "run-succeeded": 1, "run-failed": 1, "run-stopped": 1, none: 3 });
    expect(rev.lastFired).toBeTruthy();
    expect(rev.flags).toContain("model-quirk");
    // a deny followed by a successful run is a suspect
    expect(rev.falsePositiveSuspect).toBe(true);
    const gc = rows.find((r) => r.id === "growing-command")!;
    expect(gc.byModel).toEqual({ qwen: 1, "glm-5": 1 });
    expect(gc.flags).not.toContain("model-quirk");
    // a pattern that never fired and is older than 30 days is a retire candidate; today's shipped ones are not
    expect(rows.find((r) => r.id === "identical-write")!.count).toBe(0);
    expect(rows.find((r) => r.id === "identical-write")!.flags).toEqual([]);

    expect(stats({ model: "qwen" }).map((r) => r.id)).toEqual(["growing-command"]);
    expect(stats({ sinceMs: 60_000 }).find((r) => r.id === "revert")!.count).toBe(6);
    expect(stats({ sinceMs: 1000, now: Date.now() + 3_600_000 }).find((r) => r.id === "revert")!.count).toBe(0);
  });

  it("labels drive the false-positive rate and the retire flag; 30 days without firing retires", () => {
    for (let i = 0; i < 10; i++) put({ id: "revert" }, `w-${i}`, "m");
    expect(label("revert", "fp")).toBe(10);
    const rev = stats().find((r) => r.id === "revert")!;
    expect(rev.fpRate).toBe(1);
    expect(rev.overrideRate).toBe(1);
    expect(rev.flags.some((f) => f.includes("false-positive rate"))).toBe(true);
    const later = stats({ now: Date.now() + 40 * 86_400_000 });
    expect(later.find((r) => r.id === "identical-write")!.flags.some((f) => f.includes("no firing in 30 days"))).toBe(true);
    expect(() => label("nothing", "tp")).toThrow(/no firing/);
  });

  it("a deny of an invented path followed by a successful run is not a suspect (paths category)", () => {
    put({ id: "does-not-exist", category: "paths" }, "w-p", "m");
    recordRunOutcomes("w-p", "succeeded");
    expect(stats().find((r) => r.id === "does-not-exist")!.falsePositiveSuspect).toBe(false);
    // the same shape in a non-path category still is
    put({ id: "revert" }, "w-r", "m");
    recordRunOutcomes("w-r", "succeeded");
    expect(stats().find((r) => r.id === "revert")!.falsePositiveSuspect).toBe(true);
  });

  it("a monitor hit with no bad outcome is a suspect", () => {
    put({ id: "growing-command", mode: "monitor" }, "w-1", "m");
    recordRunOutcomes("w-1", "succeeded");
    expect(stats().find((r) => r.id === "growing-command")!.falsePositiveSuspect).toBe(true);
  });
});

describe("set", () => {
  const govLines = (): any[] => lines(userFile("governance.jsonl"));
  it("changes a detector param through a full override, hot, with version, changes and governance line", () => {
    expect(activeAntipattern("identical-write").detector.params.stop_at).toBe(20);
    const r = setParam("identical-write", "stop_at", "8", "loops cost too much");
    expect(r).toMatchObject({ from: 20, to: 8, version: 2 });
    const a = activeAntipattern("identical-write");
    expect(a.detector.params.stop_at).toBe(8);
    expect(a.version).toBe(2);
    expect(a.detector.params.note_at).toBe(shippedAntipatternParam("note_at"));
    const doc = parse(readFileSync(userFile("tool-loop", "identical-write.yaml"), "utf8"));
    expect(doc.modified).toBe(new Date().toISOString().slice(0, 10));
    expect(doc.changes).toEqual([{ date: doc.modified, param: "stop_at", from: 20, to: 8, reason: "loops cost too much" }]);
    expect(govLines()).toEqual([expect.objectContaining({ action: "set", id: "identical-write", param: "stop_at", from: 20, to: 8, reason: "loops cost too much" })]);
    // a second change keeps the first entry
    setParam("identical-write", "stop_at", "9", "too tight");
    expect(activeAntipattern("identical-write")).toMatchObject({ version: 3 });
    expect(parse(readFileSync(userFile("tool-loop", "identical-write.yaml"), "utf8")).changes).toHaveLength(2);
  });
  it("proxy: a shell rule gets a full override copy with the new proxy value, hot without a restart", () => {
    expect(loadRules(allRuleDirs(process.cwd()), { projectDirs: projectRuleDirs(process.cwd()) }).rules.find((r) => r.id === "git-reset-hard")!.proxy).toBe("monitor");
    const r = setProxy("git-reset-hard", "enforce", "protect Joule behind the router");
    expect(r).toMatchObject({ from: "monitor", to: "enforce", version: 2 });
    const doc = parse(readFileSync(userFile("shell", "git-reset-hard.yaml"), "utf8"));
    expect(doc.proxy).toBe("enforce");
    expect(doc.match).toBeTruthy();
    expect(doc.version).toBe(2);
    expect(govLines()).toEqual([expect.objectContaining({ action: "set", id: "git-reset-hard", param: "proxy", from: "monitor", to: "enforce" })]);
    expect(loadRules(allRuleDirs(process.cwd()), { projectDirs: projectRuleDirs(process.cwd()) }).rules.find((x) => x.id === "git-reset-hard")!.proxy).toBe("enforce");
  });
  it("proxy refuses an unknown id and a missing reason", () => {
    expect(() => setProxy("nope", "enforce", "r")).toThrow(/unknown pattern/);
    expect(() => setProxy("git-reset-hard", "enforce", "")).toThrow(/reason/);
  });
  it("refuses an unknown id, an unknown param and a type mismatch", () => {
    expect(() => setParam("nope", "stop_at", "1", "r")).toThrow(/unknown pattern/);
    expect(() => setParam("identical-write", "bogus", "1", "r")).toThrow(/valid params: .*stop_at/);
    expect(() => setParam("identical-write", "stop_at", "many", "r")).toThrow(/number/);
    expect(() => setParam("identical-write", "stop_at", "8", "")).toThrow(/reason/);
    expect(existsSync(userFile("governance.jsonl"))).toBe(false);
    expect(activeAntipattern("identical-write").detector.params.stop_at).toBe(20);
  });
  it("commits the YAML and governance.jsonl in one commit when PAI_HOME is a git repo, never firings", () => {
    const g = (...a: string[]) => execFileSync("git", ["-C", home, ...a], { encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    writeFileSync(join(home, ".gitignore"), "/*\n");
    g("add", "-f", ".gitignore");
    g("commit", "-q", "-m", "init");
    mkdirSync(join(home, "antipatterns"), { recursive: true });
    writeFileSync(firingsPath(), "{}\n");
    setParam("identical-write", "stop_at", "8", "loops cost too much");
    expect(g("rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(g("log", "-1", "--format=%s").trim()).toMatch(/^config: antipatterns set identical-write stop_at=8/);
    expect(g("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["antipatterns/governance.jsonl", "antipatterns/tool-loop/identical-write.yaml"]);
    expect(g("ls-files")).not.toContain("firings");
  });
  it("enforce, monitor and retire write governance lines", () => {
    setMode("revert", "monitor");
    setMode("revert", "enforce");
    retire("revert", "unused");
    expect(govLines().map((l) => [l.action, l.id])).toEqual([["monitor", "revert"], ["enforce", "revert"], ["retire", "revert"]]);
    expect(govLines()[2].reason).toBe("unused");
  });
});
const shippedAntipatternParam = (k: string): unknown => shippedAntipattern("identical-write").detector.params[k];

describe("firing model attribution", () => {
  const status = (id: string, model: string): void => {
    mkdirSync(join(home, "logs", "workers"), { recursive: true });
    writeFileSync(join(home, "logs", "workers", `${id}.status`), JSON.stringify({ id, provider: "gyro-m", model }));
  };
  it("recordFiring falls back to the status file model when the env has none", () => {
    status("w-1", "qwen-x");
    recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x", env: { PAI_WORKER_ID: "w-1", PAI_WORKER_PROVIDER: "gyro-m" } });
    recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x", env: { PAI_WORKER_ID: "w-none" } });
    recordFiring({ id: "a", category: "shell", action: "deny", mode: "enforce", input: "x", env: { PAI_WORKER_ID: "w-1", PAI_WORKER_MODEL: "env-m" } });
    expect(readFirings().map((f) => f.model)).toEqual(["qwen-x", "session", "env-m"]);
  });
  it("stats resolve stored session firings of a worker; no workerId stays session", () => {
    status("w-2", "qwen-y");
    const base = { id: "identical-write", version: 1, category: "tool-loop", action: "stop", mode: "monitor", provider: "gyro-m", model: "session", project: "p", inputHash: "h", excerpt: "e", disposition: "undetermined" };
    mkdirSync(join(home, "antipatterns"), { recursive: true });
    const rows = [
      { ...base, ts: "2026-10-25T18:42:00.001Z", workerId: "w-2" },
      { ...base, ts: "2026-10-25T18:42:00.002Z", workerId: "w-2" },
      { ...base, ts: "2026-10-25T18:42:00.003Z" },
    ];
    writeFileSync(firingsPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const before = readFileSync(firingsPath(), "utf8");
    const row = stats().find((r) => r.id === "identical-write")!;
    expect(row.byModel).toEqual({ "qwen-y": 2, session: 1 });
    expect(stats({ model: "qwen-y" }).find((r) => r.id === "identical-write")!.count).toBe(2);
    expect(readFileSync(firingsPath(), "utf8")).toBe(before);
  });
});
