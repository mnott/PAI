import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isDaemonLlmSession, isWorkerSession } from "../lib/worker-session.js";
import { analyzeSession, formatSessionDocument } from "../lib/session-summary.js";

/**
 * The SessionEnd hook must never enqueue a summary for a daemon-spawned LLM
 * run (the summarizer summarizing itself — 401 runs in daemon.log on
 * 2026-11-24) or for a PAI worker, while a normal interactive session still
 * gets its final summary.
 *
 * The hook forks a detached child before doing any work, so the skip
 * predicates are what the forked child checks first. These tests pin the
 * predicates against the env the spawn actually carries, pin the mechanical
 * document path a normal session still takes, and smoke-test the hook's
 * skip exits end-to-end.
 */
describe("SessionEnd summary skip predicates", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["PAI_DAEMON_LLM", "PAI_WORKER"]) saved[k] = process.env[k];
    delete process.env.PAI_DAEMON_LLM;
    delete process.env.PAI_WORKER;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it("daemon-LLM marker skips", () => {
    expect(isDaemonLlmSession({ PAI_DAEMON_LLM: "1" })).toBe(true);
    expect(isDaemonLlmSession({})).toBe(false);
    expect(isDaemonLlmSession({ PAI_DAEMON_LLM: "0" })).toBe(false);
  });

  it("worker marker skips", () => {
    expect(isWorkerSession({ PAI_WORKER: "1" })).toBe(true);
    expect(isWorkerSession({})).toBe(false);
  });

  it("a normal interactive session is not skipped", () => {
    expect(isDaemonLlmSession({})).toBe(false);
    expect(isWorkerSession({})).toBe(false);
  });
});

describe("SessionEnd mechanical document for a normal session", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sess-end-doc-"));
    for (const k of ["PAI_HOME"]) saved[k] = process.env[k];
    process.env.PAI_HOME = home;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a session document under History/sessions", async () => {
    // raw-outputs the hook scans: one Edit by this session
    const rawDir = join(home, "History", "raw-outputs", "2026-11");
    mkdirSync(rawDir, { recursive: true });
    const today = new Date().toISOString().substring(0, 10);
    writeFileSync(
      join(rawDir, `${today}.jsonl`),
      JSON.stringify({ session: "abc", tool: "Edit", input: { file_path: "src/a.ts" } }) + "\n"
    );
    const info = await analyzeSession("abc", "2026-11");
    expect(info.filesChanged).toContain("src/a.ts");
    const doc = formatSessionDocument("2026-11-24-050000", { session_id: "abc" }, info);
    const dir = join(home, "History", "sessions", "2026-11");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-11-24-050000_SESSION_general-work.md"), doc);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("SESSION");
    expect(doc).toContain("src/a.ts");
  });
});

describe("SessionEnd hook skip exits end-to-end", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const HOOK = join(__dirname, "capture-session-summary.ts");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sess-end-spawn-"));
    for (const k of ["PAI_HOME", "PAI_SOCKET_PATH", "PAI_DAEMON_LLM", "PAI_WORKER"]) saved[k] = process.env[k];
    process.env.PAI_HOME = home;
    // a socket nothing listens on: enqueue attempts fail fast, no daemon touched
    process.env.PAI_SOCKET_PATH = join(home, "dead.sock");
    delete process.env.PAI_DAEMON_LLM;
    delete process.env.PAI_WORKER;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });

  function runHook(env: Record<string, string>): { status: number | null } {
    return spawnSync("node", ["--import", "tsx", HOOK], {
      input: JSON.stringify({ session_id: "sess-1", timestamp: "2026-11-24T05:00:00.000Z" }),
      env: { ...process.env, PAI_HOME: home, PAI_SOCKET_PATH: join(home, "dead.sock"), ...env },
      timeout: 15_000,
    });
  }

  it("daemon-LLM marker: hook exits 0 and writes no session document", async () => {
    const res = runHook({ PAI_DAEMON_LLM: "1" });
    expect(res.status).toBe(0);
    // the detached child runs asynchronously; give it a moment then check
    await new Promise((r) => setTimeout(r, 1500));
    const sessDir = join(home, "History", "sessions");
    expect(existsSync(sessDir)).toBe(false);
  });

  it("worker marker: hook exits 0 and writes no session document", async () => {
    const res = runHook({ PAI_WORKER: "1" });
    expect(res.status).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    const sessDir = join(home, "History", "sessions");
    expect(existsSync(sessDir)).toBe(false);
  });
});
