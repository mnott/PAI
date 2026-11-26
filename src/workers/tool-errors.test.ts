import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { candidateSignature, CANDIDATE_MAX_EXAMPLES, migrateCandidates, normalizeCandidateText, writeCandidate } from "../hooks/ts/lib/antipattern-log.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { classifyToolError, commandHead, errorsTable, groupToolErrors, harnessEvidence, lastCommand, recordToolErrorCandidates, type ToolErrorRecord } from "./tool-errors.js";
import { checkLoops } from "./loop-watch.js";
import { detectEditMiss, editMissNote } from "./edit-miss.js";

const rec = (over: Partial<ToolErrorRecord>): ToolErrorRecord => ({
  ts: 0,
  worker: "w1",
  provider: "gyro-l",
  label: "test",
  tool: "Bash",
  signature: "s",
  raw: "",
  ...over,
});

describe("lastCommand", () => {
  it("strips quoted spans", () => {
    expect(lastCommand(`echo "a | b" && grep 'x;y' f`)).toMatchObject({ name: "grep", compound: true });
  });
  it("is linear on a 200 KB command with a heredoc and an unmatched quote", () => {
    const cmd = `python3 - <<'PY'\n${"print(\"it's\")\n".repeat(8000)}PY\necho "oops ${"x \\\" ' ".repeat(25000)}`;
    expect(cmd.length).toBeGreaterThan(200_000);
    const t = Date.now();
    lastCommand(cmd);
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe("groupToolErrors provider filter", () => {
  const mk = (provider: string, worker: string, ts: number): ToolErrorRecord =>
    rec({ provider, worker, ts, signature: "Bash|Exit code <N> tsc error", raw: "error TS2307" });
  it("keeps only records of the named provider and drops the rest", () => {
    const all = [mk("signal-2", "w1", 100), mk("anthropic", "w2", 200), mk("signal-2", "w3", 300)];
    const filtered = groupToolErrors(all, "signal-2");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].count).toBe(2);
    expect(filtered[0].providers).toEqual(["signal-2"]);
    expect(filtered[0].workers).toEqual(["w1", "w3"]);
    // unfiltered still sees both providers
    const un = groupToolErrors(all);
    expect(un[0].providers).toEqual(["signal-2", "anthropic"]);
    expect(un[0].count).toBe(3);
  });
  it("an unknown provider yields no groups and the table says so", () => {
    expect(groupToolErrors([mk("anthropic", "w1", 1)], "signal-2")).toEqual([]);
    expect(errorsTable(groupToolErrors([mk("anthropic", "w1", 1)], "signal-2"))).toBe("no tool errors recorded");
  });
  it("the table keeps the PROVIDERS column", () => {
    const t = errorsTable(groupToolErrors([mk("signal-2", "w1", 1)], "signal-2"));
    expect(t).toContain("PROVIDERS");
    expect(t).toContain("signal-2");
  });
});

describe("worker mistakes are never harness", () => {
  // 2026-11-19 01:18 worker 20261118-232451-28562: its own tsc error was labelled
  // "[harness] configuration file parsing error in worker script".
  it("a tsc error in the worker's own file is model", () => {
    const c = classifyToolError(
      rec({ raw: "src/workers/render.ts(597,39): error TS18047: 'l' is possibly 'null'.", input: "npx tsc --noEmit" })
    );
    expect(c.cls).toBe("model");
    expect(harnessEvidence("src/workers/render.ts(597,39): error TS18047: 'l' is possibly 'null'.")).toBe(false);
  });
  // 2026-11-19 02:17 worker 20261119-012354-92712: its own broken perl regex.
  it("a syntax error in the worker's own one-off command is model", () => {
    const c = classifyToolError(rec({ raw: "Unmatched ) in regex; marked by <-- HERE in m/( )/ at -e line 1.", input: "perl -pe 's/(foo)/'" }));
    expect(c.cls).toBe("model");
  });
  it("a python or node one-off that fails to parse is model", () => {
    expect(classifyToolError(rec({ raw: "SyntaxError: invalid syntax. Perhaps you forgot a comma?", input: "python3 -c 'print(1'" })).cls).toBe("model");
    expect(classifyToolError(rec({ raw: "SyntaxError: Unexpected token ')'", input: "node -e 'function f() {'" })).cls).toBe("model");
  });
  it("No such file for a path the worker invented is model", () => {
    expect(classifyToolError(rec({ raw: "python3: can't open file '/Users/x/probe.py': [Errno 2] No such file or directory", input: "python3 probe.py" })).cls).toBe("model");
    expect(classifyToolError(rec({ tool: "Bash", raw: "/bin/sh: ./scripts/x.sh: No such file or directory", input: "./scripts/x.sh" })).cls).toBe("model");
  });
  it("String to replace not found is model", () => {
    expect(classifyToolError(rec({ tool: "Edit", raw: "String to replace not found in file." })).cls).toBe("model");
  });
  // 2026-11-21/22 workers 20261121-130242-69295, 20261122-074919-22041: their own
  // scratch script imported a path that does not exist; node's ERR_MODULE_NOT_FOUND
  // was labelled [harness] and reached the L0.
  it("a scratch script's missing import is model", () => {
    const c = classifyToolError(rec({
      raw: "node:internal/modules/esm/resolve:270\nExit code 1 Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/x/.pai-scratch/w1/lib/helper.ts' imported from /Users/x/.pai-scratch/w1/probe.ts",
      input: "mkdir -p .pai-scratch && node .pai-scratch/probe.ts",
    }));
    expect(c.cls).toBe("model");
    expect(harnessEvidence(c.hint)).toBe(false);
  });
  it("a relative import the worker's own script names is model", () => {
    const c = classifyToolError(rec({
      raw: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/x/work/probe/missing.js' imported from /Users/x/work/probe/run.ts",
      input: "node probe/run.ts",
    }));
    expect(c.cls).toBe("model");
  });
  // A missing module inside PAI's own install stays harness: the worker never wrote that path.
  it("a missing module inside PAI's install is not a worker mistake", () => {
    const r = rec({ raw: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/x/dev/ai/PAI/dist/hooks/report.js' imported from /Users/x/dev/ai/PAI/src/cli/main.ts" });
    expect(classifyToolError(r).cls).toBe("unknown");
    const r2 = rec({ raw: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'pai' imported from /Users/x/work/probe/run.ts" });
    expect(classifyToolError(r2).cls).toBe("unknown");
  });
});

describe("API/auth classification", () => {
  it("api_error text inside Bash output is not an API/auth error", () => {
    const raw = 'Exit code 1\n["api_error_status","duration_api_ms","is_error"]\nhead: illegal line count -- 0';
    const c = classifyToolError(rec({ tool: "Bash", raw, input: "jq -c 'keys' worker.json | head -0" }));
    expect(c.hint).not.toBe("API/auth error");
    expect(c.cls).not.toBe("harness");
  });
  it("a real API error is still API/auth", () => {
    const c = classifyToolError(rec({ tool: "api", raw: "API Error: 401 authentication_error" }));
    expect(c).toMatchObject({ cls: "harness", hint: "API/auth error" });
  });
});

describe("harnessEvidence", () => {
  // A real harness sample: a PAI guard message carries the marker and may be called harness.
  it("matches a PAI guard deny", () => {
    expect(harnessEvidence("PAI guard: sleep-poll gate: foreground sleep blocked")).toBe(true);
  });
  it("matches pai CLI failures, the loop guard and stack frames in PAI's own code", () => {
    expect(harnessEvidence("pai: unexpected failure: invalid byte sequence for encoding \"UTF8\": 0x00")).toBe(true);
    expect(harnessEvidence("loop guard: same command repeated without a change")).toBe(true);
    expect(harnessEvidence("TypeError: x is not a function\n    at tick (/Users/x/dev/ai/PAI/src/daemon/supervise.ts:12:3)")).toBe(true);
  });
  it("does not match a worker's own error text", () => {
    expect(harnessEvidence("Unmatched ) in regex; marked by <-- HERE in m/( )/ at -e line 1.")).toBe(false);
    expect(harnessEvidence("src/workers/render.ts(597,39): error TS18047: 'l' is possibly 'null'.")).toBe(false);
  });
});

describe("repeated model tool errors become antipattern candidates", () => {
  // 2026-11-20: a worker ran GNU `sed -n "X,+Np"` three times, each exit 1 with
  // stderr "invalid command code ,"; the alerts were [unknown] and nothing was learned.
  let home: string;
  let prevHome: string | undefined;
  const now = Date.UTC(2026, 10, 20, 12);
  const sedRec = (worker: string, ts: number): ToolErrorRecord => ({
    ts,
    worker,
    provider: "gyro-l",
    label: "test",
    tool: "Bash",
    signature: "Bash|Exit code <N> sed: <P>: invalid command code ,",
    raw: "Exit code 1 sed: can't read f: invalid command code ,",
    input: `sed -n "42,+7p" file.txt`,
  });
  const candidateFiles = (): string[] => {
    try {
      return readdirSync(join(home, "antipatterns", "_candidates")).filter((f) => f.endsWith(".yaml"));
    } catch {
      return [];
    }
  };
  beforeEach(() => {
    prevHome = process.env.PAI_HOME;
    home = mkdtempSync(join(tmpdir(), "pai-cand-"));
    process.env.PAI_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("commandHead takes the first segment's name and first flag", () => {
    expect(commandHead(`sed -n "12,+5p" f`)).toBe("sed -n");
    expect(commandHead(`/usr/bin/sed -n '3p' f && echo x`)).toBe("sed -n");
    expect(commandHead(`FOO=1 grep -r x .`)).toBe("grep -r");
    expect(commandHead(undefined)).toBe("");
  });

  it("three identical sed errors write one candidate", () => {
    const written = recordToolErrorCandidates([sedRec("w1", now), sedRec("w1", now + 1000), sedRec("w1", now + 2000)], now + 3000);
    expect(written.length).toBe(1);
    expect(candidateFiles().length).toBe(1);
    const doc = parse(readFileSync(join(home, "antipatterns", "_candidates", candidateFiles()[0]), "utf8")) as Record<string, any>;
    expect(doc.category).toBe("tool-loop");
    // trigger = the command pattern; evidence names the workers and the stderr; no invented fix
    expect(String(doc.tests.match[0])).toContain("sed -n");
    expect(String(doc.message)).toContain("w1");
    expect(String(doc.message)).toContain("invalid command code");
    // the suggested fix is not invented: provenance carries the empty-fix marker for review
    expect(String(doc.provenance.observed)).toContain("repeated model tool error");
    expect(String(doc.provenance.observed)).toContain("suggested fix left empty for review");
  });

  it("two identical errors write none", () => {
    recordToolErrorCandidates([sedRec("w1", now), sedRec("w1", now + 1000)], now + 2000);
    expect(candidateFiles().length).toBe(0);
  });

  it("a fourth occurrence does not duplicate the candidate", () => {
    const recs = [sedRec("w1", now), sedRec("w1", now + 1000), sedRec("w1", now + 2000)];
    recordToolErrorCandidates(recs, now + 3000);
    recs.push(sedRec("w1", now + 4000));
    recordToolErrorCandidates(recs, now + 5000);
    expect(candidateFiles().length).toBe(1);
  });

  it("the same error in another worker dedupes to the one candidate", () => {
    recordToolErrorCandidates([sedRec("w1", now), sedRec("w1", now + 1000), sedRec("w2", now + 2000)], now + 3000);
    expect(candidateFiles().length).toBe(1);
  });

  it("an error older than the window does not qualify", () => {
    const old = now - 8 * 86_400_000;
    recordToolErrorCandidates([sedRec("w1", old), sedRec("w1", old + 1000), sedRec("w1", old + 2000)], now);
    expect(candidateFiles().length).toBe(0);
  });

  it("benign exits never become candidates", () => {
    const rec = (ts: number): ToolErrorRecord => ({ ...sedRec("w1", ts), signature: "Bash|Exit code <N>", raw: "Exit code 1", input: "grep -r zzz file.txt" });
    recordToolErrorCandidates([rec(now), rec(now + 1000), rec(now + 2000)], now + 3000);
    expect(candidateFiles().length).toBe(0);
  });
});

describe("failed Edit note", () => {
  const fileLines = Array.from({ length: 200 }, (_, i) => `    const line${i} = ${i};`);
  fileLines[100] = "    expect(parse(out)).toEqual({ a: 1, b: 2 });";
  const content = fileLines.join("\n");
  // the model's anchor: indentation changed, one line changed
  const oldString = "  expect(parse(out)).toEqual({ a: 1, b: 3 });\n  const line101 = 101;";
  const transcript = (n: number) => {
    const ev: unknown[] = [];
    for (let i = 0; i < n; i++) {
      ev.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: "/w/a.test.ts", old_string: oldString + " ".repeat(i), new_string: "z" } }] } });
      ev.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true, content: "String to replace not found in file." }] } });
    }
    return ev;
  };
  it("first failure carries the real lines around the fuzzy match", () => {
    const note = editMissNote(detectEditMiss(transcript(1))!, content);
    expect(note).toContain("copy your anchor from these lines");
    expect(note).toContain("  101|     expect(parse(out)).toEqual({ a: 1, b: 2 });");
    expect(note).toContain("const line101 = 101;");
    expect(note).not.toContain("const line10 = 10;");
  });
  it("whole file when under 120 lines", () => {
    expect(editMissNote(detectEditMiss(transcript(1))!, "a\nb\nc")).toContain("    3| c");
  });
  it("third failure says Write or a line-number edit", () => {
    const note = editMissNote(detectEditMiss(transcript(3))!, content);
    expect(note).toMatch(/with Write/);
    expect(note).toMatch(/python\/sed/);
  });
  it("checkLoops says on the 1st and 3rd failure and counts per model", async () => {
    const said: string[] = [];
    const status: any = { id: "w1", state: "running", provider: "gyro-l", model: "m1", cwd: "/w", pid: 1 };
    const sent: Record<string, string> = {};
    const logDir = mkdtempSync(join(tmpdir(), "em-"));
    for (const n of [1, 1, 2, 3]) {
      await checkLoops(logDir, [status], sent, { say: async (_l: string, _i: string, t: string) => void said.push(t), readFile: () => content, readEvents: () => transcript(n) } as any);
    }
    expect(said.filter((t) => t.includes("copy your anchor"))).toHaveLength(1);
    expect(said.filter((t) => /with Write/.test(t))).toHaveLength(1);
    const rows = readFileSync(join(logDir, "edit-misses.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.model)).toEqual(["m1", "m1"]);
  });
});

describe("antipattern candidates are keyed by signature", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.PAI_HOME;
    home = mkdtempSync(join(tmpdir(), "pai-sig-"));
    process.env.PAI_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });
  const dir = (): string => join(home, "antipatterns", "_candidates");
  const files = (d = dir()): string[] => {
    try {
      return readdirSync(d).filter((f) => f.endsWith(".yaml"));
    } catch {
      return [];
    }
  };
  const guard = (cmd: string, msg = "loop guard: this command has been polled for over 45 minutes (wait cap per command)."): Parameters<typeof writeCandidate>[0] => ({ category: "tool-loop", action: "deny", message: msg, input: cmd });

  it("normalizes paths, numbers, ids and quoted strings", () => {
    expect(normalizeCandidateText(`read '/a/b/c.ts' in 20261119-000643-79358 line 42 at ~/x/y`)).toBe("read <S> in <ID> line <N> at <P>");
  });

  it("the same loop on two days is one signature, a different command another", () => {
    const a = candidateSignature("tool-loop", "--wait -5 mac sh tail tools/build.sh", "loop guard: this command has been polled for over 45 minutes");
    const b = candidateSignature("tool-loop", "--wait -9 EXIT=$? 12 echo mac sh tail tools/build.sh", "loop guard: this command has been polled for over 90 minutes");
    const c = candidateSignature("tool-loop", "--wait -5 docker psql", "loop guard: this command has been polled for over 45 minutes");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // a tool error keys on its error text, not on the command head or the file
    const e = (head: string, file: string): string => candidateSignature("tool-loop", `${head}\nEdit|<tool_use_error>File does not exist. Note: your current working directory is /x/${file}`);
    expect(e("a.ts", "p1")).toBe(e("b.ts", "p2"));
    expect(candidateSignature("tool-loop", "sh\nBash|Exit code <N>")).not.toBe(candidateSignature("tool-loop", "cd\nBash|Exit code <N>"));
  });

  it("a repeat raises the counter and appends worker and date instead of a new file", () => {
    for (let i = 1; i <= 8; i++) writeCandidate({ ...guard(`--wait -${i} mac tools/build.sh`), env: { PAI_WORKER_ID: `w${i}` } as NodeJS.ProcessEnv });
    expect(files().length).toBe(1);
    const doc = parse(readFileSync(join(dir(), files()[0]), "utf8")) as Record<string, any>;
    expect(doc.count).toBe(8);
    expect(doc.workers).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"]);
    expect(doc.examples.length).toBe(CANDIDATE_MAX_EXAMPLES);
    expect(doc.examples[0].worker).toBe("w1");
    // the same worker again does not count twice
    writeCandidate({ ...guard("--wait -1 mac tools/build.sh"), env: { PAI_WORKER_ID: "w1" } as NodeJS.ProcessEnv });
    expect((parse(readFileSync(join(dir(), files()[0]), "utf8")) as Record<string, any>).count).toBe(8);
  });

  it("migration collapses literal candidates into signature candidates", () => {
    const d = join(home, "legacy");
    mkdirSync(d, { recursive: true });
    const lit = (name: string, created: string, match: string, message: string, observed: string, model = "session"): void => {
      writeFileSync(join(d, name), stringify({ id: `cand-${name.slice(-13, -5)}`, status: "experimental", mode: "monitor", version: 1, created, category: "tool-loop", detector: { kind: "observed", params: {} }, action: "deny", message, tests: { match: [match], no_match: [] }, provenance: { date: created, model, observed } }));
    };
    const poll = "loop guard: this command has been polled for over 45 minutes";
    lit("2026-11-01-aaaaaaaa.yaml", "2026-11-01", "--wait -5 mac tail tools/build.sh", poll, "deny by a guard no pattern covers", "sonnet");
    lit("2026-11-09-bbbbbbbb.yaml", "2026-11-09", "--wait -9 date mac tail tools/build.sh", poll, "deny by a guard no pattern covers", "qwen");
    lit("2026-11-10-cccccccc.yaml", "2026-11-10", "docker psql", poll, "deny by a guard no pattern covers");
    lit("2026-11-20-dddddddd.yaml", "2026-11-20", "a.ts\nEdit|<tool_use_error>No changes to make", "w1, w2: x", "a.ts failed 3x in 7d across workers w1, w2 — repeated model tool error");
    lit("2026-11-21-eeeeeeee.yaml", "2026-11-21", "b.ts\nEdit|<tool_use_error>No changes to make", "w3: x", "b.ts failed 3x in 7d across workers w2, w3 — repeated model tool error");
    const dry = migrateCandidates(d, true);
    expect(dry).toMatchObject({ before: 5, after: 3, removed: [] });
    expect(files(d).length).toBe(5);
    const r = migrateCandidates(d);
    expect(r).toMatchObject({ before: 5, after: 3 });
    expect(files(d).length).toBe(3);
    const docs = files(d).map((f) => parse(readFileSync(join(d, f), "utf8")) as Record<string, any>);
    const build = docs.find((x) => String(x.signature).includes("build.sh"))!;
    expect(build.count).toBe(2);
    expect(build.created).toBe("2026-11-01");
    expect(build.examples.map((e: any) => e.model)).toEqual(["sonnet", "qwen"]);
    const edit = docs.find((x) => String(x.signature).includes("Edit|"))!;
    expect(edit.workers).toEqual(["w1", "w2", "w3"]);
    expect(edit.count).toBe(3);
    // idempotent
    expect(migrateCandidates(d)).toMatchObject({ before: 3, after: 3, removed: [] });
  });
});

describe("router notices and no-op edits", () => {
  it("router| signatures are never candidates", () => {
    const now = Date.now();
    const r = (ts: number): ToolErrorRecord => ({ ts, worker: "w1", provider: "p", label: "t", tool: "bash", signature: "router|tool name case corrected", raw: "tool name case corrected" });
    expect(recordToolErrorCandidates([r(now), r(now + 1), r(now + 2)], now + 3)).toEqual([]);
  });
  it("Edit with old_string equal to new_string gets the no-op note", () => {
    const ev = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "n1", name: "Edit", input: { file_path: "/w/a.ts", old_string: "x", new_string: "x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "n1", is_error: true, content: "No changes to make: old_string and new_string are exactly the same" }] } },
    ];
    expect(editMissNote(detectEditMiss(ev)!, "x")).toContain("changed nothing");
  });
});

describe("wait / wait-on rc=3 is benign", () => {
  const base: ToolErrorRecord = { ts: 1, worker: "w", provider: "anthropic", label: "l", tool: "Bash", signature: "Bash|Exit code <N>", raw: "", input: "" };
  const waitCmd = "pai worker wait-on $(cat $TMPDIR/s.pid) --log $TMPDIR/s.log --max 100";
  it("exit 3 of wait / wait-on is benign", () => {
    expect(classifyToolError({ ...base, raw: "Exit code 3", input: waitCmd }).cls).toBe("benign");
    expect(classifyToolError({ ...base, raw: "Exit code 3", input: "pai worker wait abc --max 100" }).cls).toBe("benign");
  });
  it("a wrapper's exit 1 carrying rc=3, and the tool timeout over a still-running poll, are benign", () => {
    expect(classifyToolError({ ...base, raw: "Exit code 1\nrc=3", input: waitCmd }).cls).toBe("benign");
    expect(classifyToolError({ ...base, raw: "Timeout exceeded\nstill running after 100s (pid 1); call wait-on again", input: waitCmd }).cls).toBe("benign");
  });
  it("rc=3 from other commands is unchanged", () => {
    expect(classifyToolError({ ...base, raw: "Exit code 3", input: "node build.js" }).cls).not.toBe("benign");
    expect(classifyToolError({ ...base, raw: "Exit code 1\nrc=3", input: "node build.js" }).cls).not.toBe("benign");
  });
});
