import { describe, it, expect } from "vitest";
import { resolveHostSession, resumeParentIdOf, type HostDeps } from "./pane.js";
import { callerIdentity } from "./caller-identity.js";

// Forked/resumed session: claude (200) runs under a pty host (150) spawned by a shared claude daemon (100),
// which was started by another window's claude (50, the foreground job of iTerm session OTHER).
const procs: Record<number, [number, string, string]> = {
  300: [200, "??", "bash"],
  200: [150, "ttys014", "claude --session-id dc02a88c-ee72-486c-aa97-ae0757d02459 --fork-session"],
  150: [100, "??", "claude --bg-pty-host /tmp/d/pty/dc02a88c.sock 96 42 -- claude"],
  100: [50, "??", "claude daemon run --origin transient"],
  50: [10, "ttys012", "claude --name Webseiten"],
  10: [1, "ttys012", "login"],
};
const deps: HostDeps = {
  psOf: (pid) => (procs[pid] ? [procs[pid][0], procs[pid][1]] : null),
  commandsOf: (pids) => new Map(pids.filter((p) => procs[p]).map((p) => [p, procs[p][2]])),
  listSessions: async () => [
    { id: "OTHER", tty: "/dev/ttys012", jobPid: 50 },
    { id: "ARCHIWARE", tty: "/dev/ttys002", jobPid: 68435 },
  ],
  attachClients: () => [],
  daemonClients: () => [{ pid: 777, tty: "ttys002" }],
};

describe("resolveHostSession after resume/fork", () => {
  it("does not take the window that started the shared daemon", async () => {
    const r = await resolveHostSession({}, deps, 300);
    expect(r.uid).not.toBe("OTHER");
    expect(r.uid).toBe("ARCHIWARE");
  });

  it("still matches the foreground job below the pty host", async () => {
    const r = await resolveHostSession({}, { ...deps, listSessions: async () => [{ id: "MINE", tty: "/dev/ttys014", jobPid: 200 }] }, 300);
    expect(r).toMatchObject({ uid: "MINE", via: "foreground jobPid" });
  });
});

const P = "11111111-2222-4333-8444-555555555555";
const F = "dc02a88c-ee72-486c-aa97-ae0757d02459";
const forgeProcs: Record<number, [number, string, string]> = {
  ...procs,
  200: [150, "ttys014", `claude --session-id ${F} --fork-session --resume /tmp/x/projects/p/${P}.jsonl`],
};
const forkDeps = (map: Record<string, string>, extra: Partial<HostDeps> = {}): HostDeps => ({
  ...deps,
  psOf: (pid) => (forgeProcs[pid] ? [forgeProcs[pid][0], forgeProcs[pid][1]] : null),
  commandsOf: (pids) => new Map(pids.filter((p) => forgeProcs[p]).map((p) => [p, forgeProcs[p][2]])),
  listSessions: async () => [
    { id: "OTHER", tty: "/dev/ttys012", jobPid: 50 },
    { id: "MINE", tty: "/dev/ttys099", jobPid: 4242 },
  ],
  daemonClients: () => [{ pid: 777, tty: "ttys002" }, { pid: 778, tty: "ttys003" }],
  mapHost: (cid) => map[cid] ?? "",
  ...extra,
});

describe("resolveHostSession fork resolution", () => {
  it("uses the resume parent's map entry", async () => {
    const r = await resolveHostSession({}, forkDeps({ [F]: "", [P]: "MINE" }), 300);
    expect(r.uid).toBe("MINE");
    expect(r.via).toContain("parent");
  });

  it("takes the spawner window's own fork entry via the parent", async () => {
    const r = await resolveHostSession({}, forkDeps({ [P]: "OTHER" }), 300);
    expect(r.uid).toBe("OTHER");
    expect(r.via).toContain("map (parent");
  });

  it("skips inherited env under a pty host and stays unresolved", async () => {
    const env = { TERM_SESSION_ID: "w0t0p0:OTHER", ITERM_SESSION_ID: "w0t0p0:OTHER" };
    const r = await resolveHostSession(env, forkDeps({}), 300);
    expect(r.uid).toBe("");
    expect(r.uid).not.toBe("OTHER");
    expect(r.reason).toMatch(/env: .*skipped/);
  });
});

describe("resumeParentIdOf", () => {
  it("parses the resume forms", () => {
    expect(resumeParentIdOf(`claude --resume ${P}`)).toBe(P);
    expect(resumeParentIdOf(`claude --resume=${P}`)).toBe(P);
    expect(resumeParentIdOf(`claude --resume /tmp/x/projects/p/${P}.jsonl --fork-session`)).toBe(P);
    expect(resumeParentIdOf(`claude --session-id ${F} --fork-session`)).toBeUndefined();
  });
});

describe("callerIdentity term resolution", () => {
  const claudeDir = "/nonexistent-claude-dir";
  it("uses ITERM_SESSION_ID and never calls the resolver", async () => {
    let called = 0;
    const r = await callerIdentity(
      { ITERM_SESSION_ID: "w0t0p0:MINE", TERM_SESSION_ID: "w0t0p0:OTHER" },
      { claudeDir, daemonHosted: () => true, resolveHost: async () => { called++; return { uid: "X" }; } },
    );
    expect(r.term).toBe("MINE");
    expect(called).toBe(0);
  });
  it("daemon-hosted: term comes from resolveHost, not the inherited TERM_SESSION_ID", async () => {
    const r = await callerIdentity({ TERM_SESSION_ID: "w0t0p0:OTHER" }, { claudeDir, daemonHosted: () => true, resolveHost: async () => ({ uid: "MINE" }) });
    expect(r.term).toBe("MINE");
  });
  it("daemon-hosted with unresolved host: term is empty, never the inherited one", async () => {
    const r = await callerIdentity({ TERM_SESSION_ID: "w0t0p0:OTHER" }, { claudeDir, daemonHosted: () => true, resolveHost: async () => ({ uid: "" }) });
    expect(r.term).toBe("");
  });
  it("not daemon-hosted: term is the TERM_SESSION_ID suffix", async () => {
    const r = await callerIdentity({ TERM_SESSION_ID: "w0t0p0:JOB" }, { claudeDir, daemonHosted: () => false, resolveHost: async () => ({ uid: "X" }) });
    expect(r.term).toBe("JOB");
  });
});

describe("start failures are visible (2026-11-26 detached starts)", () => {
  it("resolveHostSession retries a failed session listing instead of reading it as no live session", async () => {
    let calls = 0;
    const d: HostDeps = {
      ...deps,
      sleep: async () => undefined,
      listSessions: async () => {
        if (++calls <= 2) throw new Error("osascript timed out after 5000 ms");
        return [{ id: "MINE", tty: "/dev/ttys014", jobPid: 200 }];
      },
    };
    const h = await resolveHostSession({}, d, 300);
    expect(calls).toBe(3);
    expect(h.uid).toBe("MINE");
  });

  it("recordStartFailure keeps the error in status and <id>.log; supervision quotes it", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveStatus, loadStatus, recordStartFailure } = await import("./status.js");
    const { detectSupervisionEvents } = await import("./supervision.js");
    const dir = mkdtempSync(join(tmpdir(), "startfail-"));
    const s = { id: "W1", pid: 1, state: "running", started: "2026-11-26 23:09:24", updated: "2026-11-26 23:09:41", turns: 0, tools: 0, last: "starting", rc: null, secs: null, label: "x", provider: "anthropic", model: "sonnet", cwd: dir, term: "", spawnerSession: "own" } as never;
    saveStatus(dir, s);
    recordStartFailure(dir, "W1", new Error("no pane: ITERM_SESSION_ID names X, which is not a live iTerm2 session"));
    const after = loadStatus(dir, "W1")!;
    expect(after.state).toBe("failed");
    expect(after.rc).toBe(1);
    expect(after.startError).toMatch(/not a live iTerm2 session/);
    expect(readFileSync(join(dir, "W1.log"), "utf8")).toMatch(/failed to start: no pane/);
    const ev = await detectSupervisionEvents([after], { stallMs: 600_000, now: new Date(), isAlive: () => false });
    expect(ev[0].text).toMatch(/failed rc=1 \(no pane: ITERM_SESSION_ID/);
  });
});
