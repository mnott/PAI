import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPaneBar } from "./pane-bar.js";
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
    await vi.waitFor(() => expect(wrote.join("")).toContain("» hello worker"));
    bar.stop();
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
