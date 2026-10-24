import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneStatusFrame, startPaneBar } from "./pane-bar.js";
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
