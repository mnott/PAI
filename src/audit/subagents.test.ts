/**
 * A subagent file with no `model:` frontmatter field inherits the caller's
 * model at runtime, so it must report `"inherits"` rather than a blank value.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSubagents } from "./subagents.js";
import { countTokens } from "./tokens.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-subagents-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeAgent(agentsDir: string, name: string, contents: string): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, name), contents, "utf8");
}

describe("auditSubagents", () => {
  it("reads the model and token count from a home-dir agent's frontmatter", () => {
    const home = newDir();
    const cwd = newDir();
    const contents = "---\nname: reviewer\nmodel: claude-sonnet-5\n---\nDo the review.\n";
    writeAgent(join(home, ".claude", "agents"), "reviewer.md", contents);

    const report = auditSubagents(home, cwd);

    expect(report.entries.length).toBe(1);
    expect(report.entries[0].model).toBe("claude-sonnet-5");
    expect(report.entries[0].tokens).toBe(countTokens(contents));
  });

  it("reports \"inherits\" when there is no model field", () => {
    const home = newDir();
    const cwd = newDir();
    writeAgent(join(home, ".claude", "agents"), "generic.md", "---\nname: generic\n---\nDo the thing.\n");

    const report = auditSubagents(home, cwd);

    expect(report.entries.length).toBe(1);
    expect(report.entries[0].model).toBe("inherits");
  });

  it("unquotes a quoted model value in a project agent", () => {
    const home = newDir();
    const cwd = newDir();
    writeAgent(
      join(cwd, ".claude", "agents"),
      "haiku-agent.md",
      '---\nname: haiku-agent\nmodel: "claude-haiku-4-5-20251001"\n---\nBody.\n'
    );

    const report = auditSubagents(home, cwd);

    expect(report.entries.length).toBe(1);
    expect(report.entries[0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("returns an empty entries list when neither agents directory exists", () => {
    const home = newDir();
    const cwd = newDir();

    const report = auditSubagents(home, cwd);

    expect(report.entries).toEqual([]);
  });

  it("includes agents from both home and cwd directories", () => {
    const home = newDir();
    const cwd = newDir();
    writeAgent(join(home, ".claude", "agents"), "home-agent.md", "---\nmodel: claude-sonnet-5\n---\nBody.\n");
    writeAgent(join(cwd, ".claude", "agents"), "project-agent.md", "---\nmodel: claude-haiku-4-5-20251001\n---\nBody.\n");
    writeAgent(join(home, ".claude", "agents"), "notes.txt", "not a subagent");

    const report = auditSubagents(home, cwd);

    expect(report.entries.length).toBe(2);
    expect(report.entries.find((e) => e.path.endsWith("home-agent.md"))?.model).toBe("claude-sonnet-5");
    expect(report.entries.find((e) => e.path.endsWith("project-agent.md"))?.model).toBe("claude-haiku-4-5-20251001");
  });
});
