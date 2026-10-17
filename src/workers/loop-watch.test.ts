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
});