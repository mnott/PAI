import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkersConfig } from "../../workers/config.js";
import { createRouter, prepare } from "../router.js";
import { claudeCodeToolsArray } from "../tool-args-schemas.js";
import { activeRules, loadRules, RulesStore, shippedRulesPath } from "../tool-call-rules.js";
import { bindWhenUp, isDeferrableBind } from "../tail-bind.js";
import { convertTextAnswer } from "../tool-args-convert.js";
import { adapterFor, splitProviderPrefix } from "./index.js";
import type { WireAdapter, WireId } from "./types.js";

const rules = activeRules(loadRules(shippedRulesPath()));
const rulesFn = () => rules;
const P = "/repo/scripts/prune-dist.mjs";

// one corpus (arguments as the model emitted them -> what it meant), shared by every wire format
const corpus: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
  ["opener", "Grep", { "-n": "true\n</parameter\n<parameter=-C>\n15", output_mode: "content", pattern: "x", path: P }, { "-n": true, "-C": 15, output_mode: "content", pattern: "x", path: P }],
  ["closer", "Grep", { pattern: "a|b", path: "/repo", output_mode: "files_with_matches\n</parameter>\n</end_parameter>\n</invoke>\n" }, { pattern: "a|b", path: "/repo", output_mode: "files_with_matches" }],
  ["junk_line", "Grep", { pattern: "W", output_mode: "content", "-n": "True\n</parameter>\n</output_mode>\n</output>" }, { pattern: "W", output_mode: "content", "-n": true }],
  ["name_cut", "Bash", { "command </parameter": "ls", description: "x" }, { command: "ls", description: "x" }],
  ["bool_false", "Edit", { file_path: "/a", old_string: "a", new_string: "b", replace_all: "False" }, { file_path: "/a", old_string: "a", new_string: "b", replace_all: false }],
  ["coerce", "Bash", { command: "ls", timeout: "120000" }, { command: "ls", timeout: 120000 }],
];
const clean = ["Bash", { command: "ls -la", timeout: 5 }] as const;

// a local model's tool call carrying booleans/numbers as strings for declared schema types
describe("schema-type coercion (local tool calls)", () => {
  const anth = adapterFor("POST", "/v1/messages")!;
  const schemas = anth.schemas(bodyFor("anthropic" as WireId));
  const argsOf = (bad: Record<string, unknown>): { input: Record<string, unknown>; hits: string[] } => {
    let hits: string[] = [];
    const reply = JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "Grep", input: bad }] });
    const out = anth.rewriteJson(reply, schemas, rulesFn, (i) => (hits = i.rules));
    return { input: JSON.parse(out).content[0].input, hits };
  };

  it('a boolean property sent as "true" arrives as the boolean true, logged in the rule stats', () => {
    const { input, hits } = argsOf({ pattern: "x", "-n": "true" });
    expect(input["-n"]).toBe(true);
    expect(hits.length).toBeGreaterThan(0); // the repair counts under bool-true / coerce:boolean
  });

  it('a number property sent as "20" arrives as the number 20', () => {
    const { input, hits } = argsOf({ pattern: "x", head_limit: "20" });
    expect(input.head_limit).toBe(20);
    expect(hits).toContain("coerce:number");
  });

  it('any case spelling ("TrUe") is coerced to a boolean, logged in the hit stats', () => {
    const { input, hits } = argsOf({ pattern: "x", multiline: "TrUe" });
    expect(input.multiline).toBe(true);
    expect(hits).toContain("coerce:boolean");
  });

  it("a string property keeps its value byte for byte: \"true\" stays a string", () => {
    const { input, hits } = argsOf({ pattern: "true", path: "false" });
    expect(input.pattern).toBe("true");
    expect(input.path).toBe("false");
    expect(hits).toEqual([]);
  });

  it("a value already parsed to the wrong JSON type is coerced too", () => {
    const { input } = argsOf({ pattern: "x", "-n": 1, head_limit: true });
    expect(input["-n"]).toBe(true);
    expect(input.head_limit).toBe(1);
  });

  it("without declared schemas nothing is touched", () => {
    const reply = JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "Grep", input: { "-n": "true" } }] });
    expect(anth.rewriteJson(reply, new Map(), rulesFn, () => {})).toBe(reply);
  });
});

const tools = claudeCodeToolsArray();
const bodyFor = (id: WireId): string =>
  JSON.stringify({
    model: "m",
    tools:
      id === "chat"
        ? tools.map((t) => ({ type: "function", function: { name: t.name, parameters: t.input_schema } }))
        : id === "responses"
          ? tools.map((t) => ({ type: "function", name: t.name, parameters: t.input_schema }))
          : tools,
  });

const SSE_CT = "text/event-stream";
const sse = (msgs: object[], named = false) => msgs.map((d: any) => `${named ? `event: ${d.type}\n` : ""}data: ${JSON.stringify(d)}\n\n`).join("");

// non-streaming reply carrying one call
const jsonReply = (id: "chat" | "responses", name: string, args: unknown): string =>
  JSON.stringify(
    id === "chat"
      ? { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] }
      : { id: "r1", status: "completed", output: [{ type: "function_call", id: "fc1", call_id: "call_1", name, arguments: JSON.stringify(args) }] }
  );

// streaming reply carrying one call, arguments cut into 7-char fragments
const frags = (s: string): string[] => s.match(/[\s\S]{1,7}/g) ?? [];
function streamReply(id: "chat" | "responses", name: string, args: unknown): string {
  const json = JSON.stringify(args);
  if (id === "chat") {
    const ch = (delta: object, finish: string | null = null) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
    return (
      sse([
        ch({ role: "assistant", content: "" }),
        ch({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] }),
        ...frags(json).map((f) => ch({ tool_calls: [{ index: 0, function: { arguments: f } }] })),
        ch({}, "tool_calls"),
      ]) + "data: [DONE]\n\n"
    );
  }
  const item = { type: "function_call", id: "fc1", call_id: "call_1", name };
  let n = 0;
  const ev = (type: string, body: object) => ({ type, sequence_number: n++, ...body });
  return sse(
    [
      ev("response.created", { response: { id: "r1", output: [] } }),
      ev("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } }),
      ...frags(json).map((f) => ev("response.function_call_arguments.delta", { output_index: 0, item_id: "fc1", delta: f })),
      ev("response.function_call_arguments.done", { output_index: 0, item_id: "fc1", arguments: json }),
      ev("response.output_item.done", { output_index: 0, item: { ...item, arguments: json } }),
      ev("response.completed", { response: { id: "r1", status: "completed", output: [{ ...item, arguments: json }] } }),
    ],
    true
  );
}

/** Arguments the client ends up with, per wire format, from a (possibly rewritten) SSE text. */
function sseArgs(id: "chat" | "responses", text: string): string[] {
  const evs = text.split(/\r?\n\r?\n/).map((m) => m.split("\n").find((l) => l.startsWith("data:"))).filter((l): l is string => !!l && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(5)));
  if (id === "chat") {
    const by = new Map<number, string>();
    for (const e of evs) for (const tc of e.choices?.[0]?.delta?.tool_calls ?? []) by.set(tc.index, (by.get(tc.index) ?? "") + (tc.function?.arguments ?? ""));
    return [...by.values()];
  }
  const done = evs.find((e) => e.type === "response.completed");
  const deltas = evs.filter((e) => e.type === "response.function_call_arguments.delta").map((e) => e.delta).join("");
  const itemDone = evs.find((e) => e.type === "response.output_item.done").item.arguments;
  const argsDone = evs.find((e) => e.type === "response.function_call_arguments.done").arguments;
  expect(new Set([deltas, itemDone, argsDone, done.response.output[0].arguments]).size).toBe(1);
  return [deltas];
}

async function through(a: WireAdapter, schemas: ReturnType<WireAdapter["schemas"]>, text: string, cut: number) {
  const t = a.rewriteStream(schemas, rulesFn, () => {});
  const out: Buffer[] = [];
  t.on("data", (c) => out.push(c));
  const done = new Promise<void>((r) => t.on("end", () => r()));
  const buf = Buffer.from(text);
  for (let i = 0; i < buf.length; i += cut) t.write(buf.subarray(i, i + cut));
  t.end();
  await done;
  return Buffer.concat(out).toString("utf8");
}

describe.each(["chat", "responses"] as const)("wire %s", (id) => {
  const a = adapterFor("POST", id === "chat" ? "/v1/chat/completions" : "/v1/responses")!;
  const schemas = a.schemas(bodyFor(id));

  it("reads the declared tool schemas of its own format", () => {
    expect([...schemas.keys()].sort()).toEqual(tools.map((t) => t.name).sort());
    expect(schemas.get("Bash")?.required).toEqual(["command"]);
  });

  for (const [kind, tool, bad, good] of corpus) {
    it(`JSON reply, rule kind ${kind}: arguments repaired`, () => {
      const hits: string[][] = [];
      const out = a.rewriteJson(jsonReply(id, tool, bad), schemas, rulesFn, (i) => hits.push(i.rules));
      expect(out).toBe(jsonReply(id, tool, good));
      expect(hits.length).toBe(1);
    });

    it(`SSE reply, rule kind ${kind}: repaired, whole and cut at every 1/3/7 bytes`, async () => {
      const text = streamReply(id, tool, bad);
      for (const cut of [1, 3, 7, 100000]) {
        const out = await through(a, schemas, text, cut);
        expect(sseArgs(id, out).map((x) => JSON.parse(x))).toEqual([good]);
      }
    });
  }

  it("no rule hit: bytes identical (JSON and SSE, any chunking)", async () => {
    const [tool, args] = clean;
    const j = jsonReply(id, tool, args);
    expect(a.rewriteJson(j, schemas, rulesFn, () => {})).toBe(j);
    const s = streamReply(id, tool, args);
    for (const cut of [1, 5, 100000]) expect(await through(a, schemas, s, cut)).toBe(s);
  });

  it("without declared tools nothing is touched", () => {
    const j = jsonReply(id, "Bash", corpus[3]![2]);
    expect(a.rewriteJson(j, new Map(), rulesFn, () => {})).toBe(j);
  });

  it("markup left as text becomes a structured call (JSON)", () => {
    const markup = "I will list.\n<function=Bash>\n<parameter=command>\nls -la\n</parameter>\n</function>";
    const raw = JSON.stringify(
      id === "chat"
        ? { choices: [{ index: 0, message: { role: "assistant", content: markup }, finish_reason: "stop" }] }
        : { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: markup }] }] }
    );
    const c = a.convertMarkup(raw, "application/json", schemas, rules)!;
    expect(c.calls.map((x) => x.name)).toEqual(["Bash"]);
    const j = JSON.parse(c.body);
    if (id === "chat") {
      expect(j.choices[0].finish_reason).toBe("tool_calls");
      expect(j.choices[0].message.content).toBe("I will list.");
      expect(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: "ls -la" });
    } else {
      const fc = j.output.find((i: any) => i.type === "function_call");
      expect(JSON.parse(fc.arguments)).toEqual({ command: "ls -la" });
    }
    expect(a.convertMarkup(JSON.stringify({ choices: [{ message: { content: "plain" } }], output: [] }), "application/json", schemas, rules)).toBeNull();
  });

  it("markup left as text becomes a structured call (SSE)", () => {
    const markup = "<function=Bash>\n<parameter=command>\nls\n</parameter>\n</function>";
    const raw =
      id === "chat"
        ? sse([
            { id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
            { id: "c", choices: [{ index: 0, delta: { content: markup }, finish_reason: null }] },
            { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]) + "data: [DONE]\n\n"
        : sse(
            [
              { type: "response.created", response: { id: "r" } },
              { type: "response.output_text.delta", delta: markup },
              { type: "response.completed", response: { id: "r", output: [{ type: "message", content: [{ type: "output_text", text: markup }] }] } },
            ],
            true
          );
    const c = a.convertMarkup(raw, SSE_CT, schemas, rules)!;
    expect(c.calls.map((x) => x.name)).toEqual(["Bash"]);
    if (id === "chat") {
      expect(c.body).toContain('"finish_reason":"tool_calls"');
      expect(sseArgs("chat", c.body).map((x) => JSON.parse(x))).toEqual([{ command: "ls" }]);
    } else {
      expect(c.body).toContain("response.function_call_arguments.done");
      expect(sseArgs("responses", c.body).map((x) => JSON.parse(x))).toEqual([{ command: "ls" }]);
      const seqs = c.body.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)).sequence_number);
      expect(seqs).toEqual(seqs.map((_, i) => i));
    }
  });
});

describe("chat stream with several parallel calls", () => {
  it("each index is repaired on its own", async () => {
    const a = adapterFor("POST", "/v1/chat/completions")!;
    const schemas = a.schemas(bodyFor("chat"));
    const ch = (delta: object, finish: string | null = null) => ({ id: "c", choices: [{ index: 0, delta, finish_reason: finish }] });
    const [, , b0, g0] = corpus[5]!;
    const [, , b1, g1] = corpus[4]!;
    const text = sse([
      ch({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "Bash", arguments: "" } }] }),
      ch({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "Edit", arguments: "" } }] }),
      ch({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(b0) } }] }),
      ch({ tool_calls: [{ index: 1, function: { arguments: JSON.stringify(b1) } }] }),
      ch({}, "tool_calls"),
    ]);
    const out = await through(a, schemas, text, 11);
    expect(sseArgs("chat", out).map((x) => JSON.parse(x))).toEqual([g0, g1]);
  });
});

describe("routing helpers", () => {
  it("provider prefix and adapter selection", () => {
    expect(splitProviderPrefix("/p/gyro/v1/chat/completions")).toEqual({ path: "/v1/chat/completions", provider: "gyro" });
    expect(splitProviderPrefix("/v1/responses")).toEqual({ path: "/v1/responses" });
    expect(adapterFor("POST", "/v1/messages")?.id).toBe("messages");
    expect(adapterFor("POST", "/v1/chat/completions")?.id).toBe("chat");
    expect(adapterFor("POST", "/v1/responses?x=1")?.id).toBe("responses");
    expect(adapterFor("GET", "/v1/responses")).toBeUndefined();
  });
});

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

describe("router end to end", () => {
  async function post(path: string, wire: "chat" | "responses", stream: boolean, headers: Record<string, string> = {}, toolParsing = false, reply?: { ct: string; body: string }) {
    const [, tool, bad] = corpus[0]!;
    const seenPaths: string[] = [];
    const up = http.createServer((req, res) => {
      seenPaths.push(req.url ?? "");
      req.resume();
      req.on("end", () => {
        const r = reply ?? (stream ? { ct: SSE_CT, body: streamReply(wire, tool, bad) } : { ct: "application/json", body: jsonReply(wire, tool, bad) });
        res.writeHead(200, { "content-type": r.ct });
        res.end(r.body);
      });
    });
    const upPort = await listen(up);
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" }, ...(toolParsing ? { toolParsing: "router" } : {}) } } }).providers;
    const fixes: Array<{ rules: string[]; wire?: string }> = [];
    const home = mkdtempSync(join(tmpdir(), "wire-router-"));
    const store = new RulesStore({ config: () => undefined, homeDir: () => home, log: () => {} });
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, {
      instances: () => [],
      toolCallRules: store,
      onToolArgsFix: (i) => fixes.push(i),
    });
    const port = await listen(r);
    const out = await new Promise<string>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path, method: "POST", headers }, (x) => {
        const bits: Buffer[] = [];
        x.on("data", (c) => bits.push(c));
        x.on("end", () => resolve(Buffer.concat(bits).toString()));
      });
      q.end(bodyFor(wire).replace('"model":"m"', '"model":"gyro-m"').replace(/}$/, `,"stream":${stream}}`));
    });
    r.close();
    up.close();
    return { out, fixes, seenPaths };
  }

  const good = corpus[0]![3];
  it("chat/completions JSON: repaired, upstream path unchanged, wire in the hit info", async () => {
    const { out, fixes, seenPaths } = await post("/v1/chat/completions", "chat", false, { "x-pai-provider": "gyro" });
    expect(JSON.parse(JSON.parse(out).choices[0].message.tool_calls[0].function.arguments)).toEqual(good);
    expect(seenPaths).toEqual(["/v1/chat/completions"]);
    expect(fixes[0]?.wire).toBe("chat");
  });

  it("chat/completions SSE through the /p/<provider> prefix", async () => {
    const { out, seenPaths } = await post("/p/gyro/v1/chat/completions", "chat", true);
    expect(sseArgs("chat", out).map((x) => JSON.parse(x))).toEqual([good]);
    expect(seenPaths).toEqual(["/v1/chat/completions"]);
  });

  it("responses JSON and SSE", async () => {
    const j = await post("/v1/responses", "responses", false, { "x-pai-provider": "gyro" });
    expect(JSON.parse(JSON.parse(j.out).output[0].arguments)).toEqual(good);
    const s = await post("/p/gyro/v1/responses", "responses", true);
    expect(sseArgs("responses", s.out).map((x) => JSON.parse(x))).toEqual([good]);
  });

  it("toolParsing router converts markup in a chat answer", async () => {
    const markup = "<function=Bash>\n<parameter=command>\nls\n</parameter>\n</function>";
    const body = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: markup }, finish_reason: "stop" }] });
    const { out } = await post("/v1/chat/completions", "chat", false, { "x-pai-provider": "gyro" }, true, { ct: "application/json", body });
    expect(JSON.parse(JSON.parse(out).choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: "ls" });
  });

  it("a claude model is refused on the OpenAI paths", () => {
    const r = prepare("/v1/chat/completions", {}, Buffer.from(JSON.stringify({ model: "claude-sonnet-4", messages: [] })), {}, "http://127.0.0.1:1", {}, "chat");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe("large tool-call arguments", () => {
  // 30 KB Write content: backslashes, quotes, regexes, emoji, CRLF, markup-looking text
  const unit = 'var re = /^\\s*"(\\w+)\\\\n"\\s*$/gm; // 😀 "q" \\ \\n \\" 日本語\r\n</parameter> <parameter=x> true\r\n';
  const content = unit.repeat(Math.ceil(30000 / unit.length));
  const args = JSON.stringify({ file_path: "/a/files.js", content });
  const anth = adapterFor("POST", "/v1/messages")!;
  const aSchemas = anth.schemas(bodyFor("anthropic" as WireId));
  const aStream = (json: string, stop: string, cut: number) => {
    const ev = (type: string, o: object) => ({ type, ...o });
    return sse(
      [
        ev("message_start", { message: { id: "m", role: "assistant", content: [] } }),
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "Write", input: {} } }),
        ...(json.match(new RegExp(`[\\s\\S]{1,${cut}}`, "gu")) ?? []).map((f) => ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: f } })),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 8192 } }),
        ev("message_stop", {}),
      ],
      true
    );
  };
  const aInput = (out: string): string =>
    out.split(/\n\n/).map((m) => m.split("\n").find((l) => l.startsWith("data:"))).filter((l): l is string => !!l).map((l) => JSON.parse(l.slice(5))).filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("");

  it("anthropic stream: 30 KB Write arrives byte-identical", async () => {
    for (const cut of [1, 5, 4096]) {
      const out = await through(anth, aSchemas, aStream(args, "tool_use", 40), cut);
      expect(aInput(out)).toBe(args);
      expect(JSON.parse(aInput(out)).content).toBe(content);
      expect(out).toContain('"stop_reason":"tool_use"');
    }
  });

  it("anthropic stream: a max_tokens cut gives a clean note, no half JSON", async () => {
    const out = await through(anth, aSchemas, aStream(args.slice(0, 20000), "max_tokens", 40), 13);
    expect(aInput(out)).toBe("");
    expect(out).not.toContain("tool_use");
    expect(out).toContain("output limit");
    expect(out).toContain('"stop_reason":"max_tokens"');
  });

  const events = (out: string): any[] => out.split(/\n\n/).map((m) => m.split("\n").find((l) => l.startsWith("data:"))).filter((l): l is string => !!l).map((l) => JSON.parse(l.slice(5)));
  const readSchemas = () => anth.schemas(bodyFor("anthropic" as WireId));

  it("anthropic stream: concatenated objects in one block become separate tool_use blocks, later blocks renumbered", async () => {
    const ev = (type: string, o: object) => ({ type, ...o });
    const raw = '{"file_path":"/a"} {"file_path":"/b"}';
    const text = sse(
      [
        ev("message_start", { message: { id: "m", role: "assistant", content: [] } }),
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "Read", input: {} } }),
        ...(raw.match(/[\s\S]{1,5}/g) ?? []).map((f) => ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: f } })),
        ev("content_block_stop", { index: 0 }),
        ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
        ev("content_block_stop", { index: 1 }),
        ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
        ev("message_stop", {}),
      ],
      true
    );
    const out = events(await through(anth, readSchemas(), text, 7));
    const starts = out.filter((e) => e.type === "content_block_start");
    expect(starts.map((e) => [e.index, e.content_block.type])).toEqual([[0, "tool_use"], [1, "tool_use"], [2, "text"]]);
    expect(starts[0].content_block.id).not.toBe(starts[1].content_block.id);
    expect(starts[1].content_block.id).toMatch(/^toolu_/);
    const inputs = out.filter((e) => e.delta?.type === "input_json_delta").map((e) => [e.index, JSON.parse(e.delta.partial_json)]);
    expect(inputs).toEqual([[0, { file_path: "/a" }], [1, { file_path: "/b" }]]);
    expect(out.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual([0, 1, 2]);
    expect(out.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
  });

  it("anthropic JSON reply: concatenated objects become separate tool_use blocks", () => {
    const reply = JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Read", input: '{"file_path":"/a"}{"file_path":"/b"}' }] });
    const j = JSON.parse(anth.rewriteJson(reply, readSchemas(), rulesFn, () => {}));
    expect(j.content.map((c: any) => c.input)).toEqual([{ file_path: "/a" }, { file_path: "/b" }]);
    expect(j.content[0].id).not.toBe(j.content[1].id);
    expect(j.content.every((c: any) => c.type === "tool_use" && c.name === "Read")).toBe(true);
  });

  it("anthropic stream: truncated object with max_tokens keeps the output-limit note; invalid JSON with tool_use says not valid JSON", async () => {
    const cut = await through(anth, aSchemas, aStream('{"file_path":"/a","content":"abc', "max_tokens", 9), 11);
    expect(cut).toContain("output limit");
    expect(cut).not.toContain('"type":"tool_use"');
    const bad = await through(anth, aSchemas, aStream('{"file_path":"/a"} {"file_', "tool_use", 9), 11);
    expect(bad).toContain("not valid JSON");
    expect(bad).not.toContain("output limit");
    expect(bad).not.toContain('"type":"tool_use"');
  });

  it("chat stream: 30 KB Write identical; a length cut gives a note", async () => {
    const a = adapterFor("POST", "/v1/chat/completions")!;
    const schemas = a.schemas(bodyFor("chat"));
    const mk = (json: string, fin: string) => {
      const ch = (delta: object, finish: string | null = null) => ({ id: "c", choices: [{ index: 0, delta, finish_reason: finish }] });
      return sse([ch({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "Write", arguments: "" } }] }), ...frags(json).map((f) => ch({ tool_calls: [{ index: 0, function: { arguments: f } }] })), ch({}, fin)]) + "data: [DONE]\n\n";
    };
    const good = mk(args, "tool_calls");
    expect(await through(a, schemas, good, 9)).toBe(good);
    const out = await through(a, schemas, mk(args.slice(0, 20000), "length"), 9);
    expect(sseArgs("chat", out)).toEqual([]);
    expect(out).toContain("output limit");
    expect(out).toContain('"finish_reason":"length"');
  });
});

describe("router loopback and tailnet bind (boot before Tailscale, 2026-11-18)", () => {
  // a fake retry clock: timers fire only when the test advances them, so the
  // scenario never sleeps and no wall-clock race can make it flaky under load.
  function fakeClock(): { setTimer(fn: () => void, ms: number): { cancel(): void }; advance(): Promise<void> } {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    return {
      setTimer: (fn, ms) => {
        const e = { fn, ms };
        armed.push(e);
        return { cancel: () => { const i = armed.indexOf(e); if (i >= 0) armed.splice(i, 1); } };
      },
      // fires every armed timer once (the backoff delay), then drains the macrotask/microtask queue so each callback's listen/error event has landed; repeats while callbacks keep arming timers
      advance: async () => {
        for (let round = 0; round < 10 && armed.length; round++) {
          const due = armed.splice(0);
          for (const e of due) e.fn();
          await new Promise((r) => setImmediate(r));
          await Promise.resolve();
          await new Promise((r) => setImmediate(r));
        }
      },
    };
  }
  async function scenario(bind: string, resolve: (b: string) => string | null, flip: () => void): Promise<void> {
    const loop = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => loop.listen(0, "127.0.0.1", r));
    const port = (loop.address() as { port: number }).port;
    const tail = http.createServer((_q, r) => r.end("tail"));
    const logs: string[] = [];
    const states: string[] = [];
    // the bound event awaited directly — no sleep after flip()
    let resolveBound!: (addr: string) => void;
    const boundP = new Promise<string>((r) => (resolveBound = r));
    const clock = fakeClock();
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const cancel = bindWhenUp(tail, { bind, port: port + 1, resolve, initialMs: 30, maxMs: 60, log: (l) => logs.push(l), onState: (s) => states.push(s.state), onBound: (a) => resolveBound(a), setTimer: clock.setTimer, onSettled: () => settle() });
    // await the deferred-bind event instead of sleeping; then confirm the first attempt found the address not up
    await settled;
    await new Promise((r) => setImmediate(r));
    expect(loop.listening).toBe(true);
    expect(tail.listening).toBe(false);
    expect(states).toContain("waiting");
    expect(logs.filter((l) => /waiting/.test(l))).toHaveLength(1);
    flip();
    await clock.advance(); // one fake retry tick, no real time passes
    await boundP;
    expect(tail.listening).toBe(true);
    expect(states).toContain("bound");
    expect(logs.filter((l) => /bound/.test(l))).toHaveLength(1);
    cancel();
    loop.close();
    tail.close();
  }
  it("accepts tailscale and an IPv4 as deferrable, refuses 0.0.0.0 and garbage", () => {
    expect(isDeferrableBind("tailscale")).toBe(true);
    expect(isDeferrableBind("100.64.1.2")).toBe(true);
    expect(isDeferrableBind("0.0.0.0")).toBe(false);
    expect(isDeferrableBind("garbage")).toBe(false);
  });
  it("unresolvable tailscale: loopback listens, waiting, bound once the address appears", async () => {
    let up = false;
    await scenario("tailscale", () => (up ? "127.0.0.1" : null), () => (up = true));
  });
  it("an IPv4 that is not up behaves the same", async () => {
    let addr = "192.0.2.77";
    await scenario("192.0.2.77", () => addr, () => (addr = "127.0.0.1"));
  });
});

describe("router vs engine resets and concurrency (2026-11-18)", () => {
  const OK = JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
  async function run(handler: http.RequestListener, n: number) {
    const up = http.createServer(handler);
    const upPort = await listen(up);
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" } } } }).providers;
    const logs: string[] = [];
    const r = createRouter(() => prov, "http://127.0.0.1:1", (l) => logs.push(l), undefined, undefined, { instances: () => [] });
    const port = await listen(r);
    const body = JSON.stringify({ model: "gyro-m", stream: false, messages: [{ role: "user", content: "hi" }] });
    const one = () =>
      new Promise<{ status: number; text: string }>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path: "/p/gyro/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (x) => {
          const bits: Buffer[] = [];
          x.on("data", (c) => bits.push(c));
          const fin = () => resolve({ status: x.statusCode ?? 0, text: Buffer.concat(bits).toString() });
          x.on("end", fin);
          x.on("close", fin);
          x.on("error", () => {});
        });
        q.on("error", () => resolve({ status: 0, text: "" }));
        q.end(body);
      });
    const results = await Promise.all(Array.from({ length: n }, one));
    r.close();
    up.close();
    return { results, logs };
  }

  it("reset before the first byte is retried and succeeds", async () => {
    let calls = 0;
    const { results, logs } = await run((req, res) => {
      req.resume();
      req.on("end", () => {
        if (++calls === 1) return req.socket.destroy();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(OK);
      });
    }, 1);
    expect(results[0]!.status).toBe(200);
    expect(calls).toBe(2);
    expect(logs.join("\n")).toMatch(/upstream reset, retried 1x, ok/);
  });

  it("reset after the first byte is not retried", async () => {
    let calls = 0;
    const { results } = await run((req, res) => {
      req.resume();
      req.on("end", () => {
        calls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {}\n\n");
        setTimeout(() => req.socket.destroy(), 50);
      });
    }, 1);
    expect(calls).toBe(1);
    expect(results[0]!.status).not.toBe(502);
  }, 15000);

  it("never more requests in flight to one engine than its cap", async () => {
    let now = 0;
    let max = 0;
    const { results } = await run((req, res) => {
      req.resume();
      req.on("end", () => {
        max = Math.max(max, ++now);
        setTimeout(() => {
          now--;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK);
        }, 40);
      });
    }, 6);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(max).toBe(1);
  }, 15000);

  it("20 concurrent requests waiting at a saturated engine keep the event loop responsive", async () => {
    // the in-flight queue must be promise/event based: waiting is awaiting, never spinning. A polling
    // loop or synchronous retry would block the loop and blow the lag budget while requests sit queued.
    const up = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK);
        }, 30);
      });
    });
    const upPort = await listen(up);
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" } } } }).providers;
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, { instances: () => [] });
    const port = await listen(r);
    const body = JSON.stringify({ model: "gyro-m", stream: false, messages: [{ role: "user", content: "hi" }] });
    const one = () =>
      new Promise<number>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path: "/p/gyro/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (x) => {
          x.resume();
          x.on("end", () => resolve(x.statusCode ?? 0));
          x.on("error", () => resolve(0));
        });
        q.on("error", () => resolve(0));
        q.end(body);
      });
    // a timer that should fire every 5 ms: how late it actually fires is the loop lag
    let maxLag = 0;
    let expectAt = Date.now() + 5;
    const timer = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - expectAt);
      expectAt = now + 5;
    }, 5);
    const statuses = await Promise.all(Array.from({ length: 20 }, one));
    clearInterval(timer);
    r.close();
    up.close();
    expect(statuses).toEqual(Array(20).fill(200));
    expect(maxLag).toBeLessThan(100);
  }, 30000);
});

describe("text tool call for an undeclared tool (anthropic answer)", () => {
  const schemas = new Map([
    ["Read", { required: ["file_path"], properties: { file_path: { type: "string" } } }],
    ["Write", { required: ["file_path", "content"], properties: { file_path: { type: "string" }, content: { type: "string" } } }],
  ]) as any;
  const call = (name: string, args = '{"command": "mkdir -p out"}') => `<tool_call>\n{"name": "${name}", "arguments": ${args}}\n</tool_call>`;
  const jsonAnswer = (text: string) => JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" });
  const sseAnswer = (text: string) =>
    sse([
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);

  it("JSON: becomes a tool_use block, stop_reason tool_use", () => {
    const c = convertTextAnswer(jsonAnswer(call("Bash")), "application/json", schemas, rules)!;
    const j = JSON.parse(c.body);
    expect(j.stop_reason).toBe("tool_use");
    expect(j.content.filter((b: any) => b.type === "tool_use").map((b: any) => [b.name, b.input])).toEqual([["Bash", { command: "mkdir -p out" }]]);
  });

  it("SSE: becomes a tool_use block, stop_reason tool_use", () => {
    const c = convertTextAnswer(sseAnswer(call("Bash")), SSE_CT, schemas, rules)!;
    expect(c.calls.map((x) => x.name)).toEqual(["Bash"]);
    expect(c.body).toContain('"type":"tool_use"');
    expect(c.body).toContain('"name":"Bash"');
    expect(c.body).toContain('"stop_reason":"tool_use"');
  });

  it("declared tool markup is unchanged", () => {
    const c = convertTextAnswer(jsonAnswer(call("Read", '{"file_path": "/a"}')), "application/json", schemas, rules)!;
    expect(JSON.parse(c.body).content.find((b: any) => b.type === "tool_use")).toMatchObject({ name: "Read", input: { file_path: "/a" } });
  });

  it("malformed markup stays text", () => {
    expect(convertTextAnswer(jsonAnswer('<tool_call>\n{"name": "Bash", "arguments": {"command": \n</tool_call>'), "application/json", schemas, rules)).toBeNull();
    expect(convertTextAnswer(jsonAnswer('<tool_call>\n{"name": "Bash"}\n</tool_call>'), "application/json", schemas, rules)).toBeNull();
  });
});

describe("messages wire, local provider without toolParsing (2026-11-23)", () => {
  it("fragmented SSE text call for an undeclared tool reaches the client as tool_use", async () => {
    const text = '<tool_call>\n{"name": "Bash", "arguments": {"command": "ls; mkdir -p out"}}\n</tool_call>';
    const frags = text.match(/.{1,3}/gs)!;
    const upBody = sse(
      [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...frags.map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ],
      true
    );
    const up = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": SSE_CT });
        res.end(upBody);
      });
    });
    const upPort = await listen(up);
    const prov = parseWorkersConfig({ providers: { strata: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "strata-m" } } } }).providers;
    const home = mkdtempSync(join(tmpdir(), "wire-router-"));
    const store = new RulesStore({ config: () => undefined, homeDir: () => home, log: () => {} });
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, undefined, undefined, { instances: () => [], toolCallRules: store, onToolArgsFix: () => {} });
    const port = await listen(r);
    const tools = [
      { name: "Read", description: "r", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
      { name: "Write", description: "w", input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
    ];
    const out = await new Promise<string>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "strata" } }, (x) => {
        const bits: Buffer[] = [];
        x.on("data", (c) => bits.push(c));
        x.on("end", () => resolve(Buffer.concat(bits).toString()));
      });
      q.end(JSON.stringify({ model: "strata-m", max_tokens: 100, stream: true, tools, messages: [{ role: "user", content: "go" }] }));
    });
    r.close();
    up.close();
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });
});
