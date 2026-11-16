import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followReroute, guardQueuedRun, markHandover, rerouteOutPath } from "./follow-reroute.js";
import { saveStatus, loadStatus, type WorkerStatus } from "../status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "follow-reroute-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const base = (over: Partial<WorkerStatus>): WorkerStatus =>
  ({ id: "w1", pid: 4321, label: "l", cwd: "/", term: "", provider: "local", model: "m", state: "queued", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, outputFormat: "json", ...over }) as WorkerStatus;

describe("followReroute", () => {
  it("emits the restart's json result with worker_id = new and worker_ids = [old, new], and returns its rc", async () => {
    saveStatus(dir, base({ rerouted: "anthropic: queued 15m", fallThroughTo: "w2" }));
    saveStatus(dir, base({ id: "w2", state: "done", rc: 0, provider: "anthropic" }));
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(rerouteOutPath(dir, "w1"), `noise\n${JSON.stringify({ type: "result", result: "R from w2", worker_id: "w2", worker_ids: ["w2"] })}\n`, "utf8");
    const lines: string[] = [];
    const rc = await followReroute(loadStatus(dir, "w1")!, { logDir: dir, stepMs: 5, out: (s) => void lines.push(s), err: () => undefined });
    expect(rc).toBe(0);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(payload.worker_id).toBe("w2");
    expect(payload.worker_ids).toEqual(["w1", "w2"]);
    expect(payload.result).toBe("R from w2");
  });

  it("waits for the hand-over marker a beat late and still follows (a reroute's SIGTERM can win the race)", async () => {
    saveStatus(dir, base({})); // no marker yet
    const t = setTimeout(() => {
      const st = loadStatus(dir, "w1")!;
      st.rerouted = "anthropic: queued 15m";
      st.fallThroughTo = "w2";
      saveStatus(dir, st, new Date(), true);
      saveStatus(dir, base({ id: "w2", state: "done", rc: 0 }));
      mkdirSync(join(dir, "runs"), { recursive: true });
      writeFileSync(rerouteOutPath(dir, "w1"), JSON.stringify({ result: "late", worker_ids: ["w2"] }) + "\n", "utf8");
    }, 30);
    const lines: string[] = [];
    const rc = await followReroute(loadStatus(dir, "w1")!, { logDir: dir, stepMs: 5, markerTimeoutMs: 500, out: (s) => void lines.push(s), err: () => undefined });
    clearTimeout(t);
    expect(rc).toBe(0);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).worker_id).toBe("w2");
  });

  it("returns null when no hand-over marker ever lands (a plain kill is not a follow)", async () => {
    saveStatus(dir, base({}));
    expect(await followReroute(loadStatus(dir, "w1")!, { logDir: dir, stepMs: 5, markerTimeoutMs: 30, out: () => undefined, err: () => undefined })).toBeNull();
  });

  it("a reconcile that rewrote the follower's status to lost is repaired back to killed with its links", async () => {
    saveStatus(dir, base({ rerouted: "anthropic: queued 15m", fallThroughTo: "w2" }));
    saveStatus(dir, base({ id: "w2", state: "done", rc: 0 }));
    // something (reconcile) rewrote the old run's status while this one followed
    saveStatus(dir, base({ rerouted: "anthropic: queued 15m", fallThroughTo: "w2", state: "lost", rc: null, last: "process ended without a final status" }));
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(rerouteOutPath(dir, "w1"), JSON.stringify({ result: "x", worker_ids: ["w2"] }) + "\n", "utf8");
    const rc = await followReroute(loadStatus(dir, "w1")!, { logDir: dir, stepMs: 5, out: () => undefined, err: () => undefined });
    expect(rc).toBe(0);
    const st = loadStatus(dir, "w1")!;
    expect(st.state).toBe("killed");
    expect(st.rc).toBe(143);
    expect(st.fallThroughTo).toBe("w2");
  });
});

describe("markHandover", () => {
  it("writes the marker through a fresh load and never overwrites one that stands", () => {
    saveStatus(dir, base({}));
    markHandover(dir, "w1", "rerouted to anthropic (queued 15m)");
    expect(loadStatus(dir, "w1")!.rerouted).toBe("rerouted to anthropic (queued 15m)");
    markHandover(dir, "w1", "second reason");
    expect(loadStatus(dir, "w1")!.rerouted).toBe("rerouted to anthropic (queued 15m)");
  });
});

describe("guardQueuedRun", () => {
  it("a SIGTERM without a hand-over marker ends the run with 143 after the grace", async () => {
    saveStatus(dir, base({}));
    const exits: number[] = [];
    const guard = guardQueuedRun(dir, "w1", { exit: (rc) => void exits.push(rc) });
    process.emit("SIGTERM" as NodeJS.Signals);
    // the guard gives the stopper's marker a grace (HANDOVER_MARKER_MS = 3 s) before ending a plain kill
    for (let i = 0; i < 250 && !exits.length; i++) await new Promise((r) => setTimeout(r, 40));
    expect(exits).toEqual([143]);
    expect(loadStatus(dir, "w1")!.state).toBe("queued"); // a plain kill leaves the status to its writer
    guard.dispose();
  });

  it("a SIGTERM with the marker turns the process into the restart's follower and exits with its rc", async () => {
    saveStatus(dir, base({ rerouted: "anthropic: queued 15m", fallThroughTo: "w2" }));
    saveStatus(dir, base({ id: "w2", state: "done", rc: 0 }));
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(rerouteOutPath(dir, "w1"), JSON.stringify({ result: "R", worker_ids: ["w2"] }) + "\n", "utf8");
    const exits: number[] = [];
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s) => void lines.push(String(s)));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const guard = guardQueuedRun(dir, "w1", { exit: (rc) => void exits.push(rc) });
    process.emit("SIGTERM" as NodeJS.Signals);
    for (let i = 0; i < 200 && !exits.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([0]);
    expect(guard.aborted()).toBe(true);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(payload.worker_id).toBe("w2");
    expect(payload.worker_ids).toEqual(["w1", "w2"]);
    expect(loadStatus(dir, "w1")!.state).toBe("killed");
    guard.dispose();
  });
});
