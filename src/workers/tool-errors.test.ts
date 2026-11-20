import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { classifyToolError, commandHead, harnessEvidence, lastCommand, recordToolErrorCandidates, type ToolErrorRecord } from "./tool-errors.js";

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
