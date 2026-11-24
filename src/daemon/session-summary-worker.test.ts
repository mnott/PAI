import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldSummarize, capPrompt, extractFromJsonl, probeTopicShift, resetTopicProbeState } from "./session-summary-worker.js";
import { planSummarySpawn } from "../workers/daemon-llm.js";
import { enqueueDedupedPerSession, resetQueueForTests } from "./work-queue.js";

const line = (type: string, text: string) =>
  JSON.stringify({ type, message: { content: text }, timestamp: "2026-01-01T00:00:00Z" }) + "\n";

describe("session summary debounce", () => {
  it("50 Stop events in 10 min trigger at most 1 summary", () => {
    const t0 = 1_000_000_000;
    let state: { at: number; offset: number } | undefined;
    let runs = 0;
    for (let i = 0; i < 50; i++) {
      const now = t0 + i * 12_000;
      const g = shouldSummarize(state, { intervalMs: 30 * 60_000, now, newTextChars: () => 99_999 });
      if (g.run) { runs++; state = { at: now, offset: i }; }
    }
    expect(runs).toBe(1);
  });

  it("after the interval, needs enough new text; final always runs", () => {
    const st = { at: 0, offset: 0 };
    const base = { intervalMs: 1000, now: 5000 };
    expect(shouldSummarize(st, { ...base, newTextChars: () => 100 }).run).toBe(false);
    expect(shouldSummarize(st, { ...base, newTextChars: () => 30_000 }).run).toBe(true);
    expect(shouldSummarize(st, { final: true, intervalMs: 1e9, now: 1, newTextChars: () => 0 }).run).toBe(true);
  });

  it("SessionEnd shortly after a debounced Stop still summarizes once, only the new part", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ss-final-")), "t.jsonl");
    writeFileSync(f, line("user", "first question about alpha"));
    const t0 = 1_000_000_000;
    const intervalMs = 30 * 60_000;

    // Stop summary runs now and stores the offset.
    const stop = shouldSummarize(undefined, { intervalMs, now: t0, newTextChars: () => 30_000 });
    expect(stop.run).toBe(true);
    const a = extractFromJsonl(f, "haiku", 0);
    expect(a.userMessages.join()).toContain("alpha");
    const state = { at: t0, offset: a.endOffset };

    // 5 minutes later: a Stop is debounced.
    appendFileSync(f, line("user", "second question about beta"));
    const later = t0 + 5 * 60_000;
    const stop2 = shouldSummarize(state, { intervalMs, now: later, newTextChars: () => extractFromJsonl(f, "haiku", state.offset).textChars });
    expect(stop2.run).toBe(false);

    // SessionEnd (final) at the same moment summarizes once, reading only the part
    // after the stored offset.
    const fin = shouldSummarize(state, { final: true, intervalMs, now: later, newTextChars: () => 0 });
    expect(fin.run).toBe(true);
    expect(fin.reason).toBe("final");
    const b = extractFromJsonl(f, "haiku", state.offset);
    expect(b.userMessages).toEqual(["second question about beta"]);
    expect(b.userMessages.join()).not.toContain("alpha");
    expect(b.endOffset).toBeGreaterThan(a.endOffset);
  });

  it("a Stop does not set final", () => {
    const st = { at: 0, offset: 0 };
    // Stop payloads carry force, never final: within the interval they are debounced.
    expect(shouldSummarize(st, { intervalMs: 30 * 60_000, now: 60_000, newTextChars: () => 0 }).run).toBe(false);
    expect(shouldSummarize(st, { intervalMs: 30 * 60_000, now: 60_000, newTextChars: () => 0 }).run).toBe(false);
  });

  it("second extraction sends only the part after the stored offset", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ss-")), "t.jsonl");
    writeFileSync(f, line("user", "first question about alpha") + line("assistant", "answer one"));
    const a = extractFromJsonl(f, "haiku", 0);
    expect(a.userMessages.join()).toContain("alpha");
    appendFileSync(f, line("user", "second question about beta"));
    const b = extractFromJsonl(f, "haiku", a.endOffset);
    expect(b.userMessages).toEqual(["second question about beta"]);
    expect(b.endOffset).toBeGreaterThan(a.endOffset);
  });

  it("caps huge transcripts to the newest tail", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ss-")), "t.jsonl");
    let body = "";
    for (let i = 0; i < 3000; i++) body += line("user", `message number ${i} ` + "x".repeat(100));
    writeFileSync(f, body);
    const r = extractFromJsonl(f, "haiku", 0);
    expect(r.userMessages.at(-1)).toContain("message number 2999");
    expect(capPrompt("a".repeat(200_000)).length).toBe(120_000);
  });
});

describe("queue dedupe", () => {
  beforeEach(() => resetQueueForTests());
  it("one pending job per session", () => {
    const mk = (sid: string) => enqueueDedupedPerSession({ type: "session-summary", payload: { cwd: "/p", sessionId: sid } });
    const a = mk("s1");
    const b = mk("s1");
    const c = mk("s2");
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(c.deduped).toBe(false);
  });
});

describe("topic probe between debounced summaries", () => {
  const big = (word: string) => line("user", `${word} `.repeat(1500)) + line("assistant", `${word} `.repeat(1500));
  const mk = () => {
    const f = join(mkdtempSync(join(tmpdir(), "ss-probe-")), "t.jsonl");
    writeFileSync(f, big("kubernetes"));
    return f;
  };
  const t0 = 1_000_000_000;
  beforeEach(() => resetTopicProbeState());

  it("a different probe topic triggers a full summary; a similar one does not", async () => {
    const f = mk();
    const shifted = await probeTopicShift({ key: "a", jsonlPath: f, fromOffset: 0, currentTopic: "Fix router auth bug", now: t0, helper: async () => "Kubernetes cluster migration plan" });
    expect(shifted.shifted).toBe(true);
    const same = await probeTopicShift({ key: "b", jsonlPath: f, fromOffset: 0, currentTopic: "Fix router auth bug", now: t0, helper: async () => "Topic: Router auth bug fixes." });
    expect(same.probed).toBe(true);
    expect(same.shifted).toBe(false);
  });

  it("too little new text: no probe, helper not called", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "ss-probe-")), "t.jsonl");
    writeFileSync(f, line("user", "short"));
    let calls = 0;
    const r = await probeTopicShift({ key: "a", jsonlPath: f, fromOffset: 0, currentTopic: "x topic", now: t0, helper: async () => { calls++; return "other thing"; } });
    expect(r.probed).toBe(false);
    expect(calls).toBe(0);
  });

  it("rate limit: one probe per session per 5 minutes, later again", async () => {
    const f = mk();
    let calls = 0;
    const helper = async () => { calls++; return "Kubernetes cluster migration plan"; };
    const o = { key: "a", jsonlPath: f, fromOffset: 0, currentTopic: "Fix router auth bug", helper };
    await probeTopicShift({ ...o, now: t0 });
    appendFileSync(f, big("terraform"));
    const limited = await probeTopicShift({ ...o, now: t0 + 4 * 60_000 });
    expect(limited.reason).toBe("probe rate limit");
    expect(calls).toBe(1);
    await probeTopicShift({ ...o, now: t0 + 6 * 60_000 });
    expect(calls).toBe(2);
  });

  it("helper chain down: the summary model answers the same prompt; both down -> no probe, no error", async () => {
    const f = mk();
    const prompts: string[] = [];
    const viaSummary = await probeTopicShift({
      key: "a", jsonlPath: f, fromOffset: 0, currentTopic: "Fix router auth bug", now: t0,
      helper: async () => null, fallback: async (p) => { prompts.push(p); return "Kubernetes cluster migration plan"; },
    });
    expect(viaSummary.shifted).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].length).toBeLessThan(7_000);
    const none = await probeTopicShift({
      key: "b", jsonlPath: f, fromOffset: 0, currentTopic: "Fix router auth bug", now: t0,
      helper: async () => { throw new Error("down"); }, fallback: async () => null,
    });
    expect(none).toMatchObject({ probed: false, shifted: false });
  });
});

describe("session summary model resolution", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const YAML = (extra = "") => `providers:
  loc:
    url: http://127.0.0.1:9
    models: { default: loc-model }
    enabled: true
  cloudy:
    url: https://example.invalid
    models: { default: cloudy-default, fast: cloudy-fast }
    enabled: true
    key: test-key
${extra}`;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ss-model-"));
    for (const k of ["PAI_HOME", "PAI_CONFIG_FILE", "PAI_WORKERS_YAML", "ANTHROPIC_API_KEY"]) saved[k] = process.env[k];
    process.env.PAI_HOME = dir;
    process.env.PAI_CONFIG_FILE = join(dir, "config.json");
    process.env.PAI_WORKERS_YAML = join(dir, "workers.yaml");
    process.env.ANTHROPIC_API_KEY = "sk-should-never-pass";
    writeFileSync(join(dir, "config.json"), JSON.stringify({ workers: { enabled: true } }));
    writeFileSync(join(dir, "workers.yaml"), YAML());
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const probe = async () => false;
  const up = async () => ({ name: "loc" });
  const none = async () => { throw new Error("no local model server is running"); };

  it("default is local when a local provider is up", async () => {
    const plan = await planSummarySpawn(undefined, "sonnet", { probe, resolveLocal: up });
    expect(plan.provider).toBe("loc");
    expect(plan.model).toBe("loc-model");
    expect(plan.env.ANTHROPIC_API_KEY).not.toBe("sk-should-never-pass");
  });

  it("falls back to the cloud tier when no local provider answers", async () => {
    const plan = await planSummarySpawn("local", "sonnet", { probe, resolveLocal: none });
    expect(plan.model).not.toBe("loc-model");
    expect(plan.env.ANTHROPIC_API_KEY).not.toBe("sk-should-never-pass");
  });

  it("an explicit config value wins", async () => {
    expect((await planSummarySpawn("haiku", "sonnet", { probe, resolveLocal: up })).model).toBe("haiku");
    expect((await planSummarySpawn("cloudy", "sonnet", { probe, resolveLocal: up })).provider).toBe("cloudy");
    const pm = await planSummarySpawn("cloudy/some-model", "sonnet", { probe, resolveLocal: up });
    expect(pm).toMatchObject({ provider: "cloudy", model: "some-model" });
  });
});
