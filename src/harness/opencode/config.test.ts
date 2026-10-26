import { describe, expect, it } from "vitest";
import { convertCommands, convertMcpServers, mergeOpenCodeConfig, renderOpenCodeConfig } from "./config.js";

describe("convertMcpServers", () => {
  it("maps a stdio server to OpenCode's local shape", () => {
    const { mcp } = convertMcpServers({ pai: { command: "node", args: ["/x/index.mjs"] } });
    expect(mcp.pai).toEqual({ type: "local", command: ["node", "/x/index.mjs"], enabled: true });
  });

  it("never writes a secret value: env and headers become {env:NAME} references", () => {
    const { mcp, envRefs } = convertMcpServers({
      a: { command: "x", env: { TOKEN: "s3cret", KEY: "${OTHER}" } },
      b: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer s3cret" } },
    });
    expect(JSON.stringify(mcp)).not.toContain("s3cret");
    expect(mcp.a).toMatchObject({ environment: { TOKEN: "{env:TOKEN}", KEY: "{env:OTHER}" } });
    expect(mcp.b).toMatchObject({ type: "remote", headers: { Authorization: "{env:PAI_MCP_B_AUTHORIZATION}" } });
    expect(envRefs).toEqual(["OTHER", "PAI_MCP_B_AUTHORIZATION", "TOKEN"]);
  });

  it("reports an entry that has neither command nor url", () => {
    expect(convertMcpServers({ bad: {} }).skipped).toEqual([{ name: "bad", why: "no command or url" }]);
  });
});

describe("convertCommands", () => {
  it("takes the description from frontmatter, else the heading, and strips the frontmatter", () => {
    const out = convertCommands([
      { name: "a", body: "---\ndescription: \"Do A\"\n---\n# A\nbody" },
      { name: "b", body: "# Heading B\ntext" },
    ]);
    expect(out.a).toEqual({ description: "Do A", template: "# A\nbody" });
    expect(out.b!.description).toBe("Heading B");
  });
});

describe("mergeOpenCodeConfig", () => {
  const frag = renderOpenCodeConfig({
    claudeMcpServers: { pai: { command: "node", args: ["i.mjs"] } },
    instructionsPath: "/c/pai/AGENTS.md",
    commands: [],
    bridgePluginUrl: "file:///new/pai-bridge.mjs",
    bridgeHooks: [{ tools: ["bash"], command: ["node", "g.mjs"] }],
  }).fragment;

  it("keeps what the user wrote and refreshes PAI's own entries", () => {
    const existing = {
      theme: "x",
      instructions: ["/mine.md"],
      mcp: { other: { type: "local", command: ["o"], enabled: true }, pai: { type: "local", command: ["old"], enabled: false } },
      plugin: ["some-plugin", ["file:///old/pai-bridge.mjs", {}]],
    };
    const out = mergeOpenCodeConfig(existing, frag) as Record<string, any>;
    expect(out.theme).toBe("x");
    expect(out.instructions).toEqual(["/mine.md", "/c/pai/AGENTS.md"]);
    expect(Object.keys(out.mcp)).toEqual(["other", "pai"]);
    expect(out.mcp.pai.command).toEqual(["node", "i.mjs"]);
    expect(out.plugin.map((p: unknown) => (Array.isArray(p) ? p[0] : p))).toEqual(["some-plugin", "file:///new/pai-bridge.mjs"]);
  });

  it("is idempotent", () => {
    const once = mergeOpenCodeConfig({}, frag);
    expect(mergeOpenCodeConfig(once, frag)).toEqual(once);
  });
});
