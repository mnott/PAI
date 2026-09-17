/**
 * Tests for the Anthropic ↔ OpenAI translation — recorded request/response
 * pairs from both protocols, fed straight into the pure functions. Nothing
 * here talks to a network, a claude binary or osascript.
 */

import { describe, it, expect } from "vitest";
import {
  anthropicToOpenAi,
  anthropicError,
  openAiToAnthropic,
  OpenAiStreamTranslator,
  type AnthropicRequest,
  type OpenAiResponse,
} from "./translate.js";

// ---------------------------------------------------------------------------
// Requests: Anthropic → OpenAI
// ---------------------------------------------------------------------------

describe("anthropicToOpenAi", () => {
  it("plain text round trip: system + user text", () => {
    const req: AnthropicRequest = {
      model: "glm-4.7",
      max_tokens: 512,
      system: "Be terse.",
      messages: [{ role: "user", content: "Say hi" }],
    };
    const out = anthropicToOpenAi(req, "glm-4.7-open");
    expect(out.model).toBe("glm-4.7-open");
    expect(out.max_tokens).toBe(512);
    expect(out.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Say hi" },
    ]);
    expect(out.tools).toBeUndefined();
    expect(out.stream).toBeUndefined();
  });

  it("multi-turn text keeps the order and the roles", () => {
    const req: AnthropicRequest = {
      max_tokens: 64,
      messages: [
        { role: "user", content: "One" },
        { role: "assistant", content: [{ type: "text", text: "Uno" }] },
        { role: "user", content: "Two" },
      ],
    };
    expect(anthropicToOpenAi(req, "m").messages).toEqual([
      { role: "user", content: "One" },
      { role: "assistant", content: "Uno" },
      { role: "user", content: "Two" },
    ]);
  });

  it("assistant tool_use becomes tool_calls with JSON-string arguments", () => {
    const req: AnthropicRequest = {
      max_tokens: 64,
      messages: [
        { role: "user", content: "List the files" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
        },
      ],
    };
    const out = anthropicToOpenAi(req, "m");
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tu_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
      ],
    });
  });

  it("user tool_result becomes role:tool with the tool_call_id", () => {
    const req: AnthropicRequest = {
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "file-a\nfile-b" },
            { type: "text", text: "Now summarise" },
          ],
        },
      ],
    };
    expect(anthropicToOpenAi(req, "m").messages).toEqual([
      { role: "tool", tool_call_id: "tu_1", content: "file-a\nfile-b" },
      { role: "user", content: "Now summarise" },
    ]);
  });

  it("tools map to function tools with the input_schema as parameters", () => {
    const req: AnthropicRequest = {
      max_tokens: 64,
      tools: [
        {
          name: "get_weather",
          description: "Weather of a city",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      messages: [{ role: "user", content: "Warsaw?" }],
    };
    expect(anthropicToOpenAi(req, "m").tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather of a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ]);
  });

  it("maps temperature, stop_sequences, stream (with usage option), max_tokens default", () => {
    const req: AnthropicRequest = {
      temperature: 0.2,
      stop_sequences: ["\n\n", "END"],
      stream: true,
      messages: [{ role: "user", content: "x" }],
    };
    const out = anthropicToOpenAi(req, "m");
    expect(out.temperature).toBe(0.2);
    expect(out.stop).toEqual(["\n\n", "END"]);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.max_tokens).toBe(8192);
  });
});

// ---------------------------------------------------------------------------
// Responses: OpenAI → Anthropic
// ---------------------------------------------------------------------------

describe("openAiToAnthropic", () => {
  it("plain text reply", () => {
    const res: OpenAiResponse = {
      id: "chatcmpl-1",
      model: "glm-4.7-open",
      choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    };
    const out = openAiToAnthropic(res, "fallback");
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.model).toBe("glm-4.7-open");
    expect(out.content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(out.stop_reason).toBe("stop_sequence");
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
  });

  it("one tool call becomes a tool_use block with parsed input", () => {
    const res: OpenAiResponse = {
      id: "chatcmpl-2",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_7",
                type: "function",
                function: { name: "Bash", arguments: '{"command":"npm test"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 12 },
    };
    const out = openAiToAnthropic(res, "m");
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_7", name: "Bash", input: { command: "npm test" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("finish_reason length maps to max_tokens; missing usage maps to zeros", () => {
    const res: OpenAiResponse = {
      choices: [{ message: { content: "trunc" }, finish_reason: "length" }],
    };
    const out = openAiToAnthropic(res, "m");
    expect(out.stop_reason).toBe("max_tokens");
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("anthropicError", () => {
  it("maps upstream statuses to Anthropic error types", () => {
    expect(anthropicError(429, "{}").error.type).toBe("rate_limit_error");
    expect(anthropicError(401, "{}").error.type).toBe("authentication_error");
    expect(anthropicError(403, "{}").error.type).toBe("authentication_error");
    expect(anthropicError(400, "{}").error.type).toBe("invalid_request_error");
    expect(anthropicError(422, "{}").error.type).toBe("invalid_request_error");
    expect(anthropicError(500, "{}").error.type).toBe("api_error");
    expect(anthropicError(503, "overloaded").error.type).toBe("api_error");
  });

  it("keeps the upstream error message when the body is JSON", () => {
    const out = anthropicError(429, '{"error":{"message":"Quota exceeded","type":"usage"}}');
    expect(out.type).toBe("error");
    expect(out.error.message).toBe("Quota exceeded");
    expect(out.error.type).toBe("rate_limit_error");
  });

  it("keeps raw text for non-JSON bodies", () => {
    expect(anthropicError(502, "bad gateway").error.message).toBe("bad gateway");
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** All Anthropic SSE events in a translator output, as parsed objects. */
function eventsOf(sse: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (line) out.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  return out;
}

describe("OpenAiStreamTranslator", () => {
  it("streaming text: start → block start/delta/stop → message_delta/stop with usage", () => {
    const t = new OpenAiStreamTranslator("glm-4.7-open", "msg_test1");
    let sse = t.feed({
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    });
    sse += t.feed({
      choices: [{ delta: { content: " world" }, finish_reason: null }],
    });
    sse += t.feed({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 2 },
    });
    sse += t.finish();
    const ev = eventsOf(sse);
    expect(ev[0]).toMatchObject({
      type: "message_start",
      message: { id: "msg_test1", model: "glm-4.7-open", usage: { input_tokens: 0, output_tokens: 0 } },
    });
    // usage arrives with the last chunk, before finish()
    const deltas = ev.filter((e) => e.type === "content_block_delta");
    expect(deltas).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    ]);
    const tail = ev.slice(-3);
    expect(tail[0]).toEqual({ type: "content_block_stop", index: 0 });
    expect(tail[1]).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "stop_sequence" },
      usage: { output_tokens: 2 },
    });
    expect(tail[2]).toEqual({ type: "message_stop" });
  });

  it("streaming tool call: argument fragments become input_json_delta", () => {
    const t = new OpenAiStreamTranslator("glm-4.7-open", "msg_test2");
    let sse = t.feed({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: '{"comm' } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sse += t.feed({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'and":"ls"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sse += t.feed({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    sse += t.finish();
    const ev = eventsOf(sse);
    const start = ev.find((e) => e.type === "content_block_start");
    expect(start).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_1", name: "Bash", input: {} },
    });
    const deltas = ev.filter((e) => e.type === "content_block_delta");
    expect(deltas).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comm' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } },
    ]);
    expect(ev.slice(-2)[0]).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });
  });

  it("text before a tool call closes the text block first", () => {
    const t = new OpenAiStreamTranslator("m", "msg_test3");
    let sse = t.feed({ choices: [{ delta: { content: "Running it" } }] });
    sse += t.feed({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Bash", arguments: "{}" } }] } },
      ],
    });
    sse += t.finish();
    const ev = eventsOf(sse);
    const stops = ev.filter((e) => e.type === "content_block_stop");
    expect(stops.map((s) => s.index)).toEqual([0, 1]); // text closed, then tool block
    const starts = ev.filter((e) => e.type === "content_block_start");
    expect(starts.map((s) => (s.content_block as { type: string }).type)).toEqual(["text", "tool_use"]);
  });

  it("is single-use: finish() twice emits the tail once", () => {
    const t = new OpenAiStreamTranslator("m", "msg_test4");
    t.feed({ choices: [{ delta: { content: "x" } }] });
    const first = t.finish();
    expect(t.finish()).toBe("");
    expect(eventsOf(first).at(-1)).toEqual({ type: "message_stop" });
  });
});
