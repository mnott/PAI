import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyContinue } from "./checkpoint-block.js";

function project(todo: string): string {
  const root = mkdtempSync(join(tmpdir(), "ckpt-"));
  mkdirSync(join(root, "Notes"));
  writeFileSync(join(root, "Notes", "TODO.md"), todo);
  return root;
}

const longBody = (n: number) =>
  Array.from({ length: Math.ceil(n / 60) }, (_, i) => `${i + 1}. open item number ${i + 1} with detail text`.padEnd(59, ".")).join("\n").slice(0, n);

const autoWrite = (root: string) =>
  applyContinue({
    authored: "auto",
    sessionLine: "0001 - 2026-11-26 - New Session",
    sessionId: "c78e042b-8af1-460c-96fd-e18354997dc1",
    cwd: root,
    rootPath: root,
    body: "T\ni=ckpt-1\ng=/Name\nd=?\nt=?\nz=auto ckpt (no model)",
    timestamp: "2026-11-26T14:22:11.943Z",
  });

describe("auto checkpoint never truncates the previous Continue", () => {
  it("unmarked 6000-char Continue is carried forward in full", () => {
    const body = longBody(6000);
    const root = project(`## Continue\n\n${body}\n\n---\n# Project\n`);
    autoWrite(root);
    expect(readFileSync(join(root, "Notes", "TODO.md"), "utf8")).toContain(body);
  });

  it("older model-authored 6000-char Continue is archived in full", () => {
    const body = longBody(6000);
    const root = project(
      `## Continue\n\n<!-- pai:checkpoint authored="model" session="0000 - 2026-11-25 - Old" session-id="aaaa" ts="2026-11-25T10:00:00.000Z" -->\n\n> **Last session:** Old\n\n${body}\n\n<!-- /pai:checkpoint -->\n\n---\n# Project\n`,
    );
    autoWrite(root);
    expect(readFileSync(join(root, "Notes", "TODO.md"), "utf8")).toContain(body);
  });

  it("a second auto write keeps the carried-forward 6000 chars", () => {
    const body = longBody(6000);
    const root = project(`## Continue\n\n${body}\n\n---\n# Project\n`);
    autoWrite(root);
    autoWrite(root);
    expect(readFileSync(join(root, "Notes", "TODO.md"), "utf8")).toContain(body);
  });
});
