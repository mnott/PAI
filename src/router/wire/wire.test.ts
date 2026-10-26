import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkersConfig } from "../../workers/config.js";
import { createRouter, prepare } from "../router.js";
import { claudeCodeToolsArray } from "../tool-args-schemas.js";
import { activeRules, loadRules, RulesStore, shippedRulesPath } from "../tool-call-rules.js";
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
