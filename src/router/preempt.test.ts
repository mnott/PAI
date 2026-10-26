/**
 * A `--now` run on a local provider preempts the workers running there: their
 * request in flight is aborted at the upstream, the client connection stays
 * open, and the same request is sent again after the resume.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "./router.js";
import { DEFAULT_SCHED, setSchedConfigSource, sharedScheduler } from "./scheduler.js";
import { engineControlReader, setWorkerPaused } from "../workers/engine-control.js";
import { preemptLocal, resumePreempted } from "../workers/preempt.js";
import { blockedMsOf } from "../workers/active-time.js";
import { capacityGate } from "../workers/capacity.js";
import { armDeadline, extendLimit } from "../workers/deadline.js";
import { loadStatus, saveStatus, type WorkerStatus } from "../workers/status.js";
import type { WorkerProvider } from "../workers/config.js";

let logDir: string;
const closers: Array<() => void> = [];
const status = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: process.pid, label: id, cwd: "/", term: "", provider: "eng", model: "m", state: "running", started: "2026-01-01 00:00:00", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, ...over }) as WorkerStatus;
const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "pai-preempt-"));
  mkdirSync(logDir, { recursive: true });
  const sched = sharedScheduler();
  sched.control = engineControlReader(() => logDir);
  process.env.PAI_ROUTER_PING_MS = "25";
});
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  sharedScheduler().control = undefined;
  setSchedConfigSource(() => DEFAULT_SCHED);
  delete process.env.PAI_ROUTER_PING_MS;
  rmSync(logDir, { recursive: true, force: true });
});

async function fakeEngine() {
  const seen: string[] = [];
  const closedAt: Record<string, number> = {};
  let aAttempts = 0;
  const up = http.createServer((req, res) => {
    const bits: Buffer[] = [];
    req.on("data", (c: Buffer) => bits.push(c));
    req.on("end", () => {
      const who = JSON.parse(Buffer.concat(bits).toString()).messages[0].content as string;
      seen.push(who);
      const answer = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message_delta\ndata: {"type": "message_delta", "delta": {}, "usage": {"output_tokens": 3}}\n\nevent: content\ndata: ANSWER-${who}\n\n`);
      };
      if (who === "A" && ++aAttempts === 1) {
        // slow: nothing sent until the client side closes this socket
        res.on("close", () => (closedAt.A = Date.now()));
        return;
      }
      answer();
    });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const provider = {
    enabled: true, protocol: "anthropic", baseUrl: `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
    keyFile: null, models: { default: "qwen-test" }, env: {},
  } as unknown as WorkerProvider;
  const router = createRouter(() => ({ eng: provider }), "http://127.0.0.1:1", () => {}, () => {});
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  closers.push(() => { router.close(); up.closeAllConnections(); up.close(); });
  const port = (router.address() as AddressInfo).port;
  const call = (session: string, worker: string, who: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const rq = http.request(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "eng", "x-pai-session": session, "x-pai-worker": worker } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        }
      );
      rq.on("error", reject);
      rq.end(JSON.stringify({ model: "qwen-test", stream: true, messages: [{ role: "user", content: who }] }));
    });
  return { call, seen, closedAt };
}

describe("--now preempts local workers", () => {
  it("aborts the request in flight, serves the now run, then re-sends and answers once", async () => {
    const t = await fakeEngine();
    saveStatus(logDir, status("A"));
    saveStatus(logDir, status("B"));
    const a = t.call("sa", "A", "A");
    await until(() => t.seen.includes("A"));
    const t0 = Date.now();
    expect(preemptLocal(logDir, "eng", "B")).toEqual(["A"]);
    const b = t.call("sb", "B", "B");
    // A's upstream socket is closed within 1 s, B is served while A is parked
    await until(() => t.closedAt.A !== undefined, 1000);
    expect(t.closedAt.A - t0).toBeLessThan(1000);
    const rb = await b;
    expect(rb.text).toContain("ANSWER-B");
    expect(t.seen).toEqual(["A", "B"]);
    // A stays parked (client open, no second send) until the now run ends
    await new Promise((r) => setTimeout(r, 300));
    expect(t.seen).toEqual(["A", "B"]);
    expect(resumePreempted(logDir, "B")).toEqual(["A"]);
    const ra = await a;
    expect(t.seen).toEqual(["A", "B", "A"]);
    expect(ra.status).toBe(200);
    expect(ra.text.match(/ANSWER-A/g)).toHaveLength(1);
    expect(ra.text.match(/event: message_delta/g)).toHaveLength(1);
    expect(ra.text).not.toContain("error");
  });
});

describe("preemption bookkeeping", () => {
  it("moves A's deadline by the paused time", () => {
    saveStatus(logDir, status("A"));
    saveStatus(logDir, status("B"));
    const T = 1_000_000;
    preemptLocal(logDir, "eng", "B", T);
    expect(loadStatus(logDir, "A")).toMatchObject({ paused: true, pausedBy: "B" });
    expect(blockedMsOf(logDir, "A", T + 40_000)).toBe(40_000);
    resumePreempted(logDir, "B", T + 90_000);
    expect(blockedMsOf(logDir, "A", T + 200_000)).toBe(90_000);
    // the deadline the run arms is limit + blocked: it fires 90 s later than without the pause
    const limit = extendLimit({ deadlineAt: T + 120_000, minutes: 2 }, 0);
    let clock = T + 200_000;
    let fired = 0;
    const stop = armDeadline({ kill: () => true, exitCode: null, signalCode: null }, limit, () => fired++, 1, () => blockedMsOf(logDir, "A", clock), () => clock);
    // without the pause the limit passed at T+120_000; with it the deadline is T+210_000
    expect(limit.deadlineAt + blockedMsOf(logDir, "A", clock)).toBe(T + 210_000);
    stop();
    expect(fired).toBe(0);
  });

  it("paused workers hold no slot: the now run is admitted at cap", async () => {
    saveStatus(logDir, status("A"));
    const base = { logDir, cap: 1, config: {}, isAlive: () => true, priority: "front" as const };
    const r = await capacityGate({ ...base, self: { id: "B", provider: "eng" }, preempt: () => void preemptLocal(logDir, "eng", "B") });
    expect(r).toBeNull();
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
  });

  it("resumes only what it paused; an operator pause of its own is kept", () => {
    saveStatus(logDir, status("A"));
    saveStatus(logDir, status("C"));
    saveStatus(logDir, status("B"));
    expect(setWorkerPaused(logDir, "C", true, "cli")).toBe(true);
    expect(preemptLocal(logDir, "eng", "B")).toEqual(["A"]);
    // the operator pauses the preempted A separately: it is theirs now
    setWorkerPaused(logDir, "A", true, "cli");
    expect(resumePreempted(logDir, "B")).toEqual([]);
    expect(loadStatus(logDir, "A")?.paused).toBe(true);
    expect(loadStatus(logDir, "C")?.paused).toBe(true);
  });
});
