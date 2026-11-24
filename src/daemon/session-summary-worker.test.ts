import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldSummarize, capPrompt, extractFromJsonl } from "./session-summary-worker.js";
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
