/**
 * notice-policy.test.ts — one case per moved value: a user config override
 * (temp file via PAI_CONFIG_FILE, never the live config) changes the notice
 * behaviour. The shipped defaults keep the old values; the user's file wins.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pailotPolicy, runReportPolicy, troublePolicy } from "./notice-policy.js";
import { guardedPailot } from "./pailot-guard.js";
import { PlanReporter, QueueReporter, type Messenger, type RunOrigin } from "./run-events.js";
import { TroubleWatcher } from "./worker-trouble.js";
import type { QueueItem } from "./queue.js";

const savedConfigFile = process.env.PAI_CONFIG_FILE;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-notice-policy-"));
  process.env.PAI_CONFIG_FILE = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
});

const userYaml = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);

const origin: RunOrigin = { name: "main" };
function fakeMsg() {
  const session: string[] = [];
  const msg: Messenger = {
    async toSession(_o, text) {
      session.push(text);
      return true;
    },
    async toPailot() {
      return true;
    },
  };
  return { msg, session };
}
const item = (id: string): QueueItem => ({ id, text: "t", repo: "/r", files: [], created: "", state: "ready", rounds: 0, notes: [] });

describe("the shipped values stand unchanged", () => {
  it("every notices value equals the value the code used to hardcode", () => {
    const p = pailotPolicy();
    expect(p.maxPerMinute).toBe(5);
    expect(p.dedupMs).toBe(24 * 3600_000);
    expect(p.windowMs).toBe(60_000);
    const rp = runReportPolicy();
    expect(rp.planGroupThrottleMs).toBe(15 * 60_000);
    expect(rp.queueReadyBatchMs).toBe(10 * 60_000);
    const t = troublePolicy();
    expect(t.throttleMs).toBe(5 * 60_000);
    expect(t.denialWindowMs).toBe(10 * 60_000);
    expect(t.denialThreshold).toBe(3);
    expect(t.stallMs).toBe(10 * 60_000);
  });
});

describe("a user override changes the behaviour", () => {
  it("pailot.maxPerMinute: the gate lets exactly that many per minute", async () => {
    userYaml("notices:\n  pailot:\n    maxPerMinute: 2\n");
    const sent: string[] = [];
    let t = 1_000_000;
    for (let i = 0; i < 10; i++) await guardedPailot(dir, `msg ${i}`, async (x) => (sent.push(x), true), () => t);
    expect(sent).toHaveLength(3); // 2 through + one summary
    expect(sent[2]).toMatch(/more than 2 in a minute/);
  });

  it("pailot.dedupHours: past the shortened window the same text goes out again", async () => {
    userYaml("notices:\n  pailot:\n    dedupHours: 1\n");
    const sent: string[] = [];
    let t = 1_000_000;
    const send = async (x: string) => (sent.push(x), true);
    expect(await guardedPailot(dir, "same text", send, () => t)).toBe(true);
    expect(await guardedPailot(dir, "same text", send, () => t + 30 * 60_000)).toBe(false); // still inside 1 h
    expect(await guardedPailot(dir, "same text", send, () => t + 3600_000 + 1)).toBe(true); // marker expired (the old 24 h would not)
    expect(sent).toHaveLength(2);
  });

  it("pailot.windowSecs: the rate window shortens with the config", async () => {
    userYaml("notices:\n  pailot:\n    windowSecs: 10\n");
    const sent: string[] = [];
    let t = 1_000_000;
    const send = async (x: string) => (sent.push(x), true);
    for (let i = 0; i < 5; i++) await guardedPailot(dir, `msg ${i}`, send, () => t); // cap 5 fills the window
    expect(await guardedPailot(dir, "blocked", send, () => t)).toBe(false);
    expect(await guardedPailot(dir, "after 11s", send, () => t + 11_000)).toBe(true); // old default would still block
  });

  it("runReports.planGroupThrottleMinutes: unit groups batch at the configured span", async () => {
    userYaml("notices:\n  runReports:\n    planGroupThrottleMinutes: 1\n");
    const { msg, session } = fakeMsg();
    let t = 0;
    const r = new PlanReporter("job", 3, msg, origin, () => t);
    r.onLog({ event: "unit-done", unit: "u1" });
    t = 2 * 60_000; // past 1 min, inside the old 15 min
    r.onLog({ event: "unit-done", unit: "u2" });
    await r.flush();
    expect(session).toHaveLength(2);
  });

  it("runReports.queueReadyBatchMinutes: ready items batch at the configured span", async () => {
    userYaml("notices:\n  runReports:\n    queueReadyBatchMinutes: 1\n");
    const { msg, session } = fakeMsg();
    let t = 0;
    const r = new QueueReporter("proj", msg, origin, () => t);
    r.onReady(item("q1"));
    t = 2 * 60_000; // past 1 min, inside the old 10 min
    r.onReady(item("q2"));
    await r.flush();
    expect(session).toHaveLength(2);
  });

  it("trouble.throttleMinutes: trouble messages pass at the configured span", async () => {
    userYaml("notices:\n  trouble:\n    throttleMinutes: 1\n");
    const { msg, session } = fakeMsg();
    let t = 0;
    const w = new TroubleWatcher("w1", "", msg, origin, () => t);
    for (let i = 0; i < 3; i++) w.onDenial("h", "r"); // first message
    t = 2 * 60_000; // past 1 min, inside the old 5 min
    w.onDenial("h", "r");
    await w.flush();
    expect(session).toHaveLength(2);
  });

  it("trouble.denialWindowMinutes: denials spread past the shortened window do not count", async () => {
    userYaml("notices:\n  trouble:\n    denialWindowMinutes: 1\n");
    const { msg, session } = fakeMsg();
    let t = 0;
    const w = new TroubleWatcher("w1", "", msg, origin, () => t);
    for (let i = 0; i < 4; i++) {
      w.onDenial("h", "r");
      t += 2 * 60_000; // each denial ages the previous out of the 1 min window
    }
    await w.flush();
    expect(session).toHaveLength(0); // the old 10 min window would have told
  });

  it("trouble.denialThreshold: the session is told at the configured count", async () => {
    userYaml("notices:\n  trouble:\n    denialThreshold: 2\n");
    const { msg, session } = fakeMsg();
    let t = 0;
    const w = new TroubleWatcher("w1", "", msg, origin, () => t);
    w.onDenial("h", "r");
    t += 1000;
    w.onDenial("h", "r");
    await w.flush();
    expect(session).toHaveLength(1); // the old threshold of 3 would stay silent
    expect(session[0]).toContain("blocked 2x");
  });

  it("trouble.stallMinutes: quiet past the shortened span tells once", async () => {
    userYaml("notices:\n  trouble:\n    stallMinutes: 1\n");
    const { msg, session } = fakeMsg();
    let t = 0;
    const w = new TroubleWatcher("w1", "", msg, origin, () => t);
    t = 2 * 60_000; // past 1 min, inside the old 10 min
    w.tick();
    await w.flush();
    expect(session).toHaveLength(1);
    expect(session[0]).toContain("z=stalled");
  });
});
