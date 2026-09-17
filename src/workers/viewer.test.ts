/**
 * Tests for the follow exit decision, the shared per-event renderer, the
 * attach backfill and the operator stdin channel. Pure functions and fake
 * deps; no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeColor } from "./render.js";
import {
  applyEvent,
  backfillLines,
  followWorkers,
  initialFollowState,
  makeOperatorInput,
  workerEnded,
  type FollowIO,
  type OperatorInputDeps,
} from "./viewer.js";

const plain = makeColor(false);
const color = makeColor(true);

describe("workerEnded", () => {
  it("ends once the result event was rendered, whatever the status says", () => {
    expect(workerEnded(true, "running", true)).toBe(true);
    expect(workerEnded(true, undefined, true)).toBe(true);
    expect(workerEnded(true, "done", false)).toBe(true);
  });

  it("ends when the status left running and the pid is gone (killed without a result)", () => {
    expect(workerEnded(false, "done", false)).toBe(true);
    expect(workerEnded(false, "failed", false)).toBe(true);
    expect(workerEnded(false, "killed", false)).toBe(true);
    expect(workerEnded(false, "lost", false)).toBe(true);
  });

  it("keeps following while the worker runs, or its pid lives on", () => {
    expect(workerEnded(false, "running", true)).toBe(false);
    expect(workerEnded(false, "done", true)).toBe(false); // zombie status, live pid
  });

  it("keeps following when no status was ever read", () => {
    expect(workerEnded(false, undefined, false)).toBe(false);
    expect(workerEnded(false, undefined, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyEvent — spacing, ticker state, day separators
// ---------------------------------------------------------------------------

const OFF = 0; // Z stamps read at UTC: deterministic everywhere
const ts = (h: number, m = 0, s = 0) =>
  `2026-09-17T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;

const text = (t: string, at = ts(12)) => ({
  type: "assistant",
  _ts: at,
  message: { content: [{ type: "text", text: t }] },
});
const toolUse = (name: string, input: unknown, at = ts(12)) => ({
  type: "assistant",
  _ts: at,
  message: { content: [{ type: "tool_use", id: "t1", name, input }] },
});
const toolResult = (t: string, at = ts(12)) => ({
  type: "user",
  _ts: at,
  message: { content: [{ type: "tool_result", tool_use_id: "t1", content: t }] },
});

describe("applyEvent spacing", () => {
  it("renders one turn back to back: no blank between text, call and result", () => {
    let st = initialFollowState("");
    const a = applyEvent(plain, st, text("I will check the file", ts(12, 0, 1)), "", undefined, OFF);
    const b = applyEvent(plain, a.state, toolUse("Read", { file_path: "/repo/x.ts" }, ts(12, 0, 2)), "", undefined, OFF);
    const r = applyEvent(plain, b.state, toolResult("line 1\nline 2", ts(12, 0, 3)), "", undefined, OFF);
    const all = [...a.lines, ...b.lines, ...r.lines];
    expect(all.filter((l) => l === "")).toEqual([]);
    st = r.state;
    expect(st.lastDay).toBe("2026-09-17");
  });

  it("puts exactly one blank line before the next assistant turn", () => {
    const st = applyEvent(plain, initialFollowState(""), toolResult("done"), "", undefined, OFF).state;
    const next = applyEvent(plain, st, text("all good", ts(12, 1)), "", undefined, OFF);
    expect(next.lines[0]).toBe("");
    expect(next.lines[1]).toContain("all good");
    expect(next.lines.filter((l) => l === "")).toHaveLength(1);
  });

  it("one blank before the assistant reply that follows an operator message", () => {
    const op = { type: "operator", _ts: ts(12, 2), text: "run the tests" };
    const st = applyEvent(plain, initialFollowState(""), op, "", undefined, OFF).state;
    const reply = applyEvent(plain, st, text("running them", ts(12, 2, 5)), "", undefined, OFF);
    expect(reply.lines[0]).toBe("");
  });
});

describe("applyEvent ticker state", () => {
  it("activity is true only for events that rendered visible lines", () => {
    // a tool_result with empty content renders nothing — the ticker must keep
    // counting instead of resetting to 0s
    const silent = applyEvent(
      plain,
      initialFollowState(""),
      { type: "user", _ts: ts(12, 3), message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "" }] } },
      "",
      undefined,
      OFF
    );
    expect(silent.lines).toEqual([]);
    expect(silent.activity).toBe(false);

    const loud = applyEvent(plain, silent.state, text("now I answer", ts(12, 4)), "", undefined, OFF);
    expect(loud.activity).toBe(true);
  });

  it("carries the last intent and the running tool for the ticker", () => {
    let st = applyEvent(plain, initialFollowState(""), text("run tests\nbefore the fix", ts(12, 5)), "", undefined, OFF).state;
    expect(st.intent).toBe("run tests");
    st = applyEvent(plain, st, toolUse("Bash", { command: "bun run test" }, ts(12, 6)), "", undefined, OFF).state;
    expect(st.tool).toBe("$ bun run test");
    expect(st.intent).toBe("run tests");
  });

  it("a day change emits a separator once, not again on the same day", () => {
    let st = initialFollowState("");
    const a = applyEvent(plain, st, text("morning", ts(1)), "", undefined, OFF);
    expect(a.day).toBe("2026-09-17");
    const b = applyEvent(plain, a.state, text("later", ts(23, 59)), "", undefined, OFF);
    expect(b.day).toBeNull();
    const nextDay = { type: "assistant", _ts: "2026-09-18T00:01:00Z", message: { content: [{ type: "text", text: "next day" }] } };
    const d = applyEvent(plain, b.state, nextDay, "", undefined, OFF);
    expect(d.day).toBe("2026-09-18");
  });
});

describe("backfillLines", () => {
  it("keeps the last cap non-empty lines, oldest first", () => {
    const raw = Array.from({ length: 305 }, (_, i) => `{"n":${i}}`).join("\n") + "\n\n";
    const lines = backfillLines(raw, 200);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('{"n":105}');
    expect(lines[199]).toBe('{"n":304}');
  });

  it("keeps everything below the cap, drops blank lines", () => {
    expect(backfillLines('{"a":1}\n\n{"b":2}\n', 200)).toEqual(['{"a":1}', '{"b":2}']);
    expect(backfillLines("", 200)).toEqual([]);
  });
});

describe("makeOperatorInput", () => {
  /** Deps that record calls instead of acting. */
  const fakeDeps = (over: Partial<OperatorInputDeps> = {}): OperatorInputDeps & {
    said: [string, string][];
    notes: string[];
    resumed: [string, string][];
    known: string[];
  } => {
    const rec = {
      said: [] as [string, string][],
      notes: [] as string[],
      resumed: [] as [string, string][],
      known: [] as string[],
    };
    return {
      target: () => "w1",
      say: async (id, text) => {
        rec.said.push([id, text]);
        return "ok";
      },
      workerKnown: (id) => rec.known.includes(id),
      resume: (text, id) => {
        rec.resumed.push([text, id]);
      },
      note: (s) => {
        rec.notes.push(s);
      },
      paint: plain,
      ...over,
      ...rec,
    };
  };

  it("a typed line is said to the target and confirmed with a dim note", async () => {
    const d = fakeDeps();
    makeOperatorInput(d)("  run the tests  \n");
    await Promise.resolve(); // let the say promise settle
    await Promise.resolve();
    expect(d.said).toEqual([["w1", "run the tests"]]);
    expect(d.notes).toEqual([plain("dim", "» sent to w1")]);
  });

  it("a failed say to a known worker resumes it with the same text", async () => {
    const d = fakeDeps({
      say: async () => {
        throw new Error("worker not running");
      },
    });
    d.known.push("w1");
    makeOperatorInput(d)("continue: fix the bug");
    await Promise.resolve();
    await Promise.resolve();
    expect(d.resumed).toEqual([["continue: fix the bug", "w1"]]);
  });

  it("a failed say to an unknown worker is a red note, not a resume", async () => {
    const d = fakeDeps({
      say: async () => {
        throw new Error("no such worker");
      },
    });
    makeOperatorInput(d)("hello");
    await Promise.resolve();
    await Promise.resolve();
    expect(d.resumed).toEqual([]);
    expect(d.notes).toEqual([plain("red", "» no such worker")]);
  });

  it("ignores empty lines and a missing target", async () => {
    const d = fakeDeps();
    makeOperatorInput(d)("   ");
    const none = fakeDeps({ target: () => null });
    makeOperatorInput(none)("hello");
    await Promise.resolve();
    expect(d.said).toEqual([]);
    expect(none.said).toEqual([]);
  });

  it("wires up under a readline interface over a fake stdin (the pane's glue)", async () => {
    const d = fakeDeps();
    const input = new PassThrough();
    const rl = createInterface({ input });
    rl.on("line", makeOperatorInput(d));
    input.write("hello worker\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(d.said).toEqual([["w1", "hello worker"]]);
    rl.close();
  });
});

// ---------------------------------------------------------------------------
// applyEvent wrapping — the pane wraps rows itself, the bar never breaks
// ---------------------------------------------------------------------------

describe("applyEvent wrapping", () => {
  it("folds a 120-character row at 40 columns into 29-wide rows behind the gutter", () => {
    const step = applyEvent(
      plain,
      initialFollowState(""),
      { type: "operator", _ts: ts(12, 7), text: "y".repeat(120) },
      "",
      undefined,
      OFF,
      40
    );
    expect(step.lines).toHaveLength(5);
    expect(step.lines[0]).toBe("12:07:00 │ » " + "y".repeat(27));
    expect(step.lines[1]).toBe(" ".repeat(8) + " │ " + "y".repeat(29));
    expect(step.lines[2]).toBe(" ".repeat(8) + " │ " + "y".repeat(29));
    expect(step.lines[4]).toBe(" ".repeat(8) + " │ " + "y".repeat(6));
    // no content character ever lands left of the bar
    for (const ln of step.lines.slice(1)) expect(ln.startsWith(" ".repeat(8) + " │ ")).toBe(true);
  });

  it("a null wrapWidth keeps the pre-chat rendering: plain blanks, no bar", () => {
    const step = applyEvent(
      plain,
      initialFollowState(""),
      { type: "operator", _ts: ts(12, 8), text: "one\ntwo" },
      "",
      undefined,
      OFF
    );
    expect(step.lines).toEqual(["12:08:00 │ » one", " ".repeat(11) + "» two"]);
  });

  it("a wrapped diff row keeps its colour on every continuation row", () => {
    const ev = toolUse("Edit", { file_path: "/repo/x.ts", old_string: "a", new_string: "x".repeat(80) }, ts(12, 9));
    const step = applyEvent(color, initialFollowState(""), ev, "", undefined, OFF, 40);
    const plus = step.lines.filter((l) => l.includes("xxx") || l.includes("+"));
    expect(plus.length).toBeGreaterThanOrEqual(2);
    for (const ln of plus.slice(1)) {
      // blank time + the bar, dim, then the reopened green of the + chunk
      expect(ln.startsWith(`\x1b[2m${" ".repeat(8)} │ \x1b[0m\x1b[32m`)).toBe(true);
      expect(ln).toContain("\x1b[0m");
    }
  });
});

// ---------------------------------------------------------------------------
// the chat pane over injected pipes (FORCE_TTY emits the TTY layout)
// ---------------------------------------------------------------------------

/** A finished worker in a temp logDir: status file + init/result events. */
const chatFixture = (): { dir: string; id: string } => {
  const dir = mkdtempSync(join(tmpdir(), "pai-chat-"));
  const id = "20260917-150000-4242";
  writeFileSync(
    join(dir, `${id}.status`),
    JSON.stringify({
      id,
      pid: -1,
      label: "chat test",
      cwd: dir,
      term: "",
      provider: "prov",
      model: "m",
      state: "done",
      started: "2026-09-17 15:00:00",
      updated: "2026-09-17 15:00:02",
      turns: 1,
      tools: 0,
      last: "done",
      rc: 0,
      secs: 2,
    })
  );
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: "system", subtype: "init", model: "m", cwd: dir, _ts: "2026-09-17T15:00:00Z" }),
      JSON.stringify({ type: "result", result: "fine", is_error: false, num_turns: 1, duration_ms: 2000, _ts: "2026-09-17T15:00:02Z" }),
    ].join("\n") + "\n"
  );
  return { dir, id };
};

describe("followWorkers chat pane (FORCE_TTY over pipes)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("draws the layout, echoes a submitted line and resumes the finished worker", async () => {
    const { dir, id } = chatFixture();
    const input = new PassThrough();
    let buf = "";
    const stdout = {
      write: (s: string) => {
        buf += s;
        return true;
      },
      rows: 24,
      columns: 80,
    };
    const resumes: [string, string][] = [];
    const io: FollowIO = {
      stdin: input,
      stdout,
      spawnResume: (rid, text) => {
        resumes.push([rid, text]);
        return { on: () => undefined };
      },
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(200); // attach + backfill
    input.write("hello\n");
    await sleep(200); // say rejects (done) → resume
    expect(buf).toContain("\x1b[1;22r"); // the scroll region (rows 24)
    expect(buf).toContain("\x1b[2J"); // pane cleared on enter
    expect(buf).toContain("› "); // the prompt marker
    expect(buf).toMatch(/\d\d:\d\d:\d\d │ » hello/); // echoed with its gutter
    expect(buf).toContain(`» resuming ${id}`);
    expect(resumes).toEqual([[id, "hello"]]); // the resume spawn, mocked
    input.write("/quit\n");
    await done;
    expect(buf).toContain("\x1b[r"); // the region reset on leave
  });

  it("a draft in the prompt holds the auto-exit countdown", async () => {
    const { dir, id } = chatFixture();
    const input = new PassThrough();
    let buf = "";
    const io: FollowIO = {
      stdin: input,
      stdout: {
        write: (s: string) => {
          buf += s;
          return true;
        },
        rows: 24,
        columns: 80,
      },
      spawnResume: () => ({ on: () => undefined }),
      promptLine: () => "unsent draft",
    };
    const done = followWorkers(dir, id, false, 1, { FORCE_TTY: "1" }, false, io);
    await sleep(1700); // past the 1 s countdown
    expect(buf).not.toContain("closing");
    input.write("/quit\n");
    await done;
  }, 8000);

  it("an empty prompt lets the countdown close the pane", async () => {
    const { dir, id } = chatFixture();
    let buf = "";
    const input = new PassThrough();
    const done = followWorkers(dir, id, false, 1, { FORCE_TTY: "1" }, false, {
      stdin: input,
      stdout: {
        write: (s: string) => {
          buf += s;
          return true;
        },
        rows: 24,
        columns: 80,
      },
      spawnResume: () => ({ on: () => undefined }),
    });
    await done; // resolves only by the countdown: nothing was typed
    expect(buf).toContain("closing");
  }, 8000);
});
