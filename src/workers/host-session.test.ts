import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestorTty, daemonPeerPids, isDaemonHelper, lookupSessionMap, resolveHostSession, underBackgroundDaemon, type HostDeps, type ItermSession } from "./pane.js";

const LIVE = "88D76B26-0000-0000-0000-000000000001";
const DEAD = "78C67D79-0000-0000-0000-000000000002";

function deps(
  procs: Record<number, [number, string]>,
  sessions: ItermSession[],
  cmds: Record<number, string> = {},
): HostDeps {
  return {
    psOf: (pid) => procs[pid] ?? null,
    commandsOf: (pids) => new Map(pids.flatMap((p) => (p in cmds ? [[p, cmds[p]] as [number, string]] : []))),
    listSessions: async () => sessions,
  };
}

const chain = { [500]: [400, "??"], [400]: [300, "ttys004"], [300]: [1, "ttys004"] } as Record<number, [number, string]>;

describe("resolveHostSession", () => {
  it("tty match beats a stale ITERM_SESSION_ID", async () => {
    const h = await resolveHostSession(
      { ITERM_SESSION_ID: `w1t0p0:${DEAD}` },
      deps(chain, [{ id: LIVE, tty: "/dev/ttys004" }]),
      500,
    );
    expect(h).toMatchObject({ uid: LIVE, term: LIVE, via: "tty" });
  });

  it("keeps the env value as term when it names the tty session", async () => {
    const env = { ITERM_SESSION_ID: `w1t0p0:${LIVE}` };
    const h = await resolveHostSession(env, deps(chain, [{ id: LIVE, tty: "/dev/ttys004" }]), 500);
    expect(h).toMatchObject({ uid: LIVE, term: env.ITERM_SESSION_ID, via: "tty" });
  });

  it("no tty ancestor + live env id -> env id", async () => {
    const env = { ITERM_SESSION_ID: `w1t0p0:${LIVE}` };
    const h = await resolveHostSession(env, deps({ 500: [1, "??"] }, [{ id: LIVE, tty: "/dev/ttys009" }]), 500);
    expect(h).toMatchObject({ uid: LIVE, via: "env" });
  });

  it("nothing resolves -> loud reason", async () => {
    const h = await resolveHostSession(
      { ITERM_SESSION_ID: `w1t0p0:${DEAD}` },
      deps({ 500: [1, "??"] }, [{ id: LIVE, tty: "/dev/ttys009" }]),
      500,
    );
    expect(h.via).toBe("none");
    expect(h.uid).toBe("");
    expect(h.reason).toContain(`${DEAD} is not live`);
    expect(h.reason).toContain("no tty ancestor");
  });
});

// The measured background case: the real session runs under the Claude daemon, outside iTerm's tree
const SHORT = "cdd93e8d";
const FULL = `${SHORT}-458c-4a63-a9cf-c24488cdd6f4`;
const bgChain = { 75840: [6520, "ttys011"], 6520: [6488, "ttys011"], 6488: [6445, "??"], 6445: [1, "??"] } as Record<number, [number, string]>;
const bgCmds = { 6520: `claude.exe --session-id ${FULL} --resume`, 6488: `claude.exe --bg-pty-host /tmp/cc-daemon-501/d/pty/${SHORT}.sock` };
const attachSession = (id: string, jobPid: number): ItermSession => ({ id, tty: "/dev/ttys009", jobPid });

describe("resolveHostSession: background and foreground", () => {
  it("background session resolves via claude attach (id from ancestor command line)", async () => {
    const d = deps(bgChain, [attachSession(LIVE, 38664), attachSession(DEAD, 111)], { ...bgCmds, 38664: `claude attach ${SHORT}`, 111: "-zsh" });
    expect(await resolveHostSession({ ITERM_SESSION_ID: `w1t0p0:${DEAD}x` }, d, 75840)).toMatchObject({ uid: LIVE, via: `attach ${SHORT}` });
  });

  it("session id from CLAUDE_CODE_SESSION_ID, full uuid in the attach command", async () => {
    const d = deps({ 500: [1, "??"] }, [attachSession(LIVE, 38664)], { 38664: `claude attach ${FULL}` });
    expect(await resolveHostSession({ CLAUDE_CODE_SESSION_ID: FULL }, d, 500)).toMatchObject({ uid: LIVE, via: `attach ${SHORT}` });
  });

  it("foreground resolves via CLAUDE_PID", async () => {
    const d = deps({ 500: [1, "??"] }, [attachSession(LIVE, 54342), attachSession(DEAD, 111)]);
    expect(await resolveHostSession({ CLAUDE_PID: "54342" }, d, 500)).toMatchObject({ uid: LIVE, via: "foreground jobPid" });
  });

  it("foreground resolves via an ancestor pid", async () => {
    const d = deps(chain, [attachSession(LIVE, 300)]);
    expect(await resolveHostSession({}, d, 500)).toMatchObject({ uid: LIVE, via: "foreground jobPid" });
  });

  it("stale env and no match -> loud with a reason per step", async () => {
    const d = deps(bgChain, [attachSession(LIVE, 38664)], { ...bgCmds, 38664: "claude attach 11111111" });
    const h = await resolveHostSession({ ITERM_SESSION_ID: `w1t0p0:${DEAD}` }, d, 75840);
    expect(h.via).toBe("none");
    for (const part of ["foreground:", `no session runs attach ${SHORT}`, "tty: ancestor tty /dev/ttys011", `${DEAD} is not live`]) {
      expect(h.reason).toContain(part);
    }
  });

  it("two attach matches -> ambiguous, nothing picked", async () => {
    const d = deps(bgChain, [attachSession(LIVE, 38664), attachSession(DEAD, 38665)], { ...bgCmds, 38664: `claude attach ${SHORT}`, 38665: `claude attach ${SHORT}` });
    const h = await resolveHostSession({ ITERM_SESSION_ID: `w1t0p0:${LIVE}` }, d, 75840);
    expect(h).toMatchObject({ uid: "", via: "none" });
    expect(h.reason).toContain("ambiguous");
    expect(h.reason).toContain(LIVE);
    expect(h.reason).toContain(DEAD);
  });
});

describe("ancestorTty", () => {
  it("skips ?? ttys up to the first real one", () => {
    expect(ancestorTty(deps(chain, []), 500)).toBe("/dev/ttys004");
  });
  it("null when the whole chain is ??", () => {
    expect(ancestorTty(deps({ 500: [400, "??"], 400: [1, "??"] }, []), 500)).toBeNull();
  });
});

describe("resolveHostSession: bg-pty-host without a jobPid match", () => {
  const sess = [attachSession(LIVE, 900), attachSession(DEAD, 111)];
  const base = (extra: Partial<HostDeps>): HostDeps => ({ ...deps(bgChain, sess, { ...bgCmds, 900: "-zsh", 111: "-zsh" }), ...extra });

  it("resolves via the attach client's ITERM_SESSION_ID", async () => {
    const d = base({ attachClients: () => [4242], itermIdOf: (pid) => (pid === 4242 ? `w5t0p0:${LIVE}` : "") });
    expect(await resolveHostSession({}, d, 75840)).toMatchObject({ uid: LIVE, via: "attach client 4242" });
  });

  it("resolves via the one plain claude connected to the daemon (tty -> iTerm session)", async () => {
    const d = base({ daemonClients: () => [{ pid: 85322, tty: "ttys009" }] });
    expect(await resolveHostSession({}, d, 75840)).toMatchObject({ uid: LIVE, via: "daemon client pid 85322 tty /dev/ttys009" });
  });

  it("two daemon clients: ambiguous, nothing guessed", async () => {
    const d = base({ daemonClients: () => [{ pid: 2, tty: "ttys009" }, { pid: 1, tty: "ttys050" }], registryHost: () => "" });
    const h = await resolveHostSession({}, d, 75840);
    expect(h.via).toBe("none");
    expect(h.reason).toContain("daemon client: 2 clients, ambiguous");
  });

  it("no daemon client -> falls through with a reason", async () => {
    const d = base({ daemonClients: () => [], registryHost: () => "" });
    const h = await resolveHostSession({}, d, 75840);
    expect(h.via).toBe("none");
    expect(h.reason).toContain("daemon client: none connected to the daemon");
  });

  it("resolves via the AIBroker registry", async () => {
    const d = base({ attachClients: () => [], registryHost: (cid) => (cid.startsWith(SHORT) ? LIVE : "") });
    expect(await resolveHostSession({}, d, 75840)).toMatchObject({ uid: LIVE, via: "registry" });
  });

  it("nothing found -> no host, reasons listed", async () => {
    const d = base({ attachClients: () => [4242], itermIdOf: () => "", registryHost: () => "" });
    const h = await resolveHostSession({}, d, 75840);
    expect(h).toMatchObject({ uid: "", via: "none" });
    expect(h.reason).toContain("attach client:");
    expect(h.reason).toContain("registry:");
  });

  it("underBackgroundDaemon sees the bg-pty-host ancestor", () => {
    expect(underBackgroundDaemon(base({}), 75840)).toBe(true);
    expect(underBackgroundDaemon(deps(chain, [], {}), 500)).toBe(false);
  });
});

describe("resolveHostSession via the statusline session map", () => {
  const sid = FULL;
  const bgDeps = (mapped: string, sessions: ItermSession[]): HostDeps => ({
    ...deps(bgChain, sessions, bgCmds),
    mapHost: (c) => (sid.startsWith(c) ? mapped : ""),
  });

  it("resolves a live mapped uid by CLAUDE_CODE_SESSION_ID", async () => {
    const h = await resolveHostSession({ CLAUDE_CODE_SESSION_ID: sid }, bgDeps(LIVE, [{ id: LIVE, tty: "/dev/ttys001" }]), 75840);
    expect(h).toMatchObject({ uid: LIVE, via: "map" });
  });

  it("resolves by the short id from the bg-pty-host command line", async () => {
    const h = await resolveHostSession({}, bgDeps(LIVE, [{ id: LIVE, tty: "/dev/ttys001" }]), 75840);
    expect(h).toMatchObject({ uid: LIVE, via: "map" });
  });

  it("ignores a dead mapped uid and falls back, naming the map", async () => {
    const h = await resolveHostSession({ CLAUDE_CODE_SESSION_ID: sid }, bgDeps(DEAD, [{ id: LIVE, tty: "/dev/ttys011" }]), 75840);
    expect(h.via).toBe("tty");
  });

  it("no entry: reason names the map", async () => {
    const h = await resolveHostSession({ CLAUDE_CODE_SESSION_ID: sid }, bgDeps("", [{ id: LIVE, tty: "/dev/ttys099" }]), 75840);
    expect(h.via).toBe("none");
    expect(h.reason).toContain(`map: no entry for ${SHORT}`);
  });
});

describe("lookupSessionMap", () => {
  const dir = mkdtempSync(join(tmpdir(), "smap-"));
  const p = join(dir, "session-claude-map.json");
  const now = 1_800_000_000_000;
  it("returns fresh entries (full or short id), ignores stale and missing", () => {
    writeFileSync(p, JSON.stringify({ [FULL]: { uid: LIVE, ts: now - 1000 }, "ffffffff-0000": { uid: DEAD, ts: now - 8 * 24 * 3600_000 } }));
    expect(lookupSessionMap(p, FULL, now)).toBe(LIVE);
    expect(lookupSessionMap(p, SHORT, now)).toBe(LIVE);
    expect(lookupSessionMap(p, "ffffffff-0000", now)).toBe("");
    expect(lookupSessionMap(join(dir, "none.json"), FULL, now)).toBe("");
  });
});

describe("daemon control.sock peers", () => {
  const daemon = "p10\nf17\nd0xaaa1\nn->0xbbb1\nf18\nd0xaaa2\nn->0xbbb2\nf19\nd0xaaa3\nn->0xbbb3\nf20\nd0xaaa4\nn/x/control.sock\n";
  const all = "p10\nf17\nd0xaaa1\nn->0xbbb1\np85322\nf9\nd0xbbb1\nn->0xaaa1\np777\nf3\nd0xbbb2\nn->0xaaa2\np500\nf3\nd0xccc\nn->0xddd\n";

  it("maps daemon device addresses to the processes naming them as peers", () => {
    expect(daemonPeerPids(daemon, all).sort()).toEqual([777, 85322]);
  });

  it("helpers are excluded", () => {
    expect(isDaemonHelper("claude.exe --bg-pty-host /d/pty/224db3e0.sock")).toBe(true);
    expect(isDaemonHelper("claude.exe --bg-spare")).toBe(true);
    expect(isDaemonHelper("claude")).toBe(false);
  });
});
