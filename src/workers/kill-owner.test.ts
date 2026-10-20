/**
 * Tests for the kill ownership check: the session that spawned a worker may
 * kill it even when it runs as a Claude Code background job (no TTY, no
 * ITERM_SESSION_ID, no CLAUDE_CODE_SESSION_ID in the Bash env — the identity
 * is the spawning process chain: CLAUDE_PID == the worker's recorded parentPid,
 * or the bg-pty-host ancestor's --session-id == the recorded spawnerSession).
 * A different session must still be refused.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, type KillTreeDeps } from "./kill-tree.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

function mk(dir: string, id: string, pid: number, over: Partial<WorkerStatus> = {}): void {
  saveStatus(dir, {
    id,
    pid,
    label: id,
    cwd: "/tmp",
    term: "",
    provider: "anthropic",
    model: "m",
    state: "running",
    started: nowStamp(),
    updated: nowStamp(),
    turns: 0,
    tools: 0,
    last: "",
    rc: null,
    secs: null,
    ...over,
  } as WorkerStatus);
}

function fakes(dir: string): { deps: Partial<KillTreeDeps>; signalled: string[] } {
  const signalled: string[] = [];
  return {
    signalled,
    deps: {
      owns: () => true,
      isAlive: () => false,
      request: () => undefined,
      graceMs: 0,
      notifyOwner: async () => undefined,
      signal: (pid) => {
        signalled.push(`w${pid}`);
        const s = load(dir, `w${pid}`);
        if (s) {
          s.state = "killed"; // the run's own SIGTERM handler
          saveStatus(dir, s);
        }
      },
      waitTerminal: async (d, id) => {
        const s = load(dir, id);
        return s && s.state !== "running" && s.state !== "queued" ? s : null;
      },
    },
  };
}

function load(dir: string, id: string): WorkerStatus | null {
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.status`), "utf8")) as WorkerStatus;
  } catch {
    return null;
  }
}

const FULL = "cdd93e8d-458c-4a63-a9cf-c24488cdd6f4";
const SHORT = "cdd93e8d";
const OTHER_FULL = "224db3e0-1111-2222-3333-444444444444";

// process chain of a `pai worker kill` run from a background-job session:
// 500 (kill) -> 400 (bash, no tty) -> 400's parent 390 (claude.exe --session-id FULL --resume)
// -> 380 (bg-pty-host for SHORT) -> daemon. No tty anywhere, no ITERM_SESSION_ID.
const bgChain = new Map<number, [number, string]>([
  [500, [400, "??"]],
  [400, [390, "??"]],
  [390, [380, "??"]],
  [380, [1, "??"]],
]);
const bgCmds = {
  390: `claude.exe --session-id ${FULL} --resume`,
  380: `claude.exe --bg-pty-host /tmp/cc-daemon-501/d/pty/${SHORT}.sock`,
};
// a different background session's chain
const otherChain = new Map<number, [number, string]>([
  [500, [400, "??"]],
  [400, [391, "??"]],
  [391, [381, "??"]],
  [381, [1, "??"]],
]);
const otherCmds = {
  391: `claude.exe --session-id ${OTHER_FULL} --resume`,
  381: `claude.exe --bg-pty-host /tmp/cc-daemon-501/d/pty/${OTHER_FULL.slice(0, 8)}.sock`,
};

// no TTY, no ITERM_SESSION_ID, no session id, no session name in env
const bgEnv: NodeJS.ProcessEnv = {};

describe("kill ownership: background-job sessions", () => {
  function ownedDir(over: Partial<WorkerStatus>): string {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-bg-"));
    mk(dir, "w1", 1, over);
    return dir;
  }

  it("owner as foreground terminal may kill (unchanged behaviour)", async () => {
    const dir = ownedDir({ session: { id: "u1", name: "PAI" } });
    const f = fakes(dir);
    await killTree(dir, "w1", { deps: f.deps, caller: { env: { PAI_SESSION_NAME: "PAI" }, force: false } });
    expect(f.signalled).toEqual(["w1"]);
  });

  it("owner as background job: CLAUDE_PID == recorded parentPid -> allowed", async () => {
    const dir = ownedDir({ session: { id: "u1", name: "PAI" }, parentPid: 390, parentComm: "claude.exe" });
    const f = fakes(dir);
    await killTree(dir, "w1", {
      deps: f.deps,
      caller: { env: { ...bgEnv, CLAUDE_PID: "390" }, force: false },
      proc: { processTree: () => bgChain, pid: 500 },
    });
    expect(f.signalled).toEqual(["w1"]);
  });

  it("owner as background job: bg-pty-host ancestor's session id == spawnerSession -> allowed", async () => {
    const dir = ownedDir({ session: { id: "u1", name: "PAI" }, spawnerSession: FULL, parentPid: 400 });
    const f = fakes(dir);
    await killTree(dir, "w1", {
      deps: f.deps,
      caller: { env: bgEnv, force: false },
      proc: { processTree: () => bgChain, commands: () => new Map(Object.entries(bgCmds) as unknown as [number, string][]), pid: 500 },
    });
    expect(f.signalled).toEqual(["w1"]);
  });

  it("another background session -> refused, nothing signalled", async () => {
    const dir = ownedDir({ session: { id: "u1", name: "PAI" }, parentPid: 390, parentComm: "claude.exe", spawnerSession: FULL });
    const f = fakes(dir);
    await expect(
      killTree(dir, "w1", {
        deps: f.deps,
        caller: { env: bgEnv, force: false },
        proc: { processTree: () => otherChain, commands: () => new Map(Object.entries(otherCmds) as unknown as [number, string][]), pid: 500 },
      })
    ).rejects.toThrow("worker w1 belongs to session PAI; refused (use --force from the operator's terminal or that session)");
    expect(f.signalled).toEqual([]);
  });

  it("operator --force (no worker env) is allowed", async () => {
    const dir = ownedDir({ session: { id: "u1", name: "PAI" }, parentPid: 390, spawnerSession: FULL });
    const f = fakes(dir);
    await killTree(dir, "w1", {
      deps: f.deps,
      caller: { env: {}, force: true },
      reason: "operator cleanup",
      proc: { processTree: () => otherChain, commands: () => new Map(Object.entries(otherCmds) as unknown as [number, string][]), pid: 500 },
    });
    expect(f.signalled).toEqual(["w1"]);
  });

  it("a chain that matches no recorded identity is refused", async () => {
    const dir = ownedDir({ session: { id: "u1", name: "PAI" }, parentPid: 999, spawnerSession: OTHER_FULL });
    const f = fakes(dir);
    await expect(
      killTree(dir, "w1", {
        deps: f.deps,
        caller: { env: bgEnv, force: false },
        proc: { processTree: () => bgChain, commands: () => new Map(Object.entries(bgCmds) as unknown as [number, string][]), pid: 500 },
      })
    ).rejects.toThrow(/belongs to session PAI/);
    expect(f.signalled).toEqual([]);
  });
});
