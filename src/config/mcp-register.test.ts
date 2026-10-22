import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMcpScript, mcpEntryRunsScript } from "./claude-json.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pai-mcp-reg-"));
  const real = join(root, "real");
  mkdirSync(join(real, "dist"), { recursive: true });
  const script = join(real, "dist", "index.mjs");
  writeFileSync(script, "");
  const link = join(root, "link");
  symlinkSync(real, link);
  const other = join(root, "other.mjs");
  writeFileSync(other, "");
  return { script, viaLink: join(link, "dist", "index.mjs"), other };
}

describe("registerMcpScript", () => {
  it("matches the same file reached through a symlink", () => {
    const { script, viaLink } = setup();
    expect(mcpEntryRunsScript({ args: [viaLink] }, script)).toBe(true);
  });

  it("install twice via different paths yields one pai entry, no legacy", () => {
    const { script, viaLink } = setup();
    const servers: Record<string, unknown> = {};
    expect(registerMcpScript(servers, "pai", viaLink)).toBe("added");
    expect(registerMcpScript(servers, "pai", script)).toBe("updated");
    expect(registerMcpScript(servers, "pai", script)).toBe("unchanged");
    expect(Object.keys(servers)).toEqual(["pai"]);
    expect(servers["pai-legacy"]).toBeUndefined();
  });

  it("keeps a genuinely different server as pai-legacy", () => {
    const { script, other } = setup();
    const servers: Record<string, unknown> = { pai: { command: "node", args: [other] } };
    expect(registerMcpScript(servers, "pai", script)).toBe("legacy-kept");
    expect((servers["pai-legacy"] as { args: string[] }).args).toEqual([other]);
    expect((servers["pai"] as { args: string[] }).args).toEqual([script]);
  });
});
