import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { correctToolName, declaredToolNames, fixJsonReply, ToolCaseSse } from "./tool-case.js";

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
});
