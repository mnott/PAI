import { describe, it, expect } from "vitest";
import { detectRepeatLoop, loopAction } from "./repeat-loop.js";

const use = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id: string, text: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });
const failing = (n: number, name = "Edit", input: unknown = { file_path: "a.ts", old_string: "x", new_string: "x" }) => Array.from({ length: n }, (_, i) => [use(`t${i}`, name, input), res(`t${i}`, "No changes to make", true)]).flat();

describe("repeat-loop", () => {
  describe("detectRepeatLoop", () => {
    it("returns null for empty events", () => {
      expect(detectRepeatLoop([])).toBeNull();
    });

    it("returns null for non-repeating events", () => {
      const events = [
        use("t0", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }),
        res("t0", "Changes made", false),
        use("t1", "Edit", { file_path: "a.ts", old_string: "y", new_string: "z" }),
        res("t1", "Changes made", false),
      ];
      expect(detectRepeatLoop(events)).toBeNull();
    });

    it("returns RepeatLoop for 3+ failing calls with same name and input", () => {
      const events = failing(3);
      expect(detectRepeatLoop(events)).toEqual({ name: "Edit", count: 3, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' });
    });

    it("returns RepeatLoop for 8 failing calls with same name and input", () => {
      const events = failing(8);
      expect(detectRepeatLoop(events)).toEqual({ name: "Edit", count: 8, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' });
    });

    it("returns null for less than 3 failing calls", () => {
      const events = failing(2);
      expect(detectRepeatLoop(events)).toBeNull();
    });

    it("returns null for 3 failing calls followed by a successful call", () => {
      const events = [...failing(3), use("t3", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }), res("t3", "Changes made", false)];
      expect(detectRepeatLoop(events)).toBeNull();
    });

    it("returns RepeatLoop for 3 failing calls after a successful call with different name", () => {
      const events = [
        use("t0", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }),
        res("t0", "Changes made", false),
        use("t1", "Bash", { command: "echo hello" }),
        res("t1", "hello", false),
        ...failing(3),
      ];
      expect(detectRepeatLoop(events)).toEqual({ name: "Edit", count: 3, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' });
    });

    it("returns null when the last call has different input", () => {
      const events = [
        ...failing(3),
        use("t3", "Edit", { file_path: "b.ts", old_string: "x", new_string: "x" }),
        res("t3", "No changes to make", true),
      ];
      expect(detectRepeatLoop(events)).toBeNull();
    });

    it("handles Bash exit codes correctly", () => {
      const events = [
        use("t0", "Bash", { command: "exit 1" }),
        res("t0", "Exit code 1\nboom", true),
        use("t1", "Bash", { command: "exit 1" }),
        res("t1", "Exit code 1\nboom", true),
        use("t2", "Bash", { command: "exit 1" }),
        res("t2", "Exit code 1\nboom", true),
      ];
      expect(detectRepeatLoop(events)).toEqual({ name: "Bash", count: 3, input: '{"command":"exit 1"}' });
    });

    it("does not count Bash exit code 0 as failed", () => {
      const events = [
        use("t0", "Bash", { command: "exit 0" }),
        res("t0", "Exit code 0", false),
        use("t1", "Bash", { command: "exit 0" }),
        res("t1", "Exit code 0", false),
        use("t2", "Bash", { command: "exit 0" }),
        res("t2", "Exit code 0", false),
      ];
      expect(detectRepeatLoop(events)).toBeNull();
    });

    it("handles malformed events", () => {
      const events = [
        null,
        5,
        {},
        { type: "user" },
        ...failing(3),
      ];
      expect(detectRepeatLoop(events)).toEqual({ name: "Edit", count: 3, input: '{"file_path":"a.ts","new_string":"x","old_string":"x"}' });
    });
  });

  describe("loopAction", () => {
    it("returns 'none' for count < 3", () => {
      expect(loopAction(2)).toBe("none");
    });

    it("returns 'warn' for count = 3", () => {
      expect(loopAction(3)).toBe("warn");
    });

    it("returns 'warn' for count = 5", () => {
      expect(loopAction(5)).toBe("warn");
    });

    it("returns 'stop' for count = 6", () => {
      expect(loopAction(6)).toBe("stop");
    });

    it("returns 'stop' for count = 9", () => {
      expect(loopAction(9)).toBe("stop");
    });
  });
});
describe("repeat-loop benign polling", () => {
  it("6x identical wait-file exit 3 is not a loop", () => {
    const input = { command: "cd /tmp/d; pai worker wait-file b0.json --max 100" };
    const events = Array.from({ length: 6 }, (_, i) => [use(`w${i}`, "Bash", input), res(`w${i}`, "Exit code 3\nnot yet", true)]).flat();
    expect(detectRepeatLoop(events)).toBeNull();
  });
});
