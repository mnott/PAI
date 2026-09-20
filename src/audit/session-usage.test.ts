/**
 * The one behaviour that matters here: streaming writes one JSONL line per
 * content block of the same logical turn, repeating message.id and usage on
 * each — summing every line would multiply usage by the block count.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionUsage, totalUsageTokens } from "./session-usage.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-session-usage-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function usageLine(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
        output_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
        ...overrides,
      },
    },
  });
}

describe("parseSessionUsage", () => {
  it("counts each message.id once even when streamed across multiple lines", () => {
    const dir = newDir();
    const path = join(dir, "session.jsonl");
    // Three lines, same message.id, as a real streamed turn would write.
    writeFileSync(path, [usageLine("msg_1"), usageLine("msg_1"), usageLine("msg_1")].join("\n") + "\n", "utf8");

    return parseSessionUsage(path).then((report) => {
      expect(report.turns).toBe(1);
      expect(report.totals.input_tokens).toBe(2);
      expect(report.totals.cache_creation_input_tokens).toBe(100);
    });
  });

  it("sums distinct message.ids as separate turns", async () => {
    const dir = newDir();
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [usageLine("msg_1"), usageLine("msg_2")].join("\n") + "\n", "utf8");

    const report = await parseSessionUsage(path);
    expect(report.turns).toBe(2);
    expect(report.totals.input_tokens).toBe(4);
    expect(totalUsageTokens(report.totals)).toBe(2 * (2 + 100 + 50 + 10));
  });

  it("tracks first- and last-turn context and the ephemeral cache split", async () => {
    const dir = newDir();
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      [
        usageLine("msg_1", {
          input_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        }),
        usageLine("msg_2", {
          input_tokens: 5,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const report = await parseSessionUsage(path);
    expect(report.firstTurnContext).toBe(25);
    expect(report.lastTurnContext).toBe(205);
    expect(report.cacheCreationSplit.ephemeral1h).toBe(0);
  });

  it("ignores non-assistant lines and lines with no usage", async () => {
    const dir = newDir();
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      [JSON.stringify({ type: "user", message: { content: "hi" } }), usageLine("msg_1"), "not json at all"].join(
        "\n"
      ) + "\n",
      "utf8"
    );

    const report = await parseSessionUsage(path);
    expect(report.turns).toBe(1);
  });
});
