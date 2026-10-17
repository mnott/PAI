import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../parse.js";
import { GROUPS } from "../registry.js";
import { resolve, runCli, type Io } from "../run.js";
import { makeStyle } from "../help.js";
import { buildRunPlan, workerCommand } from "./worker.js";

const sub = (name: string) => workerCommand.subcommands!.find((c) => c.name === name)!;
const parse = (verb: string, argv: string[]) => parseArgs(sub(verb), argv);
const plan = (argv: string[]) => buildRunPlan(parse("run", argv));

const PORTED = [
  "run", "resume", "ps", "follow", "replay", "watch", "pane", "log", "say", "goal", "handoff", "merge", "verify",
  "wait-on", "wait-url", "wait-file", "wait", "pending", "errors", "discard", "gc", "kill", "status-line", "model", "capability",
];

describe("worker: declared surface", () => {
  it("every ported verb exists with a summary, 2+ examples and a run function", () => {
    for (const v of PORTED) {
      const c = sub(v);
      expect(c, v).toBeDefined();
      expect(c.summary.length, v).toBeGreaterThan(5);
      expect(c.examples.length, v).toBeGreaterThanOrEqual(2);
      expect(typeof c.run, v).toBe("function");
    }
  });
  it("`worker` is registered once, under the workers group", () => {
    const g = GROUPS.find((x) => x.id === "workers")!;
    expect(g.commands.filter((c) => c.name === "worker")).toHaveLength(1);
    expect(resolve(GROUPS, ["worker", "status-line", "a"]).cmd.name).toBe("status-line");
  });
  it("worker verbs are registered", () => {
    const group = GROUPS.flatMap((g) => g.commands).find((c) => c.name === "worker")!;
    const c = group.subcommands!.find((x) => x.name === "policy")!;
    expect(c).toBeDefined();
    expect(group.subcommands!.some((x) => x.name === "run")).toBe(true);
  });
});

describe("worker run: argument parsing", () => {
  it("keeps unknown flags and the prompt for claude, in order, and takes the known ones", () => {
    const p = parse("run", ["--provider", "glm", "-p", "do it", "--allowedTools", "Read,Edit", "--label", "L", "--output-format", "json", "--verbose"]);
    expect(p.opts.provider).toBe("glm");
    expect(p.opts.label).toBe("L");
    expect(p.rest).toEqual(["-p", "do it", "--allowedTools", "Read,Edit", "--output-format", "json", "--verbose"]);
  });
  it("accepts --flag=value for known and unknown flags", () => {
    const p = parse("run", ["--class=review", "--model=m", "--max-turns=3", "-p", "x"]);
    expect(p.opts.class).toBe("review");
    expect(p.opts.model).toBe("m");
    expect(p.rest).toEqual(["--max-turns=3", "-p", "x"]);
  });
  it("keeps a bare -- after an unknown flag (like the old command) and drops it otherwise", () => {
    expect(parse("run", ["-p", "x", "--", "--a"]).rest).toEqual(["-p", "x", "--", "--a"]);
    expect(parse("run", ["--", "--a"]).rest).toEqual(["--a"]);
  });
  it("reads the no- flags as their own switches", () => {
    const p = parse("run", ["--no-pane", "--no-worktree", "--no-browser", "--no-report-retry", "--local-ok", "-p", "x"]);
    expect(p.opts["no-pane"]).toBe(true);
    expect(p.opts["no-worktree"]).toBe(true);
    expect(p.opts["no-browser"]).toBe(true);
    expect(p.opts["no-report-retry"]).toBe(true);
    expect(p.opts["local-ok"]).toBe(true);
  });
  it("a number flag must be a number", () => {
    expect(() => parse("run", ["--max-minutes", "soon"])).toThrow(/needs a number/);
  });
});

describe("worker run: what is handed to the engine", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-worker-run-"));
    vi.stubEnv("PAI_WORKER", "1");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("passes claude args verbatim and derives the label from the prompt", () => {
    const r = plan(["--class", "implement", "-p", "Fix the loop\nsecond line", "--allowedTools", "Read"]);
    expect(r.kind).toBe("run");
    if (r.kind !== "run") return;
    expect(r.run.claudeArgs).toEqual(["-p", "Fix the loop\nsecond line", "--allowedTools", "Read"]);
    expect(r.run.className).toBe("implement");
    expect(r.run.label).toContain("Fix the loop");
    expect(r.run.worktreeFlag).toBeUndefined();
    expect(r.run.noPane).toBe(false);
    expect(r.run.noReportRetry).toBe(false);
  });
  it("maps --role and --for to --class and --capability, and the no- switches to false", () => {
    const r = plan(["--role", "review", "--for", "image", "--no-worktree", "--no-browser", "--no-pane", "--no-report-retry", "--orchestrate", "-p", "x"]);
    if (r.kind !== "run") throw new Error("expected run");
    expect(r.run.className).toBe("review");
    expect(r.run.capabilityFlag).toBe("image");
    expect(r.run.worktreeFlag).toBe(false);
    expect(r.run.browser).toBe(false);
    expect(r.run.noReportRetry).toBe(true);
    expect(r.run.noPane).toBe(true);
    expect(r.run.orchestrate).toBe(true);
  });
  it("passes --orchestrate through to the run plan", () => {
    const r = plan(["--orchestrate", "-p", "x"]);
    if (r.kind !== "run") throw new Error("expected run");
    expect(r.run.orchestrate).toBe(true);
  });
  it("passes --orchestrate through to the run plan", () => {
    const r2 = plan(["-p", "x"]);
    if (r2.kind !== "run") throw new Error("expected run");
    expect(r2.run.orchestrate).toBeUndefined();
  });
  it("carries provider, model, deadline, max-minutes, mcp, report and the routing switches", () => {
    const r = plan(["--provider", "p", "--model", "m", "--deadline", "23:59", "--max-minutes", "5", "--mcp", "a,b", "--report", "json", "--urgent", "--cloud", "--local-ok", "--worktree", "--print-cmd", "-p", "x"]);
    if (r.kind !== "run") throw new Error("expected run");
    expect(r.run).toMatchObject({
      providerFlag: "p", modelFlag: "m", deadline: "23:59", maxMinutes: 5, mcpFlag: "a,b", reportFormatFlag: "json",
      urgent: true, cloud: true, localOk: true, worktreeFlag: true, printCmd: true,
    });
  });
  it("the global --dry-run prints the command instead of starting (same as --print-cmd)", () => {
    const r = plan(["--dry-run", "-p", "x"]);
    if (r.kind !== "run") throw new Error("expected run");
    expect(r.run.printCmd).toBe(true);
  });
  it("--chain builds a chain with the brief and stages", () => {
    const r = plan(["--chain", "draft,implement", "-p", "brief text"]);
    expect(r.kind).toBe("chain");
    if (r.kind !== "chain") return;
    expect(r.chain.stages).toEqual(["draft", "implement"]);
    expect(r.chain.brief).toBe("brief text");
  });
  it("--chain without a prompt, a bad --report and a missing --cwd fail with plain sentences", () => {
    expect(() => plan(["--chain", "draft"])).toThrow("--chain needs the task as -p '<brief>'");
    expect(() => plan(["--report", "xml", "-p", "x"])).toThrow('--report: expected "json" or "ag2", got "xml"');
    expect(() => plan(["--cwd", join(dir, "nope"), "-p", "x"])).toThrow(/directory does not exist/);
  });
  it("--spec reads the prompt from the file and refuses -p alongside it", () => {
    const spec = join(dir, "task.txt");
    writeFileSync(spec, "the task text\n");
    const r = plan(["--spec", spec, "--cwd", dir]);
    if (r.kind !== "run") throw new Error("expected run");
    expect(r.run.claudeArgs[0]).toBe("-p");
    expect(r.run.claudeArgs[1]).toContain("the task text");
    expect(r.run.specPath).toBe(spec);
    expect(() => plan(["--spec", spec, "-p", "x"])).toThrow(/mutually exclusive/);
  });
});

describe("other verbs: argument parsing", () => {
  it("merge reads --no-commit and --patch; the id is required", () => {
    expect(parse("merge", ["w1", "--no-commit"]).opts["no-commit"]).toBe(true);
    expect(parse("merge", ["w1", "--patch"]).opts.patch).toBe(true);
    expect(() => parse("merge", [])).toThrow(/missing required argument ID/);
  });
  it("follow's --auto-exit takes an optional number", () => {
    expect(parse("follow", ["--auto-exit"]).opts["auto-exit"]).toBe(true);
    expect(parse("follow", ["--auto-exit", "30", "w1"]).opts["auto-exit"]).toBe(30);
    expect(parse("follow", ["--auto-exit", "30", "w1"]).args.ID).toBe("w1");
    expect(parse("follow", ["w1", "--auto-exit"]).opts["auto-exit"]).toBe(true);
  });
  it("status-line takes three optional positionals, empty strings kept", () => {
    const p = parse("status-line", ["T", "/some/dir", ""]);
    expect(p.args).toEqual({ TERM: "T", CWD: "/some/dir", SESSION: "" });
    expect(parse("status-line", []).args.TERM).toBeUndefined();
  });
  it("wait takes several ids and a timeout; wait-on a pid with log, max and tail", () => {
    const w = parse("wait", ["a", "b", "--timeout", "5"]);
    expect(w.args.IDS).toEqual(["a", "b"]);
    expect(w.opts.timeout).toBe(5);
    const o = parse("wait-on", ["123", "--log", "/tmp/x.log", "--max", "9", "--tail", "3"]);
    expect(o.args.PID).toBe("123");
    expect(o.opts).toMatchObject({ log: "/tmp/x.log", max: 9, tail: 3 });
  });
  it("gc defaults --older-than to 24 and honours --dry-run", () => {
    expect(parse("gc", []).opts["older-than"]).toBe("24");
    expect(parse("gc", ["--dry-run"]).dryRun).toBe(true);
  });
  it("errors defaults --since to 24h; pending reads --all --json --gate", () => {
    expect(parse("errors", []).opts.since).toBe("24h");
    expect(parse("pending", ["--all", "--json", "--gate"]).opts).toMatchObject({ all: true, json: true, gate: true });
  });
  it("say needs id and text, and takes --goal; model/capability take their optional words", () => {
    expect(() => parse("say", ["w1"])).toThrow(/missing required argument TEXT/);
    expect(parse("say", ["w1", "hi", "--goal", "G"]).opts.goal).toBe("G");
    expect(parse("model", ["fast", "m", "--provider", "p"]).args).toEqual({ WHAT: "fast", MODEL: "m" });
    expect(parse("capability", ["image", "a,b"]).args).toEqual({ NAME: "image", PROVIDERS: "a,b" });
    expect(parse("capability", ["image", "--unset"]).opts.unset).toBe(true);
  });
});

describe("worker verbs: output and exit codes (temp PAI_HOME)", () => {
  let home: string;
  let saved: string | undefined;
  let written: string[];
  let errs: string[];
  const io: Io = { out: (s) => written.push(s), err: (s) => errs.push(s), style: makeStyle(false) };

  beforeEach(() => {
    saved = process.env.PAI_HOME;
    home = mkdtempSync(join(tmpdir(), "pai-worker-home-"));
    mkdirSync(join(home, "logs", "workers"), { recursive: true });
    process.env.PAI_HOME = home;
    written = [];
    errs = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      errs.push(String(s));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = saved;
  });

  it("pending prints the empty sentence, JSON with --json, and --gate exits 0 when nothing is pending", async () => {
    expect(await runCli(GROUPS, ["worker", "pending"], io)).toBe(0);
    expect(written.join("")).toContain("no pending worker results");
    written.length = 0;
    expect(await runCli(GROUPS, ["worker", "pending", "--json"], io)).toBe(0);
    expect(JSON.parse(written.join(""))).toEqual([]);
    expect(await runCli(GROUPS, ["worker", "pending", "--gate"], io)).toBe(0);
  });
  it("an unknown worker is exit 1 with one sentence and the next command", async () => {
    for (const argv of [["verify", "nope"], ["kill", "nope"], ["discard", "nope"], ["say", "nope", "hi"], ["log", "nope"]]) {
      errs.length = 0;
      expect(await runCli(GROUPS, ["worker", ...argv], io), argv.join(" ")).toBe(1);
      expect(errs.join("\n")).toMatch(/pai: .*nope/);
      expect(errs.join("\n")).toContain("Next: pai worker");
    }
  });
  it("errors rejects a bad --since with exit 1; handoff rejects non-JSON", async () => {
    expect(await runCli(GROUPS, ["worker", "errors", "--since", "bogus"], io)).toBe(1);
    expect(errs.join("")).toContain('bad --since "bogus"');
    errs.length = 0;
    expect(await runCli(GROUPS, ["worker", "handoff", "notjson"], io)).toBe(1);
    expect(errs.join("")).toContain("payload is not JSON: notjson");
  });
  it("wait-on a pid that never existed exits 2 (the code scripts rely on)", async () => {
    expect(await runCli(GROUPS, ["worker", "wait-on", "99999999"], io)).toBe(2);
  });
  it("status-line prints nothing when no worker is in scope", async () => {
    expect(await runCli(GROUPS, ["worker", "status-line", "T", "/nowhere", "S"], io)).toBe(0);
    expect(written.join("")).toBe("");
  });
  it("gc --dry-run ends with the count line and changes nothing", async () => {
    expect(await runCli(GROUPS, ["worker", "gc", "--dry-run"], io)).toBe(0);
    expect(written.join("")).toContain("0 would be archived");
    expect(await runCli(GROUPS, ["worker", "gc", "--older-than", "x"], io)).toBe(1);
  });
  it("help renders for run with its options", async () => {
    expect(await runCli(GROUPS, ["worker", "run", "--help"], io)).toBe(0);
    const text = written.join("");
    expect(text).toContain("--print-cmd");
    expect(text).toContain("Examples");
  });
});
