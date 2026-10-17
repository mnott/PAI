import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { legacy } from "../lib/legacy.js";
import { readWorkerSessionIds, workerSessionFilter } from "../lib/worker-sessions.js";
import { SHELL_INIT } from "../lib/shell-init.js";
import { makeStyle } from "../help.js";
import { GROUPS } from "../registry.js";
import { runCli, type Io } from "../run.js";
import type { CommandDef } from "../define.js";

const calls = vi.hoisted(() => ({
  launch: [] as unknown[],
  pause: [] as unknown[],
  pauseAll: [] as unknown[],
  checkpoint: [] as unknown[],
  autosave: [] as unknown[],
  cleanup: [] as unknown[],
  hookBoom: false,
}));

vi.mock("./lifecycle/launch.js", () => ({ runLaunch: async (args: string[], opts: unknown) => void calls.launch.push([args, opts]) }));
vi.mock("./session/pause.js", () => ({
  cmdPause: async (o: unknown) => {
    calls.pause.push(o);
    process.exitCode = 1;
  },
}));
vi.mock("./session/pause-all.js", () => ({ cmdPauseAll: async (o: unknown) => void calls.pauseAll.push(o) }));
vi.mock("./session/checkpoint.js", () => ({ cmdCheckpoint: (m: string, o: unknown) => void calls.checkpoint.push([m, o]) }));
vi.mock("./session/autosave.js", () => ({ cmdAutosave: async (o: unknown) => void calls.autosave.push(o) }));
vi.mock("./session-cleanup/cleanup.js", () => ({ runCleanup: async (s: unknown, o: unknown) => void calls.cleanup.push([s, o]) }));
vi.mock("../../storage/factory.js", () => ({
  getRegistryBackend: async () => {
    if (calls.hookBoom) throw new Error("registry down");
    return {
      getProjectBySlug: async () => {
        throw new Error("lookup failed");
      },
    };
  },
}));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), style: makeStyle(false) };
  return { io, out, err };
}
const run = (argv: string[]) => {
  const c = capture();
  return runCli(GROUPS, argv, c.io).then((code) => ({ code, out: c.out.join("\n"), err: c.err.join("\n") }));
};

beforeEach(() => {
  for (const k of ["launch", "pause", "pauseAll", "checkpoint", "autosave", "cleanup"] as const) calls[k].length = 0;
  calls.hookBoom = false;
  process.exitCode = undefined;
});

const walk = (c: CommandDef, path: string[] = [c.name]): Array<[string[], CommandDef]> => [
  [path, c],
  ...(c.subcommands ?? []).flatMap((s) => walk(s, [...path, s.name])),
];

describe("every ported command is documented", () => {
  const names = ["pause", "end", "resume", "clear-names", "sessions", "cd", "notes", "list", "find", "shell-init", "launch", "backup", "restore", "update", "setup", "install", "hooks-db", "session"];
  const all = GROUPS.flatMap((g) => g.commands);
  it("registers every top-level name", () => {
    for (const n of names) {
      const cmd = all.find((c) => c.name === n);
      expect(cmd, n).toBeDefined();
    }
  });
  it("has a one-line summary, a description and 2+ examples on every command and subcommand", () => {
    for (const n of names) {
      for (const [path, c] of walk(all.find((x) => x.name === n)!)) {
        if (path.length === 1 && c.subcommands && n === "session") continue; // the group itself is the foundation's
        expect(c.summary.includes("\n"), path.join(" ")).toBe(false);
        expect(c.description.length, path.join(" ")).toBeGreaterThan(10);
        expect(c.examples.length, path.join(" ")).toBeGreaterThanOrEqual(2);
      }
    }
  });
  it("keeps every old session subcommand", () => {
    const sub = (all.find((c) => c.name === "session")!.subcommands ?? []).map((s) => s.name);
    for (const n of ["list", "restore", "info", "rename", "slug", "tag", "route", "handover", "checkpoint", "autosave", "active", "recent", "goto", "pause", "auto-route", "cleanup"]) {
      expect(sub).toContain(n);
    }
    const plural = (all.find((c) => c.name === "sessions")!.subcommands ?? []).map((s) => s.name);
    for (const n of ["list", "goto", "pause", "pause-all", "end", "info", "rename", "slug", "tag", "route", "handover", "checkpoint", "active", "clear-names", "auto-route"]) {
      expect(plural).toContain(n);
    }
  });
});

describe("legacy exit-code bridge", () => {
  it("returns what the old command put in process.exitCode, then clears it", async () => {
    expect(await legacy(() => void (process.exitCode = 1))).toBe(1);
    expect(process.exitCode).toBeUndefined();
    expect(await legacy(async () => {})).toBe(0);
  });
});

describe("pause / end / launch argument handling", () => {
  it("pause passes the checkpoint flags through and returns the old exit code", async () => {
    const r = await run(["pause", "--dry-run", "--no-body", "--session-id", "abc", "--body-file", "x.md"]);
    expect(calls.pause).toEqual([{ dryRun: true, bodyFile: "x.md", sessionId: "abc", noBody: true }]);
    expect(r.code).toBe(1);
  });
  it("pause all forwards exit, only and wait to the pause-all command", async () => {
    const r = await run(["pause", "all", "--exit", "--only", "api", "--wait", "500", "--dry-run"]);
    expect(calls.pauseAll).toEqual([{ exit: true, dryRun: true, only: "api", wait: 500 }]);
    expect(r.code).toBe(0);
  });
  it("pause with an unknown target fails with a plain sentence and the next command, exit 1", async () => {
    const r = await run(["pause", "everything"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Unknown target: everything");
    expect(r.err).toContain("Next: pai pause all");
  });
  it("launch hands everything after -- to claude unchanged", async () => {
    await run(["launch", "--provider", "glm", "--dry-run", "--", "--resume", "id1"]);
    expect(calls.launch).toEqual([[["--resume", "id1"], { provider: "glm", model: undefined, list: false, current: false, dryRun: true }]]);
  });
  it("session autosave and checkpoint keep their flags (numbers become the old strings)", async () => {
    await run(["session", "autosave", "--session-id", "u1", "--min-gap", "30", "--dry-run"]);
    expect(calls.autosave).toEqual([{ sessionId: "u1", minGap: "30", dryRun: true }]);
    await run(["session", "checkpoint", "did a thing", "--min-gap", "5"]);
    expect(calls.checkpoint).toEqual([["did a thing", { minGap: "5" }]]);
  });
  it("session cleanup is a preview unless --execute is given", async () => {
    await run(["session", "cleanup", "proj", "--no-reindex"]);
    expect(calls.cleanup).toEqual([["proj", { execute: false, renumber: true, reindex: false }]]);
  });
});

describe("hooks-db always exits 0", () => {
  it("swallows a lookup failure", async () => {
    expect((await run(["hooks-db", "session-stop", "slug"])).code).toBe(0);
    expect((await run(["hooks-db", "pre-compact", "slug"])).code).toBe(0);
  });
  it("swallows a registry that cannot open", async () => {
    calls.hookBoom = true;
    expect((await run(["hooks-db", "session-stop", "slug"])).code).toBe(0);
  });
});

describe("shell-init", () => {
  it("is the shell wrapper the old CLI printed", () => {
    expect(SHELL_INIT.startsWith("# PAI shell integration — generated by: pai shell-init\npai() {\n")).toBe(true);
    expect(SHELL_INIT).toContain('command pai cd "$2" 2>/dev/null');
    expect(SHELL_INIT).toContain("PAI_PICK_OUT");
    expect(SHELL_INIT.endsWith("  return $__pai_rc\n}\n")).toBe(true);
  });
});

describe("worker sessions are recognised", () => {
  it("reads conversation ids from worker status files and flags worker worktrees", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-workers-"));
    writeFileSync(join(dir, "20260101-000000-1.status"), JSON.stringify({ id: "x", claudeSession: "uuid-worker" }));
    writeFileSync(join(dir, "20260101-000000-2.status"), "not json");
    writeFileSync(join(dir, "ledger.log"), "x");
    expect([...readWorkerSessionIds(dir)]).toEqual(["uuid-worker"]);
    const f = workerSessionFilter(dir);
    expect(f.isWorker({ uuid: "uuid-worker", decodedPath: "/p/app" })).toBe(true);
    expect(f.isWorker({ uuid: "other", decodedPath: "/home/u/.claude/pai/logs/workers/worktrees/2026-1" })).toBe(true);
    expect(f.isWorker({ uuid: "other", decodedPath: "/p/app" })).toBe(false);
  });
  it("a missing log directory hides nothing", () => {
    expect(workerSessionFilter(join(tmpdir(), "pai-no-such-dir-xyz")).isWorker({ uuid: "a", decodedPath: "/p" })).toBe(false);
    expect(workerSessionFilter(null).isWorker({ uuid: "a", decodedPath: "/p" })).toBe(false);
  });
});

describe("pai ls option", () => {
  it("offers --workers, off by default", () => {
    const ls = GROUPS.flatMap((g) => g.commands).find((c) => c.name === "ls")!;
    const o = ls.options!.find((x) => x.name === "workers")!;
    expect(o.type).toBe("boolean");
    expect(o.default).toBe(false);
  });
});
