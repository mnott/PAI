/**
 * Tests for task classes: the roles→classes migration, agent definitions as
 * workers, and chain spec files. Pure functions + tmp dirs only — no claude
 * process, no real config file.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig, WORKER_CLASSES } from "./config.js";
import { parseAgentFile, modelToClass } from "./agents.js";
import { runChain, specPathFor, swapPromptArg, type ChainOptions } from "./chain.js";
import type { RunOptions } from "./run.js";

describe("roles → classes migration", () => {
  it("parses the legacy roles key into classes", () => {
    const c = parseWorkersConfig({ roles: { implement: "glm", spotcheck: "glm/fast" } });
    expect(c.classes).toEqual({ implement: "glm", spotcheck: "glm/fast" });
  });

  it("writes classes only: a re-serialized config has no roles key left", () => {
    const c = parseWorkersConfig({ roles: { implement: "glm" } });
    const serialized = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    expect(serialized.classes).toEqual({ implement: "glm" });
    expect("roles" in serialized).toBe(false);
    // and the migrated shape parses back identically
    expect(parseWorkersConfig(serialized).classes.implement).toBe("glm");
  });

  it("classes wins when both keys are present", () => {
    const c = parseWorkersConfig({
      roles: { implement: "old" },
      classes: { implement: "new" },
    });
    expect(c.classes.implement).toBe("new");
  });

  it("covers the nine standard classes", () => {
    expect([...WORKER_CLASSES]).toEqual([
      "draft", "plan", "implement", "review", "research",
      "spotcheck", "simple", "complex", "image",
    ]);
  });
});

describe("agent definitions", () => {
  const FILE = [
    "---",
    "model: sonnet",
    "description: Code explorer",
    "tools:",
    "  - Read",
    "  - Grep",
    "---",
    "You explore codebases. Find things fast.",
  ].join("\n");

  it("parses front matter and body", () => {
    const def = parseAgentFile("explorer", FILE, "/agents/explorer.md");
    expect(def.model).toBe("sonnet");
    expect(def.description).toBe("Code explorer");
    expect(def.tools).toEqual(["Read", "Grep"]);
    expect(def.body).toBe("You explore codebases. Find things fast.");
  });

  it("accepts inline list syntax for tools", () => {
    const def = parseAgentFile("e", "---\ntools: [Read, Glob]\n---\nBody", "/agents/e.md");
    expect(def.tools).toEqual(["Read", "Glob"]);
  });

  it("rejects a file without front matter or with an empty body", () => {
    expect(() => parseAgentFile("x", "no front matter", "/x.md")).toThrow(/front matter/);
    expect(() => parseAgentFile("x", "---\nmodel: sonnet\n---\n  \n", "/x.md")).toThrow(/empty/);
  });

  it("maps model names to classes", () => {
    expect(modelToClass("haiku")).toBe("simple");
    expect(modelToClass("claude-sonnet-5")).toBe("implement");
    expect(modelToClass("opus")).toBe("complex");
    expect(modelToClass("glm-5.3")).toBeUndefined();
    expect(modelToClass(undefined)).toBeUndefined();
  });
});

describe("chains", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-workers-chain-"));

  it("swapPromptArg replaces the brief with the stage prompt, keeping other args", () => {
    const out = swapPromptArg(
      ["-p", "the brief", "--allowedTools", "Read,Write", "--verbose"],
      "the stage prompt"
    );
    expect(out).toEqual(["--allowedTools", "Read,Write", "--verbose", "-p", "the stage prompt"]);
  });

  function chainOpts(over: Partial<ChainOptions> = {}): ChainOptions {
    return {
      stages: ["draft", "implement"],
      brief: "add a settings toggle",
      claudeArgs: ["-p", "add a settings toggle", "--allowedTools", "Read,Write"],
      ...over,
    };
  }

  it("runs each stage as its own worker with parent set, and writes the spec between them", async () => {
    const seen: RunOptions[] = [];
    const rc = await runChain(chainOpts(), {
      logDir: dir,
      runStage: async (o) => {
        seen.push(o);
        if (o.stage === "draft") {
          // the real draft worker writes the spec file
          writeFileSync(
            specPathFor(dir, o.parent ?? ""),
            "# Goal\ntoggle the setting\n",
            "utf8"
          );
        }
        return 0;
      },
    });
    expect(rc).toBe(0);
    expect(seen.map((o) => o.stage)).toEqual(["draft", "implement"]);
    expect(seen[0]!.parent).toBe(seen[1]!.parent); // one chain id
    const prompt = seen[1]!.claudeArgs[seen[1]!.claudeArgs.indexOf("-p") + 1];
    expect(prompt).toContain("# Goal");
    expect(prompt).toContain("add a settings toggle"); // original brief attached
    expect(seen[1]!.label).toContain(" · implement");
  });

  it("stops and fails when the draft stage produced no spec", async () => {
    const stages: string[] = [];
    const rc = await runChain(chainOpts(), {
      logDir: dir,
      runStage: async (o) => {
        stages.push(o.stage ?? "?");
        return 0;
      },
    });
    expect(rc).not.toBe(0);
    expect(stages).toEqual(["draft"]); // implement never ran
  });

  it("stops the chain at the first failing stage", async () => {
    const stages: string[] = [];
    const rc = await runChain(
      chainOpts({
        stages: ["draft", "implement", "review"],
        className: "implement", // --class overrides every stage
      }),
      {
        logDir: dir,
        runStage: async (o) => {
          stages.push(o.stage ?? "?");
          if (o.stage === "draft") {
            writeFileSync(specPathFor(dir, o.parent ?? ""), "# Goal\nx\n", "utf8");
            return 0;
          }
          return 2; // implement fails
        },
      }
    );
    expect(rc).toBe(2);
    expect(stages).toEqual(["draft", "implement"]);
  });

  it("writes the spec under <logDir>/specs/<chain id>.md and reads it for review", async () => {
    let specPathSeen = "";
    await runChain(
      chainOpts({ stages: ["draft", "review"] }),
      {
        logDir: dir,
        runStage: async (o) => {
          if (o.stage === "draft") {
            writeFileSync(specPathFor(dir, o.parent ?? ""), "# Goal\nreview me\n", "utf8");
            specPathSeen = specPathFor(dir, o.parent ?? "");
            return 0;
          }
          const prompt = o.claudeArgs[o.claudeArgs.indexOf("-p") + 1] ?? "";
          expect(prompt).toContain("# Goal");
          expect(prompt).toContain("git diff");
          return 0;
        },
      }
    );
    expect(specPathSeen.startsWith(join(dir, "specs"))).toBe(true);
    expect(existsSync(specPathSeen)).toBe(true);
    expect(readFileSync(specPathSeen, "utf8")).toContain("review me");
  });
});
