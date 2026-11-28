// Skills over MCP: initialize, resources/list+read, prompts/list+get over real stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const skill = readFileSync(resolve(root, "skills/PAI/SKILL.md"), "utf8");
const client = new Client({ name: "skill-test", version: "0" });

beforeAll(async () => {
  // PAI_MCP_ENTRY=dist/daemon-mcp/index.mjs tests the built bundle; default runs the source.
  const entry = process.env.PAI_MCP_ENTRY ?? "src/daemon-mcp/index.ts";
  const ts = entry.endsWith(".ts");
  await client.connect(new StdioClientTransport({ command: ts ? "npx" : "node", args: ts ? ["tsx", entry] : [entry], cwd: root, stderr: "ignore" }));
}, 60_000);
afterAll(async () => { await client.close(); });

describe("pai skill over MCP", () => {
  it("declares resources+prompts and short instructions naming both", () => {
    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeTruthy();
    expect(caps?.prompts).toBeTruthy();
    const ins = client.getInstructions() ?? "";
    expect(ins).toContain("skill://pai/SKILL.md");
    expect(ins).toContain("pai-skill");
    expect(ins.length).toBeLessThan(2500);
  });
  it("resources/list + read == SKILL.md", async () => {
    const { resources } = await client.listResources();
    const r = resources.find((x) => x.uri === "skill://pai/SKILL.md");
    expect(r?.mimeType).toBe("text/markdown");
    const rd = await client.readResource({ uri: "skill://pai/SKILL.md" });
    expect((rd.contents[0] as { text: string }).text).toBe(skill);
    expect(rd.contents[0].mimeType).toBe("text/markdown");
  });
  it("prompts/list + get == SKILL.md", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.some((p) => p.name === "pai-skill")).toBe(true);
    const pg = await client.getPrompt({ name: "pai-skill" });
    expect(pg.messages).toHaveLength(1);
    expect((pg.messages[0].content as { text: string }).text).toBe(skill);
  });
  it("tools still listed", async () => {
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "memory_search")).toBe(true);
  });
}, 60_000);
