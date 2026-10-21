import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobSessionName, loadSessionMap, withJobNames, loadWorkerWindows, sessionDisplayName, withWorkerAttribution, type WorkerWindow } from "./sessions.js";

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

describe("worker verdict: flagged report is not a failed run", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-verdict-"));
  const base = { state: "done", rc: 0, started: "2026-10-20 10:00:00" };
  writeFileSync(join(dir, "flagged.status"), JSON.stringify({ ...base, id: "w1", claudeSession: "c-1", reportValid: false, commits: 1 }));
  writeFileSync(join(dir, "rc1.status"), JSON.stringify({ ...base, id: "w2", rc: 1, claudeSession: "c-2" }));
  writeFileSync(join(dir, "failed.status"), JSON.stringify({ id: "w3", state: "failed", rc: 0, claudeSession: "c-3" }));
  writeFileSync(join(dir, "valid.status"), JSON.stringify({ ...base, id: "w4", claudeSession: "c-4", reportValid: true }));
  const map = loadSessionMap({ workerDirs: [dir], agentSessionsFile: join(dir, "none.json") });

  it("done + rc 0 + reportValid false is a warn verdict, not failed", () => {
    expect(map.get("c-1")?.verdict).toBe("done · report flagged · 1 commit");
  });
  it("rc 1 and state failed stay failed", () => {
    expect(map.get("c-2")?.verdict).toBe("failed");
    expect(map.get("c-3")?.verdict).toBe("failed");
  });
  it("done + valid report is ok", () => {
    expect(map.get("c-4")?.verdict).toBe("ok");
  });
});

describe("session mapper: stagger warm-up wait", () => {
  it("shows a gated run as waiting (warm-up), a plain running one as running", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const base = { label: "x", state: "running", started: "2026-10-17 10:00:00", provider: "local30x8" };
    const warmup = { for: "w0", provider: "local30x8", elapsedSec: 7, limitSec: 12 };
    writeFileSync(join(dir, "w1.status"), JSON.stringify({ ...base, id: "w1", claudeSession: "c-1", warmup }));
    writeFileSync(join(dir, "w2.status"), JSON.stringify({ ...base, id: "w2", claudeSession: "c-2" }));
    const src = { workerDirs: [dir], agentSessionsFile: join(dir, "agents.json") };
    const map = loadSessionMap(src);
    expect(map.get("c-1")?.verdict).toBe("waiting (warm-up) 7s/12s");
    expect(map.get("c-2")?.verdict).toBe("running");
    const wins = loadWorkerWindows(src);
    expect(wins.find((w) => w.worker === "w1")?.verdict).toBe("waiting (warm-up) 7s/12s");
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

describe("AIBroker session names", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-ab-"));
  const ab = join(dir, "aibroker");
  mkdirSync(ab);
  writeFileSync(join(ab, "managers.json"), JSON.stringify({ "UID-1": { sessionId: "UID-1", name: "PAI" }, "UID-2": { name: "Chosen" } }));
  writeFileSync(join(ab, "session-names.json"), JSON.stringify({ "uid-2": "Operator Name" }));
  writeFileSync(join(dir, "claude-map.json"), JSON.stringify({ "c-1": { uid: "uid-1" }, "c-2": { uid: "UID-2" }, "c-w": { uid: "UID-1" }, "c-x": { uid: "UID-9" } }));
  writeFileSync(join(dir, "w.status"), JSON.stringify({ id: "w1", label: "worker label", state: "done", rc: 0, claudeSession: "c-w" }));
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ "c-1": "proj", "c-x": "fallback" }));
  const base = { workerDirs: [dir], agentSessionsFile: join(dir, "agents.json"), claudeMapFile: join(dir, "claude-map.json") };

  it("a known Claude session id shows the AIBroker name; worker label and unknown ids are unchanged", () => {
    const map = loadSessionMap({ ...base, aibrokerDir: ab });
    expect(sessionDisplayName("c-1", map)).toBe("PAI");
    expect(sessionDisplayName("c-2", map)).toBe("Operator Name");
    expect(sessionDisplayName("c-w", map)).toBe("worker label");
    expect(sessionDisplayName("c-x", map)).toBe("fallback");
  });

  it("a missing or garbled AIBroker source changes nothing", () => {
    const bad = join(dir, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "managers.json"), "{not json");
    writeFileSync(join(bad, "session-names.json"), "[1,2");
    for (const aibrokerDir of [join(dir, "nope"), bad, undefined]) {
      const map = loadSessionMap({ ...base, aibrokerDir });
      expect(sessionDisplayName("c-1", map)).toBe("proj");
      expect(sessionDisplayName("c-2", map)).toBeNull();
    }
  });
});

describe("background-job session names", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobs-"));
  const jobs = join(dir, "jobs");
  const job = (id8: string, body: string) => {
    mkdirSync(join(jobs, id8), { recursive: true });
    writeFileSync(join(jobs, id8, "state.json"), body);
  };
  job("aaaaaaaa", JSON.stringify({ name: "PAI (4)", respawnFlags: { env: { TOKEN: "sekret-token" } } }));
  job("bbbbbbbb", "{not json");
  job("dddddddd", JSON.stringify({ name: "Job D" }));
  writeFileSync(join(dir, "w.status"), JSON.stringify({ id: "w1", label: "worker label", state: "done", rc: 0, claudeSession: "dddddddd-1" }));
  writeFileSync(join(dir, "agents.json"), "{}");
  const ab = join(dir, "ab");
  mkdirSync(ab);
  writeFileSync(join(ab, "session-names.json"), JSON.stringify({ U1: "Broker Name" }));
  writeFileSync(join(dir, "claude-map.json"), JSON.stringify({ "dddddddd-2": { uid: "u1" } }));
  const src = { workerDirs: [dir], agentSessionsFile: join(dir, "agents.json"), claudeMapFile: join(dir, "claude-map.json"), aibrokerDir: ab, jobsDir: jobs };

  it("an id unknown everywhere else takes the job name; the name is the only field that surfaces", () => {
    const map = loadSessionMap(src);
    expect(sessionDisplayName("aaaaaaaa-1111", map, jobs)).toBe("PAI (4)");
    const named = withJobNames(map, ["aaaaaaaa-1111"], jobs);
    expect(named.get("aaaaaaaa-1111")).toEqual({ name: "PAI (4)" });
    expect(JSON.stringify([...named])).not.toContain("sekret");
  });

  it("a worker label and an AIBroker name win over the job name", () => {
    const map = loadSessionMap(src);
    expect(sessionDisplayName("dddddddd-1", map, jobs)).toBe("worker label");
    expect(sessionDisplayName("dddddddd-2", map, jobs)).toBe("Broker Name");
  });

  it("malformed or missing state.json falls back to nothing", () => {
    const map = loadSessionMap(src);
    expect(sessionDisplayName("bbbbbbbb-1", map, jobs)).toBeNull();
    expect(sessionDisplayName("cccccccc-1", map, jobs)).toBeNull();
    expect(jobSessionName("../../x", jobs)).toBeNull();
  });

  it("a transcript-derived project name yields to the job name", () => {
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "-x-pai"), { recursive: true });
    writeFileSync(join(projects, "-x-pai", "aaaaaaaa-9999.jsonl"), "");
    const map = loadSessionMap({ ...src, projectsDir: projects });
    expect(sessionDisplayName("aaaaaaaa-9999", map, jobs)).toBe("PAI (4)");
  });
});
