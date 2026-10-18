import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkLoops, LOOP_NOTE } from "./loop-watch.js";
import { WorkerStatus } from "./status.js";

const use = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id: string, text: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });
const failing = (n: number, name = "Edit", input: unknown = { file_path: "a.ts", old_string: "x", new_string: "x" }) => Array.from({ length: n }, (_, i) => [use(`t${i}`, name, input), res(`t${i}`, "No changes to make", true)]).flat();

describe("loop-watch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty array for no repeating events", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const deps = {
      readEvents: vi.fn().mockResolvedValue([]),
      say: vi.fn(),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("returns one warn finding for 3 repeats local", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const events = failing(3);
    const deps = {
      readEvents: vi.fn().mockReturnValue(events),
      say: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([
      {
        worker: "w1",
        action: "warn",
        loop: { name: "Edit", count: 3, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' },
        local: true
      }
    ]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).toHaveBeenCalledWith("/tmp", "w1", LOOP_NOTE);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(sent["w1"]).toBe("warn:Edit:{\"file_path\":\"a.ts\",\"new_string\":\"x\",\"old_string\":\"x\"}");
  });

  it("skips deduplication for same call again", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const events = failing(3);
    const deps = {
      readEvents: vi.fn().mockReturnValue(events),
      say: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {
      "w1": "warn:Edit:{\"file_path\":\"a.ts\",\"new_string\":\"x\",\"old_string\":\"x\"}"
    };
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("returns one stop finding for 6 repeats", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const events = failing(6);
    const deps = {
      readEvents: vi.fn().mockReturnValue(events),
      say: vi.fn(),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([
      {
        worker: "w1",
        action: "stop",
        loop: { name: "Edit", count: 6, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' },
        local: true
      }
    ]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).toHaveBeenCalledWith(123);
    expect(sent["w1"]).toBe("stop:Edit:{\"file_path\":\"a.ts\",\"new_string\":\"x\",\"old_string\":\"x\"}");
  });

  it("returns warn finding for 3 repeats with anthropic provider", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "anthropic" } as unknown as WorkerStatus
    ];

    const events = failing(3);
    const deps = {
      readEvents: vi.fn().mockReturnValue(events),
      say: vi.fn(),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([
      {
        worker: "w1",
        action: "warn",
        loop: { name: "Edit", count: 3, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' },
        local: false
      }
    ]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
    expect(sent["w1"]).toBe("warn:Edit:{\"file_path\":\"a.ts\",\"new_string\":\"x\",\"old_string\":\"x\"}");
  });

  it("skips state 'done'", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "done", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const deps = {
      readEvents: vi.fn(),
      say: vi.fn(),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([]);
    expect(deps.readEvents).not.toHaveBeenCalled();
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("handles say that throws", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const events = failing(3);
    const deps = {
      readEvents: vi.fn().mockReturnValue(events),
      say: vi.fn().mockRejectedValue(new Error("say failed")),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    expect(result).toEqual([
      {
        worker: "w1",
        action: "warn",
        loop: { name: "Edit", count: 3, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' },
        local: true
      }
    ]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).toHaveBeenCalledWith("/tmp", "w1", LOOP_NOTE);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("handles a readEvents that throws an error", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const deps = {
      readEvents: vi.fn().mockRejectedValue(new Error("boom")),
      say: vi.fn(),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    // Should return empty array instead of rejecting
    expect(result).toEqual([]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("handles a missing events file gracefully", async () => {
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const deps = {
      readEvents: vi.fn().mockRejectedValue({ code: "ENOENT" }),
      say: vi.fn(),
      kill: vi.fn()
    };

    const sent: Record<string, string> = {};
    const result = await checkLoops("/tmp", statuses, sent, deps);

    // Should return empty array instead of rejecting
    expect(result).toEqual([]);
    expect(deps.readEvents).toHaveBeenCalledWith("/tmp", "w1");
    expect(deps.say).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("handles a missing events file with no deps in temp dir", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "loop-watch-test-"));
    const statuses: WorkerStatus[] = [
      { id: "w1", state: "running", pid: 123, provider: "local30x8" } as unknown as WorkerStatus
    ];

    const result = await checkLoops(dir, statuses, {}, {});

    // Should return empty array instead of rejecting
    expect(result).toEqual([]);
  });
});
describe("echo loop", () => {
  const bash = (i: number, command: string) => use(`e${i}`, "Bash", { command });
  const echoes = (n: number, mk: (i: number) => string = (i) => `echo "step ${i}"`) => Array.from({ length: n }, (_, i) => bash(i, mk(i)));
  const st = [{ id: "w1", state: "running", pid: 9, provider: "anthropic" }] as unknown as WorkerStatus[];
  const run = (events: unknown[]) => {
    const deps = { readEvents: vi.fn().mockResolvedValue(events), say: vi.fn(), kill: vi.fn() };
    return checkLoops("/tmp", st, {}, deps).then((f) => ({ f, deps }));
  };

  it("12 echo-only turns without an edit warn as a loop", async () => {
    const { f, deps } = await run(echoes(12));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ action: "warn", loop: { kind: "echo", by: "turns", count: 12 } });
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it("24 turns hit the kill policy", async () => {
    const { f, deps } = await run(echoes(24));
    expect(f[0].action).toBe("stop");
    expect(deps.kill).toHaveBeenCalledWith(9);
  });

  it("11 turns, or an Edit in the run, is not a loop", async () => {
    expect((await run(echoes(11))).f).toEqual([]);
    expect((await run([...echoes(11), use("ed", "Edit", { file_path: "a" }), ...echoes(11)])).f).toEqual([]);
  });

  it("a real Bash command or a Read breaks the run", async () => {
    expect((await run([...echoes(11), bash(99, "npx tsc --noEmit"), ...echoes(5)])).f).toEqual([]);
    expect((await run([...echoes(6), use("r", "Read", { file_path: "a" }), ...echoes(6)])).f).toEqual([]);
  });

  it("a redirect that writes a file is not trivial", async () => {
    expect((await run(echoes(14, (i) => `echo hi > f${i}.txt`))).f).toEqual([]);
  });

  it("the same success string 3 times flags it even in few turns (digits ignored)", async () => {
    const { f } = await run(echoes(3, (i) => `echo "✅ TASK COMPLETE (check ${i})"`));
    expect(f[0]).toMatchObject({ action: "warn", loop: { kind: "echo", by: "string", count: 3 } });
  });

  it("two different success lines are fine", async () => {
    expect((await run([bash(1, 'echo "SUCCESS a"'), bash(2, 'echo "COMPLETE b"')])).f).toEqual([]);
  });
});
