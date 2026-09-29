import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSystemPromptArgs } from "./args.js";
import { stripBrowserArgs, stripBrowserNames, isBrowserTool } from "./browser-tools.js";
import { parseWorkersConfig } from "./config.js";
import { armDeadline, deadlineLabel, deadlinePromptLine, parseDeadline, resolveLimit } from "./deadline.js";
import { makeColor, renderTable } from "./render.js";
import { finaliseRun, fireDeadline } from "./run.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";
import { decideWorkerGuard } from "../hooks/ts/lib/worker-guard.js";

const at = (h: number, m: number) => new Date(2026, 8, 29, h, m, 0, 0);

describe("deadline parsing", () => {
  it("HH:MM later today stays today", () => {
    expect(parseDeadline("23:30", at(22, 0))).toBe(at(23, 30).getTime());
  });
  it("HH:MM already past rolls to tomorrow", () => {
    expect(parseDeadline("08:15", at(22, 0))).toBe(new Date(2026, 8, 30, 8, 15).getTime());
  });
  it("rejects malformed input", () => {
    expect(() => parseDeadline("25:00")).toThrow(/HH:MM/);
    expect(() => parseDeadline("noon")).toThrow(/HH:MM/);
  });
  it("--max-minutes wins over the default; 0 disables; default applies", () => {
    const now = at(10, 0);
    expect(resolveLimit({ maxMinutes: 5 }, 60, now)).toEqual({ deadlineAt: now.getTime() + 300_000, minutes: 5 });
    expect(resolveLimit({ maxMinutes: 0 }, 60, now)).toBeNull();
    expect(resolveLimit({}, 60, now)?.minutes).toBe(60);
    expect(resolveLimit({}, 0, now)).toBeNull();
  });
  it("--deadline gives minutes to the deadline; both flags are exclusive", () => {
    const now = at(10, 0);
    expect(resolveLimit({ deadline: "10:45" }, 60, now)?.minutes).toBe(45);
    expect(() => resolveLimit({ deadline: "10:45", maxMinutes: 5 }, 60, now)).toThrow(/exclusive/);
  });
  it("the default limit comes from config (60) and is configurable", () => {
    expect(parseWorkersConfig(undefined).defaultMaxMinutes).toBe(60);
    expect(parseWorkersConfig({ defaultMaxMinutes: 15 }).defaultMaxMinutes).toBe(15);
    expect(parseWorkersConfig(undefined).noBrowserByDefault).toBe(false);
  });
});

describe("prompt injection", () => {
  it("the deadline line lands inside the single --append-system-prompt flag", () => {
    const limit = { deadlineAt: at(14, 5).getTime(), minutes: 30 };
    const args = appendSystemPromptArgs(["contract", deadlinePromptLine(limit), "caller"]);
    expect(args.filter((a) => a === "--append-system-prompt")).toHaveLength(1);
    expect(args[1]).toContain("Hard deadline 14:05 (30 min). Finish and report before it;");
    expect(args[1]).toContain("contract");
    expect(args[1]).toContain("caller");
  });
});

describe("armDeadline", () => {
  it("SIGTERMs, then SIGKILLs a child that ignores SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 400)); // let the handler install
    const signals: string[] = [];
    const real = child.kill.bind(child);
    child.kill = ((sig?: NodeJS.Signals) => (signals.push(String(sig)), real(sig))) as typeof child.kill;
    let fired = 0;
    const t0 = Date.now();
    armDeadline(child, { deadlineAt: t0 + 500, minutes: 1 }, () => fired++, 800);
    const sig = await new Promise<string | null>((r) => child.on("close", (_c, s) => r(s)));
    expect(fired).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sig).toBe("SIGKILL");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1200);
  });
  it("a child that exits on SIGTERM is not SIGKILLed; disarm cancels", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const sig = new Promise<string | null>((r) => child.on("close", (_c, s) => r(s)));
    armDeadline(child, { deadlineAt: Date.now() + 200, minutes: 1 }, () => {}, 500);
    expect(await sig).toBe("SIGTERM");
    const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},700)"], { stdio: "ignore" });
    const off = armDeadline(other, { deadlineAt: Date.now() + 200, minutes: 1 }, () => {}, 100);
    off();
    expect(await new Promise((r) => other.on("close", (c) => r(c)))).toBe(0);
  });
});

describe("timed-out status and ps", () => {
  let logDir: string;
  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "pai-deadline-"));
  });
  afterEach(() => rmSync(logDir, { recursive: true }));
  const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
    id: "w-1", pid: -1, label: "task", cwd: logDir, term: "", provider: "p", model: "m",
    state: "running", started: "2026-09-29 10:00:00", updated: "2026-09-29 10:00:00",
    turns: 0, tools: 0, last: "", rc: null, secs: null, ...over,
  });

  it("the deadline records timedOut, a WORKER-DEADLINE line, and a ~ report", async () => {
    const s = status();
    saveStatus(logDir, s);
    const ledger = join(logDir, "ledger.log");
    fireDeadline(logDir, s, ledger, { deadlineAt: 0, minutes: 2 });
    const rc = await finaliseRun({
      logDir, ledger, status: s, ok: false, rc: 143, secs: 120, end: {}, report: null, timedOut: 2,
    });
    expect(rc).toBe(143);
    const saved = loadStatus(logDir, "w-1")!;
    expect(saved.timedOut).toBe(true);
    expect(saved.state).toBe("failed");
    expect(saved.last).toBe("deadline reached after 2 min");
    expect(readFileSync(ledger, "utf8")).toContain("WORKER-DEADLINE");
  });

  it("labels remaining, overdue and timed out", () => {
    const now = Date.UTC(2026, 8, 29, 10, 0, 0);
    expect(deadlineLabel(status({ deadlineAt: now + 12.5 * 60_000 }), now)).toBe("12m left");
    expect(deadlineLabel(status({ deadlineAt: now - 3.2 * 60_000 }), now)).toBe("OVERDUE 3m");
    expect(deadlineLabel(status({ state: "failed", timedOut: true }), now)).toBe("timed out");
    expect(deadlineLabel(status({ state: "done", deadlineAt: now - 1 }), now)).toBeNull();
    expect(deadlineLabel(status(), now)).toBeNull();
  });

  it("ps renders the labels for running and finished workers", () => {
    const now = new Date();
    const running = status({ id: "w-run", pid: process.pid, started: nowStamp(), deadlineAt: now.getTime() + 12 * 60_000 + 5_000 });
    const done = status({ id: "w-done", state: "failed", timedOut: true, rc: 143, secs: 60 });
    const out = renderTable(makeColor(false), [running, done], "scope", now);
    expect(out).toMatch(/w-run[^\n]*12m left/);
    expect(out).toMatch(/w-done[^\n]*timed out/);
  });
});

describe("--no-browser", () => {
  it("strips --chrome and browser grants, keeps the rest", () => {
    const rest = ["-p", "task", "--chrome", "--allowedTools", "Read,mcp__claude-in-chrome__tabs_context_mcp,mcp__browsr__open,Bash"];
    expect(stripBrowserArgs(rest)).toEqual(["-p", "task", "--allowedTools", "Read,Bash"]);
    expect(stripBrowserArgs(["--allowedTools", "mcp__claude-in-chrome__x"])).toEqual([]);
    expect(stripBrowserArgs(["--allowedTools=Read,mcp__browsr__x"])).toEqual(["--allowedTools=Read"]);
  });
  it("recognises browser servers and tools, not others", () => {
    expect(["claude-in-chrome", "browsr", "mcp__playwright__click"].every(isBrowserTool)).toBe(true);
    expect(["Bash", "mcp__github__issue", "WebFetch"].some(isBrowserTool)).toBe(false);
    expect(stripBrowserNames(["browsr,github", "claude-in-chrome"])).toEqual(["github"]);
  });
  it("the worker hook denies browser tools only with PAI_WORKER_NO_BROWSER=1", () => {
    const input = { tool_name: "mcp__claude-in-chrome__navigate", cwd: "/x", tool_input: {} };
    const ctx = () => {
      throw new Error("no ctx needed");
    };
    expect(decideWorkerGuard(input, { PAI_WORKER: "1", PAI_WORKER_NO_BROWSER: "1" }, ctx).decision).toBe("deny");
    expect(decideWorkerGuard(input, { PAI_WORKER: "1" }, ctx).decision).toBe("allow");
  });
});
