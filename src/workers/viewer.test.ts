/**
 * Tests for the follow exit decision, the shared per-event renderer, the
 * attach backfill and the operator stdin channel. Pure functions and fake
 * deps; no claude, no osascript.
 */

import { describe, it, expect } from "vitest";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeColor } from "./render.js";
import { CHAT_HINT } from "./chatui.js";
import { ledgerPath } from "./paths.js";
import {
  applyEvent,
  backfillLines,
  followWorkers,
  initialFollowState,
  makeOperatorInput,
  psOutput,
  statusLineOutput,
  strayWorkerProcesses,
  workerEnded,
  type FollowIO,
  type OperatorInputDeps,
} from "./viewer.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const plain = makeColor(false);
const color = makeColor(true);

describe("workerEnded", () => {
  it("a rendered result event does not end a worker whose status is still running (pool slot died mid-task, run restarted)", () => {
    expect(workerEnded(true, "running")).toBe(false);
    expect(workerEnded(true, "queued")).toBe(false);
    expect(workerEnded(true, undefined)).toBe(true);
    expect(workerEnded(true, "done")).toBe(true);
  });

  it("ends once the status is terminal (killed without a result)", () => {
    expect(workerEnded(false, "done")).toBe(true);
    expect(workerEnded(false, "failed")).toBe(true);
    expect(workerEnded(false, "killed")).toBe(true);
    expect(workerEnded(false, "lost")).toBe(true);
  });

  it("keeps following while the worker runs", () => {
    expect(workerEnded(false, "running")).toBe(false);
    expect(workerEnded(false, "queued")).toBe(false);
    expect(workerEnded(false, "timeout" as never)).toBe(true);
  });

  it("keeps following when no status was ever read", () => {
    expect(workerEnded(false, undefined)).toBe(false);
    expect(workerEnded(false, undefined)).toBe(false);
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

  it("puts exactly one turn separator before the next assistant turn: the bar-only gutter, not \"\"", () => {
    const st = applyEvent(plain, initialFollowState(""), toolResult("done"), "", undefined, OFF).state;
    const next = applyEvent(plain, st, text("all good", ts(12, 1)), "", undefined, OFF);
    expect(next.lines[0]).toBe(" ".repeat(8) + " │ "); // the bar-only prefix
    expect(next.lines[1]).toContain("all good");
    expect(next.lines.filter((l) => l === " ".repeat(8) + " │ ")).toHaveLength(1);
  });

  it("gutterless (no stamp): the turn separator stays \"\"", () => {
    const st = applyEvent(plain, initialFollowState(""), { ...toolResult("done"), _ts: undefined }, "", undefined, OFF).state;
    const next = applyEvent(plain, st, { ...text("all good"), _ts: undefined }, "", undefined, OFF);
    expect(next.lines).toEqual(["", "all good"]);
  });

  it("one bar separator before the assistant reply that follows an operator message", () => {
    const op = { type: "operator", _ts: ts(12, 2), text: "run the tests" };
    const st = applyEvent(plain, initialFollowState(""), op, "", undefined, OFF).state;
    const reply = applyEvent(plain, st, text("running them", ts(12, 2, 5)), "", undefined, OFF);
    expect(reply.lines[0]).toBe(" ".repeat(8) + " │ ");
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
  const bash = (command: string) => ({
    type: "assistant",
    _ts: ts(12, 9),
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });

  it("a heredoc command keeps its lines and caps at 6 with a count", () => {
    const cmd = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const step = applyEvent(plain, initialFollowState(""), bash(cmd), "", undefined, OFF, 80);
    expect(step.lines).toHaveLength(7);
    expect(step.lines[0]).toBe("12:09:00 │ $ line0");
    expect(step.lines[1]).toBe(" ".repeat(8) + " │   line1");
    expect(step.lines[6]).toBe(" ".repeat(8) + " │   … +4 lines");
  });

  it("a long single line wraps at the width, no mid-word cut, bar kept", () => {
    const cmd = "alpha ".repeat(30).trim();
    const step = applyEvent(plain, initialFollowState(""), bash(cmd), "", undefined, OFF, 50);
    expect(step.lines.length).toBeGreaterThan(2);
    for (const ln of step.lines) expect(ln.length).toBeLessThanOrEqual(50);
    expect(step.lines.slice(1).every((l) => l.startsWith(" ".repeat(8) + " │ "))).toBe(true);
    expect(step.lines.join(" ")).not.toContain("…");
  });

  it("a width change is respected on the next event", () => {
    const cmd = "alpha ".repeat(30).trim();
    const wide = applyEvent(plain, initialFollowState(""), bash(cmd), "", undefined, OFF, 120);
    const narrow = applyEvent(plain, initialFollowState(""), bash(cmd), "", undefined, OFF, 40);
    expect(narrow.lines.length).toBeGreaterThan(wide.lines.length);
  });

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

/** A worker in a temp logDir: status file + init event (+ result when done). */
const chatFixture = (state: "running" | "done" = "done"): { dir: string; id: string } => {
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
      state,
      started: "2026-09-17 15:00:00",
      updated: "2026-09-17 15:00:02",
      turns: 1,
      tools: 0,
      last: state === "done" ? "done" : "starting",
      rc: state === "done" ? 0 : null,
      secs: state === "done" ? 2 : null,
    })
  );
  const events = [
    JSON.stringify({ type: "system", subtype: "init", model: "m", cwd: dir, _ts: "2026-09-17T15:00:00Z" }),
  ];
  if (state === "done") {
    events.push(
      JSON.stringify({ type: "result", result: "fine", is_error: false, num_turns: 1, duration_ms: 2000, _ts: "2026-09-17T15:00:02Z" })
    );
  }
  writeFileSync(join(dir, `${id}.jsonl`), events.join("\n") + "\n");
  return { dir, id };
};

/** The prompt-row redraw with the placeholder back (color off in tests). */
const PLACEHOLDER = `\x1b[23;1H\x1b[K› ${CHAT_HINT}\x1b[23;3H`;

describe("followWorkers chat pane (FORCE_TTY over pipes)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("sets the iTerm paiWorkerPane user variable on a real TTY only", async () => {
    const { dir, id } = chatFixture();
    const run = async (isTTY: boolean) => {
      const input = new PassThrough();
      let buf = "";
      const stdout = { write: (s: string) => ((buf += s), true), rows: 24, columns: 80, isTTY };
      const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, { stdin: input, stdout });
      await sleep(200);
      input.write("/quit\n");
      await done;
      return buf;
    };
    const seq = `\x1b]1337;SetUserVar=paiWorkerPane=${Buffer.from(id).toString("base64")}\x07`;
    expect(await run(true)).toContain(seq);
    expect(await run(false)).not.toContain("SetUserVar");
  });

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
    expect(buf).toContain("\x1b[1;21r"); // the scroll region (rows 24, 3 fixed rows)
    expect(buf).toContain("\x1b[2J"); // pane cleared on enter
    expect(buf).toContain("\x1b[22;1H\x1b[K" + "─".repeat(80)); // the separator rule above the prompt
    expect(buf).toContain("› "); // the prompt marker
    expect(buf).toContain(PLACEHOLDER); // the placeholder behind the empty prompt
    expect(buf).toMatch(/\d\d:\d\d:\d\d │ » hello/); // echoed with its gutter
    expect(buf).toContain(`» resuming ${id}`);
    expect(resumes).toEqual([[id, "hello"]]); // the resume spawn, mocked
    input.write("/quit\n");
    await done;
    expect(buf).toContain("\x1b[r"); // the region reset on leave
  });

  it("'your controls' spawns the same clickr argv as `pai worker controls` and echoes the result, without saying it to the worker", async () => {
    const { dir, id } = chatFixture("running");
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
      spawnResume: () => {
        throw new Error("resume must not run for a controls line");
      },
    };
    const controlsCalls: [string, "you" | "me", number | undefined][] = [];
    io.spawnControls = (cid, who, pid) => {
      controlsCalls.push([cid, who, pid]);
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit("close", 0));
      return child as unknown as { on: typeof child.on; stderr: EventEmitter };
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(200); // attach + backfill
    input.write("your controls\n");
    await sleep(200);
    expect(controlsCalls).toEqual([[id, "you", -1]]); // pid from the fixture's status
    expect(buf).toContain(`» controls → ${id} (exclusive; needs clickr with --agent support)`);
    expect(buf).not.toMatch(/» your controls/); // never echoed/sent as an operator chat line
    input.write("/quit\n");
    await done;
  });

  it("a submitted line clears the prompt row (placeholder back) before the » echo", async () => {
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
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(200);
    const before = buf.split(PLACEHOLDER).length - 1; // placeholders drawn so far
    input.write("hello\n");
    await sleep(200);
    // the row was redrawn with the placeholder after the send …
    expect(buf.split(PLACEHOLDER).length - 1).toBeGreaterThan(before);
    // … and that redraw precedes the » echo of the submitted text
    expect(buf.lastIndexOf(PLACEHOLDER)).toBeLessThan(buf.indexOf("» hello"));
    input.write("/quit\n");
    await done;
  });

  it("a ticker refresh followed by typing parks the cursor on the prompt row, off the ticker", async () => {
    const { dir, id } = chatFixture("running");
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
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(700); // at least one ticker refresh while the worker runs
    input.write("ab\n"); // typed after the ticker refresh
    await sleep(300);
    input.write("/quit\n");
    await done;
    // every ticker write parks the cursor on the prompt row (23) right after
    // drawing its own row (24) — the last one included
    const tickers = [...buf.matchAll(/\x1b7\x1b\[24;1H\x1b\[K([^\x1b]*)(\x1b\[(\d+);(\d+)H)/g)];
    expect(tickers.length).toBeGreaterThan(0);
    const last = tickers[tickers.length - 1]!;
    expect(last[3]).toBe("23"); // parked on the prompt row …
    expect(last[4]).toBe("3"); // … right after ›
    // the two rows are independent: no buffer text or placeholder on the ticker
    expect(last[1]).not.toContain("ab");
    expect(last[1]).not.toContain(CHAT_HINT);
    // and after the submit the prompt row came back with the placeholder
    expect(buf).toContain(PLACEHOLDER);
  });

  it("entering chat mode draws the separator rule between the scroll region and the prompt", async () => {
    const { dir, id } = chatFixture("running");
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
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(200);
    input.write("/quit\n");
    await done;
    // one enter write: clear, region (1–21), the ─ rule on row 22 filling
    // the pane width, then the cursor parks on the prompt row (23) — colors
    // are off here, so the rule is bare box-drawing characters
    expect(buf).toContain(
      "\x1b[2J\x1b[1;21r\x1b[22;1H\x1b[K" + "─".repeat(80) + "\x1b[23;3H"
    );
  });

  it("a resize clears the pane before refilling, so the timeline does not interleave", async () => {
    const { dir, id } = chatFixture("running");
    const input = new PassThrough();
    let buf = "";
    let resizer: (() => void) | undefined;
    const stdout = {
      write: (s: string) => {
        buf += s;
        return true;
      },
      rows: 24,
      columns: 80,
      on: (ev: "resize", fn: () => void) => {
        resizer = fn;
      },
    };
    const io: FollowIO = {
      stdin: input,
      stdout,
      spawnResume: () => ({ on: () => undefined }),
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(200); // attach + backfill under the 24-row geometry
    buf = ""; // drop the enter sequence; only post-resize writes matter
    stdout.rows = 30;
    resizer?.();
    await sleep(100);
    // the region rebuild starts with a clear, so the refill from the top
    // lands on an empty pane instead of overwriting the old transcript rows
    expect(buf).toContain("\x1b[2J\x1b[1;27r");
    input.write("/quit\n");
    await done;
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

  for (const end of ["done", "failed"] as const) {
    it(`exits once the status flips to ${end}, even with a live pid, and not before`, async () => {
      const { dir, id } = chatFixture("running");
      const sp = join(dir, `${id}.status`);
      const st = JSON.parse(readFileSync(sp, "utf8"));
      writeFileSync(sp, JSON.stringify({ ...st, pid: process.pid, started: nowStamp() }));
      let finished = false;
      const done = followWorkers(dir, id, false, 1, { FORCE_TTY: "1" }, false, {
        stdin: new PassThrough(),
        stdout: { write: () => true, rows: 24, columns: 80 },
        spawnResume: () => ({ on: () => undefined }),
      }).then(() => {
        finished = true;
      });
      await sleep(1800);
      expect(finished).toBe(false);
      writeFileSync(sp, JSON.stringify({ ...st, pid: process.pid, started: nowStamp(), state: end }));
      await Promise.race([done, sleep(4000)]);
      expect(finished).toBe(true);
    }, 12000);
  }

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
  it("a resize clears the pane and replays the retained transcript", async () => {
    const { dir, id } = chatFixture("running");
    const input = new PassThrough();
    let buf = "";
    const resizeCbs: Array<() => void> = [];
    const stdout = {
      write: (s: string) => {
        buf += s;
        return true;
      },
      rows: 24,
      columns: 80,
      on: (ev: string, fn: () => void) => {
        if (ev === "resize") resizeCbs.push(fn);
        return undefined;
      },
      removeListener: () => undefined,
    };
    const io: FollowIO = {
      stdin: input,
      stdout,
      spawnResume: () => ({ on: () => undefined }),
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    await sleep(200); // attach + backfill
    for (const word of ["first", "second", "third"]) {
      input.write(word + "\n");
      await sleep(150); // the » echo, then the failed say becomes » resuming
    }
    expect(buf).toContain("» first"); // rendered before any resize
    expect(buf).toContain("» third");
    // shrink 24 → 12 rows (region 21 → 9): clear, then the lines back
    stdout.rows = 12;
    const at = buf.length;
    resizeCbs.forEach((cb) => cb());
    await sleep(50);
    const after = buf.slice(at);
    const clearAt = after.indexOf("\x1b[2J");
    expect(clearAt).toBeGreaterThanOrEqual(0); // the pane was cleared …
    expect(after.indexOf("» second")).toBeGreaterThan(clearAt); // … the transcript
    expect(after.indexOf("» third")).toBeGreaterThan(clearAt); // replayed after it
    expect(after.indexOf("» second")).toBeLessThan(after.indexOf("» third")); // in order
    // shrink 12 → 5 rows (region 2): only the newest two lines survive
    stdout.rows = 5;
    const at2 = buf.length;
    resizeCbs.forEach((cb) => cb());
    await sleep(50);
    const after2 = buf.slice(at2);
    expect(after2).toContain("\x1b[2J");
    expect(after2).toContain("» third");
    expect(after2).not.toContain("» second");
    expect(after2).not.toContain("» first");
    input.write("/quit\n");
    await done;
  }, 8000);

  it("a write failure from the pane does not end the pane's follow", async () => {
    const { dir, id } = chatFixture("running");
    const input = new PassThrough();
    let buf = "";
    const t0 = Date.now();
    let threw = false;
    const stdout = {
      write: (s: string) => {
        // one EPIPE/ENXIO-style throw, well after setup (chatEnter, the
        // initial prompt draw, the backfill) has already succeeded — a
        // single bad write to the pane must not take the whole follow down
        if (!threw && Date.now() - t0 > 300) {
          threw = true;
          throw new Error("EPIPE (test)");
        }
        buf += s;
        return true;
      },
      rows: 24,
      columns: 80,
    };
    const io: FollowIO = { stdin: input, stdout, spawnResume: () => ({ on: () => undefined }) };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    let settled = false;
    done.finally(() => {
      settled = true;
    });
    // an idle pane writes nothing, so a new event hits the failing write
    setTimeout(
      () =>
        appendFileSync(
          join(dir, `${id}.jsonl`),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) + "\n"
        ),
      500
    );
    await sleep(1500); // past the injected failure
    expect(threw).toBe(true); // the failure actually happened
    expect(settled).toBe(false); // … and follow is still running past it
    input.write("/quit\n");
    await done;
  }, 8000);

  it("an idle pane writes nothing to the terminal", async () => {
    const { dir, id } = chatFixture("running");
    const input = new PassThrough();
    let writes = 0;
    const io: FollowIO = {
      stdin: input,
      stdout: { write: () => ((writes += 1), true), rows: 24, columns: 80 },
      spawnResume: () => ({ on: () => undefined }),
    };
    const done = followWorkers(dir, id, false, 0, { FORCE_TTY: "1" }, false, io);
    // the liveness clock steps in 5 s wall ticks (writeLiveness → now5), so a
    // truly silent window has to sit inside one tick: wait for a tick with
    // room for settle + probe instead of sampling a random phase (~30% of
    // runs used to straddle a boundary and count one liveness repaint)
    while (5000 - (Date.now() % 5000) < 2600) await sleep(50);
    await sleep(700); // setup and backfill settle
    const before = writes;
    await sleep(1500);
    expect(writes).toBe(before);
    input.write("/quit\n");
    await done;
  }, 12000);

  it("records a PANE-CLOSED ledger line, with reason, whenever a pane's follow exits", async () => {
    const { dir, id } = chatFixture("done");
    const input = new PassThrough();
    const io: FollowIO = {
      stdin: input,
      stdout: { write: () => true, rows: 24, columns: 80 },
      spawnResume: () => ({ on: () => undefined }),
    };
    const done = followWorkers(dir, id, false, 1, { FORCE_TTY: "1" }, false, io);
    await done; // the worker is already "done": closes on the 1s countdown
    const ledger = readFileSync(ledgerPath(dir), "utf8");
    expect(ledger).toContain("PANE-CLOSED");
    expect(ledger).toContain(`id=${id}`);
    expect(ledger).toContain("reason=worker-ended");
  }, 8000);

  it("does not close the pane on a result event while the status says running, then closes once it ends", async () => {
    const { dir, id } = chatFixture("running");
    appendFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({ type: "result", is_error: true, result: "pool slot died mid-task", _ts: "2026-09-17T15:00:01Z" }) + "\n"
    );
    const io: FollowIO = {
      stdin: new PassThrough(),
      stdout: { write: () => true, rows: 24, columns: 80 },
      spawnResume: () => ({ on: () => undefined }),
    };
    let ended = false;
    const done = followWorkers(dir, id, false, 1, { FORCE_TTY: "1" }, false, io).then(() => (ended = true));
    await sleep(3500);
    expect(ended).toBe(false);
    const sp = join(dir, `${id}.status`);
    writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, "utf8")), state: "done", rc: 0, secs: 2 }));
    await done;
    expect(readFileSync(ledgerPath(dir), "utf8")).toContain("reason=worker-ended");
  }, 15000);

  it("stops on an ended status even when the recorded pid was reused by a live process, and prints the ended line", async () => {
    const { dir, id } = chatFixture("done");
    const sp = join(dir, `${id}.status`);
    // pid of this very process: alive, but started long after the worker's stamp
    writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, "utf8")), pid: process.pid }));
    let buf = "";
    const io: FollowIO = {
      stdin: new PassThrough(),
      stdout: { write: (s: string) => ((buf += s), true), rows: 24, columns: 80 },
      spawnResume: () => ({ on: () => undefined }),
    };
    await followWorkers(dir, id, false, 1, { FORCE_TTY: "1" }, false, io);
    expect(buf).toContain("ended done rc=0 after 2s");
    expect(readFileSync(ledgerPath(dir), "utf8")).toContain("reason=worker-ended");
  }, 8000);
});

describe("ps machine scope (no hidden workers)", () => {
  const logDir = mkdtempSync(join(tmpdir(), "pai-ps-machine-"));
  // a fresh stamp: real isLive compares it against ps's own start time (within
  // 120 s), so the fixture row counts as live for the whole test run
  const base = {
    pid: process.pid, // alive, so the row is live
    label: "cross-session task",
    cwd: "/repo",
    provider: "prov",
    model: "m",
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 1,
    tools: 1,
    last: "Bash: npm test",
    rc: null,
    secs: null,
    origin: "spawn",
  } as WorkerStatus;
  const mineTerm = "w5t0p0:11111111-2222-3333-4444-555555555555";
  const env = { ITERM_SESSION_ID: mineTerm } as NodeJS.ProcessEnv;

  it("CrossSessionWorkerListed: another session's live worker shows in the MACHINE section", () => {
    saveStatus(logDir, { ...base, id: "20260917-100000-1", term: mineTerm });
    saveStatus(logDir, {
      ...base,
      id: "20260917-100001-2",
      term: "w7t0p0:99999999-8888-7777-6666-555555555555",
      session: { id: "99999999-8888-7777-6666-555555555555", name: "AIBroker" },
    });
    const out = psOutput(logDir, false, env, false);
    expect(out).toContain("scope: tab w5t0"); // this session's own tree first
    expect(out).toContain("scope: MACHINE");
    expect(out).toContain("20260917-100001-2");
    expect(out).toContain("[AIBroker]"); // owner session named on the row
    // --all shows everything once, with no duplicate machine section
    const all = psOutput(logDir, true, env, false);
    expect(all).toContain("20260917-100001-2");
    expect(all).not.toContain("scope: MACHINE");
  });

  it("no machine section while every live worker is this session's", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-ps-own-"));
    saveStatus(dir, { ...base, id: "20260917-100002-3", term: mineTerm });
    expect(psOutput(dir, false, env, false)).not.toContain("scope: MACHINE");
  });

  it("QUEUED section above RUNNING, in grant order, with position and cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-ps-queued-"));
    const queuedRow = {
      ...base,
      state: "queued",
      capacity: { provider: "prov", cap: 1, total: 2, position: 2, elapsedSec: 40 },
    } as WorkerStatus;
    const head = { ...base, id: "20260917-100010-9", state: "queued", capacity: { provider: "prov", cap: 1, total: 2, position: 1, elapsedSec: 90 } } as WorkerStatus;
    saveStatus(dir, { ...base, id: "20260917-100008-7" });
    saveStatus(dir, { ...queuedRow, id: "20260917-100009-8" });
    saveStatus(dir, head);
    const out = psOutput(dir, true, env, false);
    const qi = out.indexOf("QUEUED (2)");
    const ri = out.indexOf("RUNNING (1)");
    expect(qi).toBeGreaterThanOrEqual(0);
    expect(ri).toBeGreaterThan(qi); // QUEUED above RUNNING
    expect(out.indexOf("20260917-100010-9")).toBeLessThan(out.indexOf("20260917-100009-8")); // position order
    expect(out).toContain("position 2 of 2, cap 1");
    expect(out).toContain("task: cross-session task");
    // a table with nothing waiting keeps the old shape
    const plain = mkdtempSync(join(tmpdir(), "pai-ps-noqueue-"));
    saveStatus(plain, { ...base, id: "20260917-100011-a" });
    expect(psOutput(plain, true, env, false)).not.toContain("QUEUED");
  });

  it("chat panes are terminals, not workers: never in the machine count", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-ps-chat-"));
    saveStatus(dir, { ...base, id: "20260917-100003-4", term: "w9t0p0:aaaa-bbbb", origin: "chat", label: "unlabeled", turns: 0 });
    expect(psOutput(dir, false, env, false)).not.toContain("scope: MACHINE");
    expect(statusLineOutput(dir, mineTerm, "/repo", "", new Date())).toBe("");
  });

  it("strayWorkerProcesses: a pai worker run without a live status file is reported", () => {
    const ps = [
      `  101 /bin/zsh --login`,
      `  102 node /usr/local/bin/pai worker run -p 'ghost task'`, // no status owns it
      `  103 /bin/zsh -c eval 'pai worker run -p wrapper'`, // shell wrapper: never the marker itself
      `  104 claude --settings {} -p 'mentions pai worker run in its prompt'`, // prompt noise, not a run
      `  105 ${process.execPath} pai worker follow 20260917-100000-1`, // a pane view, not a run
      `  ${process.pid} node /usr/local/bin/pai worker run -p 'owned by a live status'`,
    ].join("\n");
    const stray = strayWorkerProcesses(
      // this process's own pid is genuinely "live" (ps start time matches), so
      // its run line above is owned and never reported
      [{ pid: process.pid, parentPid: 103, started: nowStamp(), state: "running" }],
      ps
    );
    expect(stray.map((s) => s.pid)).toEqual([102]);
  });
});

describe("viewer resume spawn", () => {
  it("resumes through the launcher: no --no-pane, no PAI_WORKER override", () => {
    const src = readFileSync(new URL("./viewer.ts", import.meta.url), "utf8");
    expect(src).not.toContain("--no-pane");
    expect(src).not.toMatch(/PAI_WORKER:\s*"1"/);
  });
});
