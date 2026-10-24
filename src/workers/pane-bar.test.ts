import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Viewport, applyScroll, parseScrollInput, PANE_LEAVE } from "./pane-viewport.js";
import { PANE_HELP, paneStatusFrame, startPaneBar, readPaneClosedBy, workerPaused, PAUSE_NOTE, CONTINUE_NOTE } from "./pane-bar.js";
import type { WorkerGuardContext } from "../hooks/ts/lib/worker-guard.js";
import { paneRunStatusRow } from "./render.js";
import { openOwnedPane, runPaneExec } from "./pane-exec.js";
import type { WorkerStatus } from "./status.js";
import { EventEmitter } from "node:events";

const started = "2026-10-20 13:06:00";
const st = {
  id: "w1", label: "cockpit: fix it", model: "qwen3.8-flash-next-gyro-m", started,
  contextUsed: 62000, contextWindow: 200000,
} as unknown as WorkerStatus;
const at = (s: string): number => Date.parse(s.replace(" ", "T"));

describe("pane bar", () => {
  it("worker status line: label, model, context, start, elapsed; ticks", () => {
    vi.useFakeTimers();
    let t = at("2026-10-20 13:15:04");
    const wrote: string[] = [];
    const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: "/x" }, write: (s) => wrote.push(s), rows: () => 24, columns: () => 120, loadStatus: () => st, now: () => t });
    const all = (): string => wrote.join("");
    expect(all()).toContain("cockpit: fix it");
    expect(all()).toContain("62k");
    expect(all()).toContain("started 13:06");
    expect(all()).toContain("9m 04s");
    t += 1000;
    vi.advanceTimersByTime(1000);
    expect(all()).toContain("9m 05s");
    bar.stop();
    vi.useRealTimers();
  });

  it("pane-run status line is label · started · elapsed", () => {
    const ms = new Date(2026, 9, 20, 13, 6, 0).getTime();
    expect(paneRunStatusRow("status-test", ms, new Date(ms + 5000))).toBe("status-test · started 13:06 · 5s");
  });

  it("typed line goes to say and is shown as sent", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const wrote: string[] = [];
    const say = vi.fn().mockResolvedValue("ok");
    const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: "/x" }, write: (s) => wrote.push(s), rows: () => 24, columns: () => 80, loadStatus: () => st, say, input });
    input.write("hello worker\n");
    await vi.waitFor(() => expect(say).toHaveBeenCalledWith("/x", "w1", "hello worker"));
    await vi.waitFor(() => expect(wrote.join("")).toContain("» hello worker — queued"));
    bar.stop();
  });

  for (const pooled of [false, true]) {
    it(`${pooled ? "pooled" : "headless"}: queued line reports delivery at the worker's turn`, async () => {
      const input = Object.assign(new PassThrough(), { isTTY: false });
      const wrote: string[] = [];
      let cur = { ...st, turns: 4, state: "running", notePending: pooled ? ["hi"] : [] } as unknown as WorkerStatus;
      const delivered = vi.fn();
      const say = vi.fn().mockResolvedValue(pooled ? "queued: next turn" : "ok");
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: "/x" }, write: (s) => wrote.push(s), rows: () => 24, columns: () => 80, loadStatus: () => cur, say, input, delivered, tickMs: 10, live: (w) => w.state === "running" });
      input.write("hi\n");
      await vi.waitFor(() => expect(wrote.join("")).toContain("» hi — queued"));
      vi.advanceTimersByTime(10);
      expect(wrote.join("")).not.toContain("delivered at turn");
      cur = { ...cur, turns: 5, notePending: [] } as WorkerStatus;
      vi.advanceTimersByTime(10);
      expect(wrote.join("")).toContain("» hi — delivered at turn 5");
      expect(delivered).toHaveBeenCalledWith("/x", "w1", 1);
      bar.stop();
      vi.useRealTimers();
    });
  }

  it("reports not delivered when say fails or the worker ends first", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const wrote: string[] = [];
    let cur = { ...st, turns: 1, state: "running" } as unknown as WorkerStatus;
    const say = vi.fn().mockRejectedValueOnce(new Error("stdin closed")).mockResolvedValue("ok");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: "/x" }, write: (s) => wrote.push(s), rows: () => 24, columns: () => 80, loadStatus: () => cur, say, input, tickMs: 10, live: (w) => w.state === "running" });
    input.write("a\n");
    await vi.waitFor(() => expect(wrote.join("")).toContain("» a — not delivered: stdin closed"));
    input.write("b\n");
    await vi.waitFor(() => expect(wrote.join("")).toContain("» b — queued"));
    cur = { ...cur, state: "done" } as unknown as WorkerStatus;
    vi.advanceTimersByTime(10);
    expect(wrote.join("")).toContain("» b — not delivered: worker ended (done)");
    bar.stop();
    vi.useRealTimers();
  });

  describe("pane commands", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pai-pcmd-"));
      writeFileSync(join(dir, "w1.status"), JSON.stringify({ id: "w1", state: "running", label: "cockpit: fix it" }), "utf8");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const mk = (over: Record<string, unknown> = {}) => {
      const input = Object.assign(new PassThrough(), { isTTY: false });
      const wrote: string[] = [];
      const say = vi.fn().mockResolvedValue("ok");
      const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: dir }, write: (s) => wrote.push(s), rows: () => 24, columns: () => 80, loadStatus: () => st, say, input, ...over });
      return { input, wrote, say, bar };
    };

    it("/quit closes this pane only and marks the deliberate close", async () => {
      const closePane = vi.fn().mockResolvedValue(true);
      const { input, wrote, say, bar } = mk({ closePane });
      input.write("/quit\n");
      await vi.waitFor(() => expect(closePane).toHaveBeenCalled());
      expect(say).not.toHaveBeenCalled();
      expect(wrote.join("")).toContain("pane closed, the worker keeps running");
      expect(wrote.join("")).toContain(`pai worker pane w1`);
      expect(readPaneClosedBy(dir)).toMatchObject({ w1: "pane command" });
      bar.stop();
    });

    it("/exit is /quit", async () => {
      const closePane = vi.fn().mockResolvedValue(true);
      const { input, bar } = mk({ closePane });
      input.write("/exit\n");
      await vi.waitFor(() => expect(closePane).toHaveBeenCalled());
      expect(readPaneClosedBy(dir)).toMatchObject({ w1: "pane command" });
      bar.stop();
    });

    it("/stop calls the kill path with the reason; without one the default reason", async () => {
      const kill = vi.fn().mockResolvedValue([]);
      const { input, wrote, say, bar } = mk({ kill });
      input.write("/stop operator had second thoughts\n");
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(dir, "w1", "operator had second thoughts"));
      expect(say).not.toHaveBeenCalled();
      expect(wrote.join("")).toContain("» stopping w1: operator had second thoughts");
      input.write("/stop\n");
      await vi.waitFor(() => expect(kill).toHaveBeenLastCalledWith(dir, "w1", "operator /stop in pane"));
      bar.stop();
    });

    it("a kill that fails says so", async () => {
      const kill = vi.fn().mockRejectedValue(new Error("worker w1 is not running (state: done)"));
      const { input, wrote, bar } = mk({ kill });
      input.write("/stop x\n");
      await vi.waitFor(() => expect(wrote.join("")).toContain("not stopped: worker w1 is not running"));
      bar.stop();
    });

    it("an unknown slash command is shown, not forwarded", async () => {
      const { input, wrote, say, bar } = mk();
      input.write("/frobnate the widget\n");
      await vi.waitFor(() => expect(wrote.join("")).toContain("unknown pane command: /frobnate — /help lists them"));
      expect(say).not.toHaveBeenCalled();
      bar.stop();
    });

    it("/help lists the pane commands", async () => {
      const { input, wrote, say, bar } = mk();
      input.write("/help\n");
      await vi.waitFor(() => expect(wrote.join("")).toContain("/quit (or /exit)"));
      expect(wrote.join("")).toContain("/stop");
      expect(wrote.join("")).toContain("/pause");
      expect(wrote.join("")).toContain("/continue");
      expect(wrote.join("")).toContain("/help");
      expect(say).not.toHaveBeenCalled();
      bar.stop();
    });

    it("normal text is forwarded as today", async () => {
      const { input, say, bar } = mk();
      input.write("just a note\n");
      await vi.waitFor(() => expect(say).toHaveBeenCalledWith(dir, "w1", "just a note"));
      bar.stop();
    });

    it("/pause sets the pause, delivers its note; /continue clears and delivers; notes in order", async () => {
      const { input, wrote, say, bar } = mk();
      input.write("/pause\n");
      await vi.waitFor(() => expect(say).toHaveBeenLastCalledWith(dir, "w1", PAUSE_NOTE));
      expect(workerPaused(dir, "w1")).toBe(true);
      expect(wrote.join("")).toContain("paused");
      input.write("/continue\n");
      await vi.waitFor(() => expect(say).toHaveBeenLastCalledWith(dir, "w1", CONTINUE_NOTE));
      expect(workerPaused(dir, "w1")).toBe(false);
      expect(say.mock.calls.map((c) => c[2])).toEqual([PAUSE_NOTE, CONTINUE_NOTE]);
      bar.stop();
    });

    it("a paused worker shows paused in the bar", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { input, wrote, bar } = mk({ tickMs: 10 });
      input.write("/pause\n");
      await vi.waitFor(() => expect(workerPaused(dir, "w1")).toBe(true));
      vi.advanceTimersByTime(10);
      expect(wrote.join("")).toContain("paused ·");
      bar.stop();
      vi.useRealTimers();
    });

    it("the pause reaches the worker guard: Edit denied while paused, allowed after /continue", async () => {
      const { decideWorkerGuard } = await import("../hooks/ts/lib/worker-guard.js");
      const ctx: WorkerGuardContext = { cwd: "/work/wt", home: "/home/u", worktreeRoot: "/work/wt", inWorktree: true, mainCheckout: null, testScript: () => "vitest" };
      const env = { PAI_WORKER: "1", PAI_WORKER_ID: "w1", PAI_WORKER_LOOP_DIR: dir };
      const edit = { tool_name: "Edit", tool_input: { file_path: "a.ts" } };
      expect(decideWorkerGuard(edit, env, () => ctx).decision).toBe("allow");
      const { input, say, bar } = mk();
      input.write("/pause\n");
      await vi.waitFor(() => expect(say).toHaveBeenLastCalledWith(dir, "w1", PAUSE_NOTE));
      const d = decideWorkerGuard(edit, env, () => ctx);
      expect(d.decision).toBe("deny");
      expect((d as { reason: string }).reason).toBe("paused by the operator — answer, then wait for /continue");
      expect(decideWorkerGuard({ tool_name: "Bash", tool_input: { command: "ls" } }, env, () => ctx).decision).toBe("deny");
      input.write("/continue\n");
      await vi.waitFor(() => expect(say).toHaveBeenLastCalledWith(dir, "w1", CONTINUE_NOTE));
      expect(decideWorkerGuard(edit, env, () => ctx).decision).toBe("allow");
      bar.stop();
    });
  });
});

describe("wrapper draws the bar", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-pbar-"));
    vi.stubEnv("PAI_HOME", join(dir, "home"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  it("pane run: child output scrolls above, short status line pinned", async () => {
    const shown: string[] = [];
    const pane = openOwnedPane({
      id: "t-bar", kind: "pane", helloMs: 5000,
      open: async () => {
        void runPaneExec("t-bar", { out: (s) => shown.push(String(s)), err: (s) => shown.push(String(s)), tty: true, proc: new EventEmitter() as NodeJS.Process, bar: { rows: () => 24, columns: () => 80, input: undefined, onResize: undefined } });
        return "fake";
      },
    });
    const p = await pane;
    const proc = await p.start({ argv: ["/bin/sh", "-c", "echo hi"], statusLine: { kind: "run", label: "status-test", startedMs: Date.now() } });
    await new Promise((r) => proc.on("close", r));
    const all = shown.join("");
    expect(all).toContain("status-test · started");
    expect(all).toContain("hi");
  });
});

describe("paneStatusFrame", () => {
  const long = Array(6).fill("qwen3.8-flash-next-gyro-coder-l · 66k · started 13:50 · 6m 52s · denied").join(" · ");
  const visible = (f: string): string => f.replace(/\x1b7|\x1b8|\x1b\[[0-9;]*[A-Za-z]/g, "");
  it("is one line of at most width-1 visible chars that positions and clears first", () => {
    const f = paneStatusFrame(long, 24, 80);
    expect(f.startsWith("\x1b7\x1b[24;1H\x1b[2K")).toBe(true);
    expect(f.endsWith("\x1b8")).toBe(true);
    expect(visible(f)).not.toContain("\n");
    expect(visible(f).length).toBeLessThanOrEqual(79);
    expect(visible(f).endsWith("…")).toBe(true);
  });
  it("two frames overwrite: each carries its own clear, none grows", () => {
    const a = paneStatusFrame(long, 24, 80);
    const b = paneStatusFrame(long.replace("6m 52s", "6m 53s"), 24, 80);
    expect((a + b).match(/\x1b\[2K/g)).toHaveLength(2);
    expect(visible(a + b).length).toBeLessThanOrEqual(2 * 79);
  });
  it("a short text is left whole", () => {
    expect(visible(paneStatusFrame("w1 · 5s", 24, 80))).toBe("w1 · 5s");
  });
});

describe("pane viewport", () => {
  const mk = (n: number, h = 5): Viewport => {
    const v = new Viewport(h);
    for (let i = 1; i <= n; i++) v.push(`l${i}`);
    return v;
  };
  it("follows the newest rows and shows fewer than the height while short", () => {
    expect(mk(3).visible()).toEqual(["l1", "l2", "l3"]);
    expect(mk(12).visible()).toEqual(["l8", "l9", "l10", "l11", "l12"]);
    expect(mk(12).indicator()).toBe("");
  });
  it("scroll up/down stay inside [0, length-height]", () => {
    const v = mk(12);
    v.scrollUp(100);
    expect(v.offset).toBe(7);
    expect(v.visible()).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    v.scrollDown(2);
    expect(v.visible()).toEqual(["l3", "l4", "l5", "l6", "l7"]);
    v.scrollDown(100);
    expect(v.offset).toBe(0);
    expect(v.following).toBe(true);
    const short = mk(3);
    short.scrollUp(5);
    expect(short.offset).toBe(0);
  });
  it("new lines while scrolled up do not move the view; End follows again", () => {
    const v = mk(12);
    v.scrollUp(3);
    const before = v.visible();
    v.push("l13");
    v.push("l14");
    expect(v.visible()).toEqual(before);
    expect(v.indicator()).toBe("↑ 5 lines — End to follow");
    v.toEnd();
    expect(v.visible().at(-1)).toBe("l14");
  });
  it("the cap drops the oldest rows and keeps the offset inside the transcript", () => {
    const v = new Viewport(3, 10);
    for (let i = 1; i <= 10; i++) v.push(`l${i}`);
    v.scrollUp(100);
    for (let i = 11; i <= 20; i++) v.push(`l${i}`);
    expect(v.length).toBe(10);
    expect(v.offset).toBe(7);
    expect(v.visible()).toEqual(["l11", "l12", "l13"]);
  });
  it("a resize keeps the offset inside the new window", () => {
    const v = mk(12);
    v.scrollUp(7);
    v.resize(10);
    expect(v.offset).toBe(2);
  });
  it("frame rewrites every viewport row and blanks the rest", () => {
    const f = mk(2, 4).frame();
    expect(f.match(/\x1b\[2K/g)).toHaveLength(4);
    expect(f).toContain("\x1b[1;1H\x1b[2Kl1");
    expect(f).toContain("\x1b[3;1H\x1b[2K\x1b[4;1H");
  });
  it("parses wheel reports, paging keys, Shift+arrows and End; the rest passes through", () => {
    expect(parseScrollInput("\x1b[<64;10;5M\x1b[<65;10;5M")).toEqual({ actions: ["up", "down"], rest: "" });
    expect(parseScrollInput("\x1b[5~\x1b[6~\x1b[1;2A\x1b[1;2B\x1b[F\x1b[4~")).toEqual({
      actions: ["pageUp", "pageDown", "up", "down", "end", "end"],
      rest: "",
    });
    expect(parseScrollInput("ab\x1b[<0;3;4Mc\x1b[<0;3;4m")).toEqual({ actions: [], rest: "abc" });
    expect(parseScrollInput("\x1b[A")).toEqual({ actions: [], rest: "\x1b[A" });
    const v = mk(30);
    applyScroll(v, "pageUp");
    expect(v.offset).toBe(4);
    applyScroll(v, "end");
    expect(v.offset).toBe(0);
  });
  it("enters the alternate screen with mouse reporting and leaves in exact reverse on stop", () => {
    const wrote: string[] = [];
    const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: "/x" }, write: (s) => wrote.push(s), rows: () => 24, columns: () => 80, loadStatus: () => st });
    expect(wrote[0]).toContain("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    bar.stop();
    bar.stop();
    const leaves = wrote.filter((w) => w === PANE_LEAVE);
    expect(leaves).toHaveLength(1);
    expect(PANE_LEAVE).toBe("\x1b[?7h\x1b[?1006l\x1b[?1000l\x1b[?1049l\x1b[r\x1b[?25h");
  });
  it("wheel input scrolls the viewport, keeps the bars drawn, and typing follows again", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const wrote: string[] = [];
    const bar = startPaneBar({ spec: { kind: "worker", id: "w1", logDir: "/x" }, write: (s) => wrote.push(s), rows: () => 10, columns: () => 80, loadStatus: () => st, input });
    for (let i = 1; i <= 20; i++) bar.line(`row${i}`);
    wrote.length = 0;
    input.write("\x1b[<64;5;5M");
    await vi.waitFor(() => expect(wrote.join("")).toContain("↑ 3 lines — End to follow"));
    expect(wrote.join("")).toContain("row11");
    expect(wrote.join("")).not.toContain("row20");
    wrote.length = 0;
    bar.line("row21"); // does not jump the view
    expect(wrote.join("")).toContain("↑ 4 lines");
    expect(wrote.join("")).not.toContain("row21");
    wrote.length = 0;
    input.write("x");
    await vi.waitFor(() => expect(wrote.join("")).toContain("row21"));
    bar.stop();
  });
  it("/help names the scroll keys and the Option+drag selection hint", () => {
    expect(PANE_HELP.join("\n")).toMatch(/mouse wheel/);
    expect(PANE_HELP.join("\n")).toMatch(/Option while dragging/);
  });
});
