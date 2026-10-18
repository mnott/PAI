import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { renderAg2Call, correctToolName, declaredToolNames, fixJsonReply, ToolCaseSse } from "./tool-case.js";

const declared = ["Bash", "Read", "Grep"];

async function run(chunks: string[], fixes: string[][] = []): Promise<string> {
  const t = new ToolCaseSse(declared, (a, b) => fixes.push([a, b]));
  const out: Buffer[] = [];
  await new Promise<void>((res) => {
    Readable.from(chunks.map((c) => Buffer.from(c))).pipe(t).on("data", (d: Buffer) => out.push(d)).on("end", () => res());
  });
  return Buffer.concat(out).toString("utf8");
}

const start = (name: string) =>
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name, input: {} } })}\n\n`;
const text = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"bash"}}\n\n`;

describe("tool-case", () => {
  it("declaredToolNames reads the request tools", () =>
    expect(declaredToolNames(JSON.stringify({ tools: [{ name: "Bash" }, { name: "Read" }] }))).toEqual(["Bash", "Read"]));
  it("correctToolName: wrong case only", () => {
    expect(correctToolName("bash", declared)).toBe("Bash");
    expect(correctToolName("Bash", declared)).toBeNull();
    expect(correctToolName("shell", declared)).toBeNull();
    expect(correctToolName("a", ["A", "a"])).toBeNull();
    expect(correctToolName("A", ["a", "A"])).toBeNull();
  });
  it("rewrites a wrong-case tool_use in the stream, even split mid-line", async () => {
    const fixes: string[][] = [];
    const s = start("bash");
    const out = await run([text, s.slice(0, 40), s.slice(40)], fixes);
    expect(fixes).toEqual([["bash", "Bash"]]);
    expect(out).toContain('"name":"Bash"');
    expect(out).not.toContain('"name":"bash"');
    expect(out).toContain(text);
  });
  it("leaves exact names and other events byte for byte", async () => {
    const fixes: string[][] = [];
    const input = text + start("Bash") + start("Unknown");
    expect(await run([input], fixes)).toBe(input);
    expect(fixes).toEqual([]);
  });
  it("fixJsonReply rewrites content[] tool_use", () => {
    const body = JSON.stringify({ content: [{ type: "tool_use", name: "READ", id: "x", input: {} }] });
    const fixes: string[][] = [];
    expect(JSON.parse(fixJsonReply(body, declared, (a, b) => fixes.push([a, b]))).content[0].name).toBe("Read");
    expect(fixes).toEqual([["READ", "Read"]]);
  });

  describe("AG2 kind called as a tool", () => {
    const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
    const stream = (json: string[]) =>
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t", name: "R", input: {} } }) +
      json.map((p) => ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: p } })).join("") +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "tool_use" } });

    it("renders fields, or a single string verbatim", () => {
      expect(renderAg2Call("R", { i: "x", r: "+", t: ["a+"] })).toBe('R\ni=x\nr=+\nt=["a+"]');
      expect(renderAg2Call("R", { text: "i=x\nr=+" })).toBe("R\ni=x\nr=+");
      expect(renderAg2Call("R", {})).toBe("R");
    });
    it("converts the streamed tool_use into a text block and ends the turn", async () => {
      const fixes: string[][] = [];
      const s = stream(['{"i":"x",', '"r":"+"}']);
      const out = await run([s.slice(0, 70), s.slice(70)], fixes);
      expect(fixes).toEqual([["R", "text"]]);
      expect(out).not.toContain("tool_use\",\"id");
      expect(out).toContain('"content_block":{"type":"text","text":""}');
      expect(out).toContain('"text":"R\\ni=x\\nr=+"');
      expect(out).toContain('"stop_reason":"end_turn"');
      expect(out).not.toContain("input_json_delta");
      expect(out.match(/event: /g)?.length).toBe(4);
    });
    it("keeps a declared R tool", async () => {
      const s = stream(["{}"]);
      const t = new ToolCaseSse(["R"], () => {});
      const out: Buffer[] = [];
      await new Promise<void>((res) => Readable.from([Buffer.from(s)]).pipe(t).on("data", (d: Buffer) => out.push(d)).on("end", () => res()));
      expect(Buffer.concat(out).toString()).toBe(s);
    });
    it("fixJsonReply converts content[]", () => {
      const body = JSON.stringify({ content: [{ type: "tool_use", name: "Q", id: "x", input: { a: "1" } }] });
      expect(JSON.parse(fixJsonReply(body, declared, () => {})).content[0]).toEqual({ type: "text", text: "Q\na=1" });
    });
  });
});
