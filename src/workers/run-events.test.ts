import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { aibrokerMessenger, detachRun, listRuns, markRunDone, originFromEnv, originTarget, PlanReporter, QueueReporter, sweepRuns, type Messenger, type RunOrigin } from "./run-events.js";
import { detachedArgv, reportOrigin, reportOriginWithHost } from "./run-report-wiring.js";
import * as pane from "./pane.js";

// The messenger's dynamic import of the AIBroker client is redirected to a
// temp module: tests never touch the live socket.
const stubClient = (): Array<[string, string]> => {
  const sent: Array<[string, string]> = [];
  const dir = mkdtempSync(join(tmpdir(), "aibroker-stub-"));
  const file = join(dir, "aibroker-client.js");
  writeFileSync(file, `export async function sendToSession(target, text) { return globalThis.__paiSend(target, text); }\nexport async function callAiBroker() { return {}; }\n`, "utf8");
  vi.stubEnv("AIBROKER_CLIENT_STUB", file);
  (globalThis as Record<string, unknown>).__paiSend = async (target: string, text: string) => (sent.push([target, text]), { ok: true });
  return sent;
};
import { parsePlan } from "./plan.js";
import { runPlan, type RunnerDeps } from "./plan-runner.js";
import type { QueueItem } from "./queue.js";

const origin: RunOrigin = { iterm: "AAAA-1", name: "main" };

function fake(): Messenger & { session: Array<{ to: RunOrigin; text: string }>; pailot: string[] } {
  const m = {
    session: [] as Array<{ to: RunOrigin; text: string }>,
    pailot: [] as string[],
    async toSession(to: RunOrigin, text: string) {
      m.session.push({ to, text });
      return true;
    },
    async toPailot(text: string) {
      m.pailot.push(text);
      return true;
    },
  };
  return m;
}

const item = (id: string, text: string, why?: string): QueueItem => ({ id, text, repo: "/r", files: [], created: "", state: "ready", rounds: 0, notes: [], why });

describe("PlanReporter", () => {
  it("reports needs-decision and a failed unit check to the session only", async () => {
    const m = fake();
    const r = new PlanReporter("job", 3, m, origin, () => 0);
    r.onLog({ event: "needs-decision", part: "p1", note: "gate failed" });
    r.onLog({ event: "unit-check", unit: "u1", ok: false, note: "tests red" });
    await r.flush();
    expect(m.session).toHaveLength(2);
    expect(m.session[0].to).toEqual(origin);
    expect(m.session[0].text).toMatch(/^S i=plan:job z=needs-decision \| part=p1 — Part p1 of job .*gate failed/);
    expect(m.session[1].text).toContain("z=unit-check-failed");
    expect(m.pailot).toEqual([]);
  });

  it("throttles unit-group messages to one per 15 minutes", async () => {
    const m = fake();
    let t = 0;
    const r = new PlanReporter("job", 4, m, origin, () => t);
    r.onLog({ event: "unit-done", unit: "u1" });
    t = 60_000;
    r.onLog({ event: "unit-done", unit: "u2" });
    t = 16 * 60_000;
    r.onLog({ event: "unit-done", unit: "u3" });
    await r.flush();
    expect(m.session).toHaveLength(2);
    expect(m.session[1].text).toContain("units=u2,u3");
  });

  it("run end: finished goes to session and PAILot with stats", async () => {
    const m = fake();
    let t = 0;
    const r = new PlanReporter("job", 2, m, origin, () => t);
    r.onLog({ event: "merge", part: "a", ok: true });
    r.onLog({ event: "part-end", part: "a", tier: "sonnet", tokens: 2500 });
    r.onLog({ event: "part-end", part: "b", tier: "local", tokens: 900 });
    r.onLog({ event: "escalate", part: "b" });
    t = 5 * 60_000;
    r.onLog({ event: "run-end", ok: true });
    await r.flush();
    expect(m.session[0].text).toContain("z=run-merged");
    expect(m.session[0].text).toContain("wall=5 min");
    expect(m.session[0].text).toContain("escalations=1");
    expect(m.session[0].text).toContain("cloud_tokens=2500");
    expect(m.session[0].text).toContain("local_tokens=900");
    expect(m.pailot).toEqual(["job is done: all 2 parts merged in 5 min."]);
  });

  it("run end blocked reaches PAILot with the blockers", async () => {
    const m = fake();
    const r = new PlanReporter("job", 3, m, origin, () => 0);
    r.onLog({ event: "needs-decision", part: "p1", note: "x" });
    r.onLog({ event: "run-end", ok: false, status: "blocked" });
    await r.flush();
    expect(m.session.at(-1)!.text).toContain("z=run-blocked");
    expect(m.pailot[0]).toMatch(/blocked.*p1/);
  });

  it("gets events from a real runPlan with fake deps", async () => {
    const plan = parsePlan(`job: j\nrepo: /r\ngate: g\nprovider: local\nunits:\n  - id: u1\n    parts:\n      - id: a\n        spec: do a\n`, "/tmp");
    const m = fake();
    const r = new PlanReporter("j", 1, m, origin);
    const deps: RunnerDeps = {
      startWorker: async () => ({ id: "w1", ok: true }),
      merge: async () => ({ ok: true, commit: "c2", before: "c1", output: "" }),
      unitCheck: async () => ({ ok: true, output: "" }),
      now: () => 0,
      resolveLocal: async (p) => p,
      log: (e) => r.onLog(e),
    };
    await runPlan(plan, { parallel: 1 }, deps);
    await r.flush();
    expect(m.session.map((s) => s.text.match(/z=([\w-]+)/)![1])).toEqual(["unit-done", "run-merged"]);
  });

  it("a messenger that throws does not break the run", async () => {
    const bad: Messenger = { toSession: async () => { throw new Error("down"); }, toPailot: async () => { throw new Error("down"); } };
    const r = new PlanReporter("job", 1, bad, origin);
    r.onLog({ event: "run-end", ok: true });
    await expect(r.flush()).resolves.toBeUndefined();
  });
});

describe("QueueReporter", () => {
  it("batches ready items to one message per 10 minutes and flushes the rest at the end", async () => {
    const m = fake();
    let t = 0;
    const r = new QueueReporter("proj", m, origin, () => t);
    r.onReady(item("q1", "fix tooltip"));
    t = 60_000;
    r.onReady(item("q2", "move button"));
    r.onReady(item("q3", "rename label"));
    expect(m.session).toHaveLength(0); // sends are queued; flush to see them
    await r.flush();
    expect(m.session).toHaveLength(1);
    expect(m.session[0].text).toContain('One queue item is ready for review: q1 "fix tooltip"');
    await r.finish();
    expect(m.session).toHaveLength(2);
    expect(m.session[1].text).toContain("2 queue items are ready for review: q2");
    expect(m.session[1].text).toContain("q3");
    expect(m.pailot).toEqual([]);
  });

  it("needs-decision is sent at once", async () => {
    const m = fake();
    const r = new QueueReporter("proj", m, origin, () => 0);
    r.onNeedsDecision(item("q4", "x", "gate red"));
    await r.flush();
    expect(m.session[0].text).toContain("z=needs-decision | item=q4");
    expect(m.session[0].text).toContain("gate red");
  });
});

describe("origin and detach", () => {
  it("reads the origin from the environment, PAI_RUN_ORIGIN first", () => {
    expect(originFromEnv({ CLAUDE_CODE_SESSION_ID: "cc1", ITERM_SESSION_ID: "w0t0p0:UUID-9", PAI_SESSION_NAME: "main" })).toEqual({ claudeSession: "cc1", iterm: "UUID-9", name: "main" });
    expect(originFromEnv({ PAI_RUN_ORIGIN: JSON.stringify({ name: "x" }), CLAUDE_CODE_SESSION_ID: "cc1" })).toEqual({ name: "x" });
    expect(reportOrigin({})).toBeNull();
  });

  it("registers a detached run and rebuilds the argv without --detach", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const rec = detachRun(dir, "plan", "my job", "pai", ["plan", "run", "/p.yaml"], "/r", origin, {
      spawnDetached: (bin, args, o) => (calls.push({ bin, args, env: o.env }), 4242),
      now: () => Date.UTC(2026, 9, 19, 12, 0, 0),
    });
    expect(rec.pid).toBe(4242);
    expect(rec.id).toBe("plan-my_job-20261019120000");
    expect(JSON.parse(calls[0].env.PAI_RUN_ORIGIN!)).toEqual(origin);
    expect(calls[0].env.PAI_RUN_ID).toBe(rec.id);
    expect(listRuns(dir).map((r) => r.id)).toEqual([rec.id]);
    expect(detachedArgv("plan", ["/p.yaml"], { detach: true, parallel: 2, "allow-dirty": true, "dry-run": false, escalate: "sonnet" })).toEqual(["plan", "run", "/p.yaml", "--parallel", "2", "--allow-dirty", "--escalate", "sonnet"]);
  });

  it("a background origin with a recorded host delivers to that uuid; nothing resolvable fails the same way", async () => {
    const sent = stubClient();
    const m = aibrokerMessenger("/tmp", () => undefined);
    // origin.iterm empty, host recorded at run start -> the host uuid is the target
    expect(await m.toSession({ claudeSession: "cc1", host: "HOST-7" }, "hi")).toBe(true);
    expect(sent[0]?.[0]).toBe("HOST-7");
    // nothing resolvable -> the same "no originating session" failure
    expect(await m.toSession({ name: "" }, "hi")).toBe(false);
    expect(m.lastError).toBe("the run has no originating session");
    vi.unstubAllEnvs();
  });

  it("the delivery-time resolver is the fallback when no host was recorded", async () => {
    const sent = stubClient();
    const m = aibrokerMessenger("/tmp", () => undefined, async (cid) => (cid === "cc1" ? "HOST-9" : ""));
    expect(await m.toSession({ claudeSession: "cc1" }, "hi")).toBe(true);
    expect(sent[0]?.[0]).toBe("HOST-9");
    expect(await m.toSession({ claudeSession: "other" }, "hi")).toBe(false);
    expect(m.lastError).toBe("the run has no originating session");
    vi.unstubAllEnvs();
  });

  it("originTarget prefers iterm, then the recorded host, then the name", () => {
    expect(originTarget({ iterm: "w8t0p0:UUID-1", host: "HOST-7", name: "n" })).toBe("UUID-1");
    expect(originTarget({ claudeSession: "cc1", host: "HOST-7", name: "n" })).toBe("HOST-7");
    expect(originTarget({ name: "n" })).toBe("n");
    expect(originTarget({})).toBeUndefined();
  });

  it("reportOriginWithHost records the resolved host when the origin has no iterm", async () => {
    const spy = vi.spyOn(pane, "resolveHostSession").mockResolvedValue({ uid: "HOST-3", term: "HOST-3", via: "daemon client" });
    try {
      expect(await reportOriginWithHost({ CLAUDE_CODE_SESSION_ID: "cc1" })).toEqual({ claudeSession: "cc1", host: "HOST-3" });
      // an origin that already names its terminal gets no lookup
      expect(await reportOriginWithHost({ ITERM_SESSION_ID: "w0t0p0:UUID-9" })).toEqual({ iterm: "UUID-9" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("the sweep reports a dead run once and ignores finished and live ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    const mk = (label: string, pid: number) => detachRun(dir, "queue", label, "pai", [], "/r", origin, { spawnDetached: () => pid, now: () => 0 });
    const dead = mk("dead", 1);
    const done = mk("done", 2);
    const live = mk("live", 3);
    markRunDone(dir, done.id);
    const m = fake();
    const told = await sweepRuns(dir, m, (pid) => pid === 3);
    expect(told).toEqual([dead.id]);
    expect(m.session[0].text).toContain("z=run-died");
    expect(m.pailot).toHaveLength(1);
    expect(await sweepRuns(dir, m, (pid) => pid === 3)).toEqual([]);
    expect(existsSync(live.output)).toBe(false);
    void readFileSync;
  });
});
