import { describe, expect, it } from "vitest";
import { answerFile, DEFAULT_LIMITS, Watchdog, writtenFiles, type WatchEvent } from "./watch.js";

const w = (file: string, run = "r1"): WatchEvent => ({ type: "write", run, file });
const feedAll = (wd: Watchdog, evs: WatchEvent[], t = 0) => evs.map((e) => wd.feed(e, t)).find((v) => v !== null) ?? null;

describe("Watchdog", () => {
  it("lets a normal run pass", () => {
    const wd = new Watchdog(DEFAULT_LIMITS, 0);
    expect(feedAll(wd, Array.from({ length: 40 }, (_, i) => w(`out/t${i}.py`)))).toBeNull();
  });

  it("stops on the 4th write of one file (REWRITE)", () => {
    const wd = new Watchdog(DEFAULT_LIMITS, 0);
    expect(feedAll(wd, [w("out/a.py"), w("out/a.py"), w("out/a.py")])).toBeNull();
    expect(wd.feed(w("out/a.py"), 0)).toEqual({ reason: "REWRITE", detail: "out/a.py x4 in r1" });
  });

  it("counts rewrites per run, not across runs", () => {
    const wd = new Watchdog(DEFAULT_LIMITS, 0);
    expect(feedAll(wd, [w("out/a.py", "r1"), w("out/a.py", "r2"), w("out/a.py", "r3"), w("out/a.py", "r4")])).toBeNull();
  });

  it("stops past 60 distinct files in one run (RUNAWAY), not at 60", () => {
    const wd = new Watchdog(DEFAULT_LIMITS, 0);
    expect(feedAll(wd, Array.from({ length: 60 }, (_, i) => w(`out/t${i}.py`)))).toBeNull();
    expect(wd.feed(w("out/t60.py"), 0)?.reason).toBe("RUNAWAY");
  });

  it("goes idle only after idleMs without any event, and activity resets the clock", () => {
    const wd = new Watchdog({ ...DEFAULT_LIMITS, idleMs: 90_000 }, 0);
    expect(wd.check(90_000)).toBeNull();
    expect(wd.check(91_000)?.reason).toBe("IDLE");
    wd.feed({ type: "activity" }, 100_000);
    expect(wd.check(180_000)).toBeNull();
    expect(wd.check(191_000)?.reason).toBe("IDLE");
  });

  it("reset restarts the idle clock between runs", () => {
    const wd = new Watchdog(DEFAULT_LIMITS, 0);
    wd.reset(500_000);
    expect(wd.check(560_000)).toBeNull();
  });
});

describe("transcript parsing", () => {
  const line = (name: string, file_path: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name, input: { file_path } }] } });

  it("extracts Write/Edit paths and ignores other lines", () => {
    expect(writtenFiles(line("Write", "/w/out/a.py"))).toEqual(["/w/out/a.py"]);
    expect(writtenFiles(line("Read", "/w/tasks.jsonl"))).toEqual([]);
    expect(writtenFiles("not json")).toEqual([]);
    expect(writtenFiles(JSON.stringify({ type: "user" }))).toEqual([]);
  });

  it("only out/<file> counts as an answer file", () => {
    expect(answerFile("/w/out/a.py", "/w")).toBe("out/a.py");
    expect(answerFile("out/a.txt", "/w")).toBe("out/a.txt");
    expect(answerFile("/w/src/a.ts", "/w")).toBeNull();
    expect(answerFile("/w/out/sub/a.py", "/w")).toBeNull();
  });
});
