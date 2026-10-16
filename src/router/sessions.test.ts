import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionMap, loadWorkerWindows, sessionDisplayName, withWorkerAttribution, type WorkerWindow } from "./sessions.js";

describe("session mapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-"));
  writeFileSync(join(dir, "w1.status"), JSON.stringify({ id: "w1", label: "fix thing", state: "done", rc: 0, claudeSession: "c-1", provider: "glm" }));
  writeFileSync(join(dir, "w2.status"), JSON.stringify({ id: "w2", label: "bad", state: "done", rc: 1, claudeSession: "c-2" }));
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ "c-3": "proj" }));
  const map = loadSessionMap({ workerDirs: [dir], agentSessionsFile: join(dir, "agents.json") });

  it("maps worker sessions with verdict and agent sessions to project", () => {
    expect(sessionDisplayName("c-1", map)).toBe("fix thing");
    expect(map.get("c-1")).toMatchObject({ worker: "w1", verdict: "ok", provider: "glm" });
    expect(map.get("c-2")?.verdict).toBe("failed");
    expect(sessionDisplayName("c-3", map)).toBe("proj");
  });

  it("unknown or missing id is null", () => {
    expect(sessionDisplayName("zzz", map)).toBeNull();
    expect(sessionDisplayName(undefined, map)).toBeNull();
  });
});

describe("session mapper: transcript fallback", () => {
  it("names a session from its project directory when no registry lists it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "-Users-x-dev-PAI"), { recursive: true });
    writeFileSync(join(projects, "-Users-x-dev-PAI", "c-9.jsonl"), "{}");
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ "c-8": "reg" }));
    mkdirSync(join(projects, "-Users-x-other"), { recursive: true });
    writeFileSync(join(projects, "-Users-x-other", "c-8.jsonl"), "{}");
    const map = loadSessionMap({ workerDirs: [], agentSessionsFile: join(dir, "agents.json"), projectsDir: projects });
    expect(sessionDisplayName("c-9", map)).toBe("PAI");
    expect(sessionDisplayName("c-8", map)).toBe("reg");
  });
});

describe("one-shot worker attribution", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-win-"));
  writeFileSync(
    join(dir, "f1.status"),
    JSON.stringify({ id: "f1", label: "repair dotted tool names", state: "done", rc: 0, provider: "glm", model: "glm-5.3-flash", started: "2026-10-16T18:46:20Z", updated: "2026-10-16T18:46:50Z", claudeSession: "pane-1" })
  );
  writeFileSync(
    join(dir, "f2.status"),
    JSON.stringify({ id: "f2", label: "other task", state: "done", rc: 0, provider: "glm", model: "glm-5.3-flash", started: "2026-10-16T18:47:00Z", updated: "2026-10-16T18:49:00Z" })
  );
  const windows = loadWorkerWindows({ workerDirs: [dir], agentSessionsFile: join(dir, "none.json") });

  it("reads status files as run windows", () => {
    expect(windows.map((w) => w.label)).toContain("repair dotted tool names");
    const w = windows.find((x) => x.worker === "f1")!;
    expect(w.model).toBe("glm-5.3-flash");
    expect(w.startMs).toBe(Date.parse("2026-10-16T18:46:20Z"));
    expect(w.verdict).toBe("ok");
  });

  it("attributes a lone one-shot session inside exactly one window", () => {
    const map = new Map();
    const rows = [{ ts: "2026-10-16T18:47:40Z", session_id: "one-shot", model: "glm-5.3-flash", provider: "glm" }];
    const out = withWorkerAttribution(map, rows, windows);
    expect(out.get("one-shot")).toMatchObject({ name: "other task", worker: "f2", verdict: "ok" });
  });

  it("picks the most recently started run when worker windows overlap", () => {
    const overlapping: WorkerWindow[] = [
      { worker: "a", label: "task a", provider: "glm", model: "glm-5.3-flash", startMs: Date.parse("2026-10-16T18:46:00Z"), endMs: Date.parse("2026-10-16T18:49:00Z"), state: "done" },
      { worker: "b", label: "task b", provider: "glm", model: "glm-5.3-flash", startMs: Date.parse("2026-10-16T18:47:00Z"), endMs: Date.parse("2026-10-16T18:49:00Z"), state: "done" },
    ];
    const map = new Map([["flash-1", { name: "pai" }]]);
    const rows = [{ ts: "2026-10-16T18:47:40Z", session_id: "flash-1", model: "glm-5.3-flash", provider: "glm" }];
    expect(withWorkerAttribution(map, rows, overlapping).get("flash-1")).toMatchObject({ name: "task b", worker: "b" });
  });

  it("does not touch resolved worker runs and unknown-model matches", () => {
    const map = new Map([["pane-1", { name: "repair dotted tool names", worker: "f1" }]]);
    const rows = [{ ts: "2026-10-16T18:47:40Z", session_id: "pane-1", model: "glm-5.3-flash", provider: "glm" }];
    expect(withWorkerAttribution(map, rows, windows).get("pane-1")).toEqual({ name: "repair dotted tool names", worker: "f1" });
    const stray = [{ ts: "2026-10-16T18:47:40Z", session_id: "stray", model: "glimmer-30b", provider: "glm" }];
    expect(withWorkerAttribution(new Map(), stray, windows).has("stray")).toBe(false);
  });

  it("attributed entries do not mutate the cached input map", () => {
    const map = new Map<string, { name: string }>();
    const rows = [{ ts: "2026-10-16T18:47:40Z", session_id: "one-shot", model: "glm-5.3-flash", provider: "glm" }];
    withWorkerAttribution(map as never, rows, windows);
    expect(map.size).toBe(0);
  });

  it("windows without a parseable start are skipped", () => {
    const empty = mkdtempSync(join(tmpdir(), "sess-win2-"));
    writeFileSync(join(empty, "bad.status"), JSON.stringify({ id: "b", label: "no start", state: "done" }));
    expect(loadWorkerWindows({ workerDirs: [empty], agentSessionsFile: join(empty, "none.json") })).toHaveLength(0);
  });
});

describe("worker windows: type shape", () => {
  it("exposes label, verdict and window bounds", () => {
    const w: WorkerWindow = { worker: "w", label: "l", startMs: 0, endMs: 1 };
    expect(w.label).toBe("l");
  });
});
