import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopStopResult, printResult } from "./run/finalise.js";
import { eventsPath } from "./paths.js";

describe("result of a loop-stopped run", () => {
  afterEach(() => vi.restoreAllMocks());

  it("--output-format json still prints the stop reason, usage, turns and duration", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopstop-result-"));
    try {
      const turn = (id: string) => JSON.stringify({ type: "assistant", message: { id, model: "m", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } } });
      writeFileSync(eventsPath(dir, "w1"), `${turn("a")}\n${turn("b")}\n`);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      printResult("json", loopStopResult(dir, "w1", "Write /x repeated 20 times without a change", 2, 7), 143, dir, "w1");
      const out = JSON.parse(log.mock.calls[0][0] as string);
      expect(out.result).toBe("loop-stopped: Write /x repeated 20 times without a change");
      expect(out.is_error).toBe(true);
      expect(out.num_turns).toBe(2);
      expect(out.duration_ms).toBe(7000);
      expect(out.usage).toMatchObject({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
