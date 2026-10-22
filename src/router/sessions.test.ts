import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobSessionName, loadSessionMap, loadSessionMapSteps, loadWorkerWindowsSteps, resolveSessionName, runSliced, withJobNames, loadWorkerWindows, sessionDisplayName, withWorkerAttribution, withWorkerAttributionSteps, type SessionInfo, type WorkerWindow } from "./sessions.js";

const execGit = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

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

describe("worker verdict: an escalated run shows where it went", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-escal-"));
  const base = { state: "failed", rc: 143, started: "2026-10-21 05:17:38" };
  writeFileSync(join(dir, "esc.status"), JSON.stringify({ ...base, id: "w1", claudeSession: "c-1", escalated: "escalated t2→t1: loop-guard stop", escalatedTo: "20261021-051809-87842", commits: 2 }));
  writeFileSync(join(dir, "esc0.status"), JSON.stringify({ ...base, id: "w2", claudeSession: "c-2", escalated: "escalated t1→t0: loop-guard stop" }));
  writeFileSync(join(dir, "plain.status"), JSON.stringify({ ...base, id: "w3", claudeSession: "c-3" }));
  const map = loadSessionMap({ workerDirs: [dir], agentSessionsFile: join(dir, "none.json") });

  it("escalatedTo names the run it handed to, with commits when counted", () => {
    expect(map.get("c-1")?.verdict).toBe("escalated → 20261021-051809-87842 · 2 commits");
  });
  it("a t1→t0 escalation with no escalatedTo reads handed to session", () => {
    expect(map.get("c-2")?.verdict).toBe("handed to session");
  });
  it("a plain failure stays failed", () => {
    expect(map.get("c-3")?.verdict).toBe("failed");
  });
});

describe("worker verdict: an escalated run counts the commits its status never recorded", () => {
  // a killed run ends before the record path writes `commits`; its work lives
  // on the branch (which outlives `pai worker merge`) or under refs/pai-archive
  const repo = mkdtempSync(join(tmpdir(), "sess-esc-repo-"));
  execGit(repo, ["init", "-q"]);
  execGit(repo, ["config", "user.email", "t@example.invalid"]);
  execGit(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "seed.txt"), "seed");
  execGit(repo, ["add", "seed.txt"]);
  execGit(repo, ["commit", "-q", "-m", "seed"]);
  const base = execGit(repo, ["rev-parse", "HEAD"]);
  execGit(repo, ["checkout", "-q", "-b", "worker/w1", base]);
  writeFileSync(join(repo, "a.txt"), "a");
  execGit(repo, ["add", "a.txt"]);
  execGit(repo, ["commit", "-q", "-m", "escalated work"]);
  execGit(repo, ["update-ref", "refs/pai-archive/w1-branch", execGit(repo, ["rev-parse", "worker/w1"])]);
  execGit(repo, ["checkout", "-q", "--detach", base]);
  execGit(repo, ["branch", "-D", "worker/w1"]);
  const dir = mkdtempSync(join(tmpdir(), "sess-esc-status-"));
  const killed = { state: "failed", rc: 143, started: "2026-10-21 05:17:38", cwd: repo, worktreeBase: base, escalated: "escalated t2→t1: loop-guard stop", escalatedTo: "w2" };
  writeFileSync(join(dir, "esc.status"), JSON.stringify({ ...killed, id: "w1", claudeSession: "c-1" }));
  writeFileSync(join(dir, "esc0.status"), JSON.stringify({ ...killed, id: "w0", claudeSession: "c-2" }));
  const map = loadSessionMap({ workerDirs: [dir], agentSessionsFile: join(dir, "none.json") });

  it("commits 1 from the archive ref the branch left behind", () => {
    expect(map.get("c-1")?.verdict).toBe("escalated → w2 · 1 commit");
  });
  it("no commits to count reads no suffix", () => {
    expect(map.get("c-2")?.verdict).toBe("escalated → w2");
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

describe("display-name precedence: a session's own name beats its project slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-prec-"));
  const jobs = join(dir, "jobs");
  const job = (id8: string, name: string) => {
    mkdirSync(join(jobs, id8), { recursive: true });
    writeFileSync(join(jobs, id8, "state.json"), JSON.stringify({ name }));
  };
  job("224db3e0", "PAI (4)");
  job("3333aaaa", "Job A");
  job("4444bbbb", "Job B");
  job("5555cccc", "Job C");
  job("6666dddd", "Job D");
  const ab = join(dir, "ab");
  mkdirSync(ab);
  writeFileSync(join(ab, "session-names.json"), JSON.stringify({ U1: "AIBroker Name", U2: "AIBroker B", U3: "AIBroker C" }));
  writeFileSync(join(dir, "claude-map.json"), JSON.stringify({ "3333aaaa-1": { uid: "u1" }, "4444bbbb-1": { uid: "u2" }, "5555cccc-1": { uid: "u3" } }));
  writeFileSync(join(dir, "w.status"), JSON.stringify({ id: "w1", label: "worker label", state: "done", rc: 0, claudeSession: "6666dddd-1" }));
  // every session gets the project slug — the bug: an entry existed, so the job-name lookup never ran
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ "224db3e0-bafb-4bf7-bc09-2c63f6ab8e19": "pai", "3333aaaa-1": "pai", "4444bbbb-1": "pai", "5555cccc-1": "pai", "6666dddd-1": "pai" }));
  const src = { workerDirs: [dir], agentSessionsFile: join(dir, "agents.json"), claudeMapFile: join(dir, "claude-map.json"), aibrokerDir: ab, jobsDir: jobs };

  it("agent-sessions 'pai' plus a job name shows the job name; the slug stays as project", () => {
    const map = loadSessionMap(src);
    expect(sessionDisplayName("224db3e0-bafb-4bf7-bc09-2c63f6ab8e19", map, jobs)).toBe("PAI (4)");
    expect(map.get("224db3e0-bafb-4bf7-bc09-2c63f6ab8e19")).toMatchObject({ project: "pai" });
  });

  it("an AIBroker name beats the job name and the slug", () => {
    const map = loadSessionMap(src);
    expect(sessionDisplayName("3333aaaa-1", map, jobs)).toBe("AIBroker Name");
    expect(map.get("3333aaaa-1")).toMatchObject({ project: "pai", aibroker: true });
  });

  it("a worker id keeps its label over job name and slug", () => {
    const map = loadSessionMap(src);
    expect(sessionDisplayName("6666dddd-1", map, jobs)).toBe("worker label");
    expect(map.get("6666dddd-1")).toMatchObject({ worker: "w1", project: "pai" });
  });

  it("only agent-sessions stays 'pai' as today", () => {
    writeFileSync(join(dir, "only.json"), JSON.stringify({ "8888ffff-1": "pai" }));
    const only = loadSessionMap({ ...src, agentSessionsFile: join(dir, "only.json") });
    expect(sessionDisplayName("8888ffff-1", only, jobs)).toBe("pai");
    expect(sessionDisplayName("7777eeee-1", only, jobs)).toBeNull();
  });

  it("withJobNames resolves ids the map carries only as a slug, and never relabels a named session", () => {
    const map = loadSessionMap(src);
    const named = withJobNames(map, ["4444bbbb-1", "5555cccc-1"], jobs);
    expect(named.get("4444bbbb-1")).toMatchObject({ name: "AIBroker B", project: "pai" });
    expect(named.get("5555cccc-1")).toMatchObject({ name: "AIBroker C", project: "pai" });
    expect(named.get("224db3e0-bafb-4bf7-bc09-2c63f6ab8e19")).toBe(map.get("224db3e0-bafb-4bf7-bc09-2c63f6ab8e19"));
  });

  it("resolveSessionName: worker and AIBroker entries stand; a slug-only entry takes the job name", () => {
    const worker: SessionInfo = { name: "worker label", worker: "w1", project: "pai" };
    expect(resolveSessionName("x", worker, () => "Job X")).toBe(worker);
    const named: SessionInfo = { name: "AIBroker Name", project: "pai", aibroker: true };
    expect(resolveSessionName("x", named, () => "Job X")).toBe(named);
    expect(resolveSessionName("x", { name: "pai", project: "pai" }, () => "Job X")).toEqual({ name: "Job X", project: "pai" });
    expect(resolveSessionName("x", undefined, () => "Job X")).toEqual({ name: "Job X" });
    expect(resolveSessionName("x", undefined, () => null)).toBeUndefined();
  });

  it("time attribution does not relabel a session an AIBroker name already tops", () => {
    const windows: WorkerWindow[] = [
      { worker: "f1", label: "worker label", provider: "glm", model: "glm-5.3-flash", startMs: Date.parse("2026-10-16T18:46:00Z"), endMs: Date.parse("2026-10-16T18:49:00Z"), state: "done" },
    ];
    const rows = [{ ts: "2026-10-16T18:47:40Z", session_id: "3333aaaa-1", model: "glm-5.3-flash", provider: "glm" }];
    const map = loadSessionMap(src);
    expect(withWorkerAttribution(map, rows, windows).get("3333aaaa-1")).toMatchObject({ name: "AIBroker Name" });
  });
});

describe("sliced loaders give the same result as the one-shot ones and hand the loop back", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-sliced-"));
  const started = "2026-10-20 10:00:00";
  for (let i = 0; i < 60; i++) writeFileSync(join(dir, `w${i}.status`), JSON.stringify({ id: `w${i}`, label: `task ${i}`, state: "done", rc: 0, started, updated: "2026-10-20 10:30:00", claudeSession: `c-${i}`, model: "m", provider: "p" }));
  const src = { workerDirs: [dir], agentSessionsFile: join(dir, "none.json") };
  const rows = Array.from({ length: 5000 }, (_, i) => ({ ts: "2026-10-20T08:15:00.000Z", session_id: `one-shot-${i % 40}`, model: "m", provider: "p" }));

  it("session map, worker windows and attribution match", async () => {
    expect(await runSliced(loadSessionMapSteps(src), 0)).toEqual(loadSessionMap(src));
    const windows = loadWorkerWindows(src, 1);
    expect(await runSliced(loadWorkerWindowsSteps(src, 1), 0)).toEqual(windows);
    const map = loadSessionMap(src);
    expect(await runSliced(withWorkerAttributionSteps(map, rows, windows), 0)).toEqual(withWorkerAttribution(map, rows, windows));
  });

  it("a sliced run lets timers fire in between", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await runSliced(withWorkerAttributionSteps(new Map(), rows.concat(rows, rows, rows), loadWorkerWindows(src, 1)), 0);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("branchCommits", () => {
  it("counts the branch's commits and memoises per run for the TTL", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { branchCommits, clearBranchCommitsCache } = await import("./sessions.js");
    const repo = mkdtempSync(join(tmpdir(), "pai-bc-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("switch", "-q", "-c", "w");
    git("commit", "-q", "--allow-empty", "-m", "one");
    const base = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();
    const s = { cwd: repo, id: "r1", worktreeBase: base, branch: "w" };
    clearBranchCommitsCache();
    expect(branchCommits(s, 1000)).toBe(1);
    git("commit", "-q", "--allow-empty", "-m", "two");
    expect(branchCommits(s, 2000)).toBe(1);
    expect(branchCommits(s, 1000 + 31_000)).toBe(2);
    expect(branchCommits({ ...s, id: "none", branch: "" }, 1000)).toBeNull();
  });

  it("drops expired entries when a new key is stored", async () => {
    const { branchCommits, branchCommitsCacheSize, clearBranchCommitsCache } = await import("./sessions.js");
    clearBranchCommitsCache();
    const run = (id: string) => ({ cwd: tmpdir(), id, worktreeBase: "x", branch: "w" });
    branchCommits(run("a"), 1000);
    branchCommits(run("b"), 2000);
    expect(branchCommitsCacheSize()).toBe(2);
    branchCommits(run("c"), 31_500);
    expect(branchCommitsCacheSize()).toBe(2);
    branchCommits(run("d"), 32_500);
    expect(branchCommitsCacheSize()).toBe(2);
    clearBranchCommitsCache();
  });
});
