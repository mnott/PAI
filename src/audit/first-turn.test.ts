/**
 * The one behaviour that matters here: only the live parentUuid lineage of
 * the first assistant turn is summed. A dead branch (a prompt abandoned
 * before a reply) is persisted in the transcript but never sent to the
 * model, so its tokens must be reported separately, not folded into the
 * turn-1 total.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstTurnBreakdown, firstTurnEvidence, turnBreakdown } from "./first-turn.js";
import { countTokens } from "./tokens.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-first-turn-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeTranscript(dir: string, lines: unknown[]): string {
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

describe("firstTurnBreakdown", () => {
  it("sums the live lineage only and reports dead-branch tokens separately", () => {
    const dir = newDir();
    const lines = [
      {
        type: "attachment",
        uuid: "h1",
        parentUuid: null,
        attachment: { type: "hook_success", hookName: "SessionStart:core", stdout: "core rules and startup context" },
      },
      // dead branch: abandoned prompt A, never replied to
      {
        type: "user",
        uuid: "a1",
        parentUuid: "h1",
        message: { content: "/Name abandoned prompt" },
      },
      {
        type: "attachment",
        uuid: "a2",
        parentUuid: "a1",
        attachment: {
          type: "skill_listing",
          content:
            "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two thirty-three thirty-four thirty-five thirty-six thirty-seven thirty-eight thirty-nine forty",
        },
      },
      {
        type: "attachment",
        uuid: "a3",
        parentUuid: "a2",
        attachment: { type: "hook_success", hookName: "UserPromptSubmit:status", stdout: "dead branch hook output" },
      },
      // live branch: prompt B, same parent as A, actually replied to
      {
        type: "user",
        uuid: "b1",
        parentUuid: "h1",
        message: { content: "/Name resubmitted prompt" },
      },
      {
        type: "attachment",
        uuid: "b2",
        parentUuid: "b1",
        attachment: { type: "deferred_tools_delta", addedNames: ["tool_a", "tool_b", "tool_c"] },
      },
      {
        type: "attachment",
        uuid: "b3",
        parentUuid: "b2",
        attachment: { type: "mcp_instructions_delta", instructions: { server: "example", body: "use this server" } },
      },
      {
        type: "attachment",
        uuid: "b4",
        parentUuid: "b3",
        attachment: { type: "hook_success", hookName: "UserPromptSubmit:status", stdout: "live branch hook output" },
      },
      {
        type: "user",
        uuid: "b5",
        parentUuid: "b4",
        isMeta: true,
        message: { content: [{ type: "text", text: "## Skill expansion body" }] },
      },
      {
        type: "system",
        uuid: "b6",
        parentUuid: "b5",
        subtype: "local_command",
        content: "raw stdout of the slash command, sent to the model in addition to the isMeta copy",
      },
      {
        type: "system",
        uuid: "b7",
        parentUuid: "b6",
        subtype: "stop_hook_summary",
        content: "hook summary, display only, never sent",
      },
      {
        type: "assistant",
        uuid: "c1",
        parentUuid: "b7",
        message: {
          usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 900, input_tokens: 5 },
        },
      },
    ];
    const path = writeTranscript(dir, lines);

    const b = firstTurnBreakdown(path);

    expect(b.apiContext).toBe(1005);
    expect(b.byKind.skill_listing).toBeUndefined();
    expect(b.deadBranchLines).toBe(3);
    expect(b.deadBranchTokens).toBeGreaterThan(0);

    const liveNonDisplaySum = b.items
      .filter((i) => i.kind !== "system:display-only")
      .reduce((sum, i) => sum + i.tokens, 0);
    expect(b.transcriptTokens).toBe(liveNonDisplaySum);
    expect(b.remainder).toBe(1005 - b.transcriptTokens);

    const localCommandItem = b.items.find((i) => i.kind === "prompt:local_command");
    expect(localCommandItem).toBeDefined();
    expect(b.byKind["prompt:local_command"]).toBe(localCommandItem!.tokens);

    const displayItem = b.items.find((i) => i.kind === "system:display-only");
    expect(displayItem).toBeDefined();
    expect(displayItem!.label).toBe("stop_hook_summary");
    expect(b.transcriptTokens).toBeLessThan(b.items.reduce((sum, i) => sum + i.tokens, 0));
  });

  it("mentions dead-branch tokens in the evidence string when a dead branch exists", () => {
    const dir = newDir();
    const lines = [
      {
        type: "attachment",
        uuid: "h1",
        parentUuid: null,
        attachment: { type: "hook_success", hookName: "SessionStart:core", stdout: "core rules" },
      },
      { type: "user", uuid: "a1", parentUuid: "h1", message: { content: "abandoned prompt" } },
      {
        type: "attachment",
        uuid: "a2",
        parentUuid: "a1",
        attachment: { type: "skill_listing", content: "a fairly long skill listing body of text" },
      },
      { type: "user", uuid: "b1", parentUuid: "h1", message: { content: "resubmitted prompt" } },
      {
        type: "assistant",
        uuid: "c1",
        parentUuid: "b1",
        message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 10 } },
      },
    ];
    const path = writeTranscript(dir, lines);

    const b = firstTurnBreakdown(path);

    expect(b.deadBranchTokens).toBeGreaterThan(0);
    expect(firstTurnEvidence(b)).toContain("dead-branch");
  });

  it("returns apiContext null and empty items when there is no assistant line", () => {
    const dir = newDir();
    const path = writeTranscript(dir, [{ type: "user", uuid: "u1", parentUuid: null, message: { content: "hi" } }]);

    const b = firstTurnBreakdown(path);

    expect(b.apiContext).toBeNull();
    expect(b.items).toEqual([]);
  });

  it("returns the empty shape for a missing path", () => {
    const b = firstTurnBreakdown(join(newDir(), "does-not-exist.jsonl"));

    expect(b.apiContext).toBeNull();
    expect(b.items).toEqual([]);
    expect(b.transcriptTokens).toBe(0);
    expect(b.deadBranchTokens).toBe(0);
    expect(b.deadBranchLines).toBe(0);
    expect(b.remainder).toBeNull();
  });
});

describe("turnBreakdown", () => {
  it("attributes turn 3's growth: tool_result, local_command stdout, and the previous call's merged blocks", () => {
    const dir = newDir();
    const lines = [
      { type: "attachment", uuid: "h1", parentUuid: null, attachment: { type: "hook_success", hookName: "SessionStart:core", stdout: "core rules" } },
      {
        // call 1 (turn 1)
        type: "assistant",
        uuid: "t1",
        parentUuid: "h1",
        message: { id: "m1", content: [{ type: "text", text: "turn one reply" }], usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 500, input_tokens: 10, output_tokens: 40 } },
      },
      { type: "user", uuid: "u1", parentUuid: "t1", message: { content: "second prompt" } },
      { type: "attachment", uuid: "hp1", parentUuid: "u1", attachment: { type: "hook_success", hookName: "UserPromptSubmit:status", stdout: "status line" } },
      {
        // call 2 (turn 2), split over two lines sharing message id m2: thinking+text on the first, tool_use on the second
        type: "assistant",
        uuid: "t2a",
        parentUuid: "hp1",
        message: {
          id: "m2",
          content: [
            { type: "thinking", text: "reasoning" },
            { type: "text", text: "turn two reply text" },
          ],
          usage: { cache_read_input_tokens: 500, cache_creation_input_tokens: 200, input_tokens: 5, output_tokens: 77 },
        },
      },
      {
        type: "assistant",
        uuid: "t2b",
        parentUuid: "t2a",
        message: {
          id: "m2",
          content: [{ type: "tool_use", input: { command: "ls -la" } }],
          usage: { cache_read_input_tokens: 500, cache_creation_input_tokens: 200, input_tokens: 5, output_tokens: 77 },
        },
      },
      { type: "user", uuid: "tr1", parentUuid: "t2b", message: { content: [{ type: "tool_result", content: "total 0\ndrwxr-xr-x" }] } },
      { type: "system", uuid: "lc1", parentUuid: "tr1", subtype: "local_command", content: "<local-command-stdout>raw context table</local-command-stdout>" },
      {
        // call 3 (turn 3)
        type: "assistant",
        uuid: "t3",
        parentUuid: "lc1",
        message: { id: "m3", content: [{ type: "text", text: "turn three reply" }], usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 300, input_tokens: 8, output_tokens: 55 } },
      },
    ];
    const path = writeTranscript(dir, lines);

    const tb = turnBreakdown(path, 3);
    expect(tb).not.toBeNull();
    const b = tb!;

    expect(b.turn).toBe(3);
    expect(b.apiContext).toBe(900 + 300 + 8);
    expect(b.prevApiContext).toBe(500 + 200 + 5);
    expect(b.billedDelta).toBe(b.apiContext! - b.prevApiContext);
    expect(b.prevOutputTokens).toBe(77);

    const toolResult = b.items.find((i) => i.kind === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.tokens).toBeGreaterThan(0);

    const localCommand = b.items.find((i) => i.kind === "prompt:local_command");
    expect(localCommand).toBeDefined();
    expect(localCommand!.tokens).toBeGreaterThan(0);

    const prev = b.items.find((i) => i.kind === "assistant:prev");
    expect(prev).toBeDefined();
    expect(prev!.label).toContain("1 thinking block");
    // The merged previous-call item counts both the text block and the tool_use input.
    expect(prev!.tokens).toBeGreaterThan(0);

    // transcriptTokens excludes assistant:prev: its visible output is already
    // covered by prevOutputTokens, so residual must not double-subtract it.
    const expectedTranscriptTokens = b.items
      .filter((i) => i.kind !== "system:display-only" && i.kind !== "assistant:prev")
      .reduce((sum, i) => sum + i.tokens, 0);
    expect(b.transcriptTokens).toBe(expectedTranscriptTokens);

    const expectedPrevVisible = countTokens("turn two reply text" + JSON.stringify({ command: "ls -la" }));
    expect(b.prevVisibleTokens).toBe(expectedPrevVisible);
    expect(b.prevVisibleTokens).toBe(prev!.tokens);

    expect(b.residual).toBe(b.billedDelta! - b.transcriptTokens - b.prevOutputTokens);
  });

  it("returns null for a turn past the end of the transcript", () => {
    const dir = newDir();
    const path = writeTranscript(dir, [
      { type: "attachment", uuid: "h1", parentUuid: null, attachment: { type: "hook_success", hookName: "SessionStart:core", stdout: "core" } },
      {
        type: "assistant",
        uuid: "t1",
        parentUuid: "h1",
        message: { id: "m1", content: [{ type: "text", text: "reply" }], usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 10, input_tokens: 1, output_tokens: 5 } },
      },
    ]);

    expect(turnBreakdown(path, 99)).toBeNull();
  });

  it("turn 1 equals firstTurnBreakdown on the shared fields", () => {
    const dir = newDir();
    const lines = [
      { type: "attachment", uuid: "h1", parentUuid: null, attachment: { type: "hook_success", hookName: "SessionStart:core", stdout: "core rules and startup context" } },
      { type: "user", uuid: "u1", parentUuid: "h1", message: { content: "first prompt" } },
      { type: "attachment", uuid: "hp1", parentUuid: "u1", attachment: { type: "hook_success", hookName: "UserPromptSubmit:status", stdout: "status line output" } },
      {
        type: "assistant",
        uuid: "t1",
        parentUuid: "hp1",
        message: { id: "m1", content: [{ type: "text", text: "reply" }], usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 300, input_tokens: 12, output_tokens: 20 } },
      },
    ];
    const path = writeTranscript(dir, lines);

    const first = firstTurnBreakdown(path);
    const tb = turnBreakdown(path, 1);
    expect(tb).not.toBeNull();

    expect(tb!.apiContext).toBe(first.apiContext);
    expect(tb!.items).toEqual(first.items);
    expect(tb!.transcriptTokens).toBe(first.transcriptTokens);
    expect(tb!.byKind).toEqual(first.byKind);
    expect(tb!.prevApiContext).toBe(0);
    expect(tb!.prevOutputTokens).toBe(0);
    expect(tb!.billedDelta).toBe(first.apiContext);
    expect(tb!.residual).toBe(first.remainder);
  });
});
