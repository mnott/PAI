import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSpecPrompt, resolveSpecPath } from "./specfile.js";

function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "specfile-")));
  const caller = join(root, "caller");
  const target = join(root, "target");
  mkdirSync(caller);
  mkdirSync(target);
  return { caller, target };
}

describe("--spec resolution", () => {
  it("prefers the invoking cwd over --cwd", () => {
    const { caller, target } = dirs();
    writeFileSync(join(caller, "s.txt"), "caller");
    writeFileSync(join(target, "s.txt"), "target");
    expect(readSpecPrompt("s.txt", target, caller)).toBe("caller");
    expect(resolveSpecPath("s.txt", target, caller)).toBe(join(caller, "s.txt"));
  });
  it("falls back to --cwd when absent in the invoking cwd", () => {
    const { caller, target } = dirs();
    writeFileSync(join(target, "s.txt"), "target");
    expect(readSpecPrompt("s.txt", target, caller)).toBe("target");
  });
  it("names both candidates when neither exists", () => {
    const { caller, target } = dirs();
    let msg = "";
    try {
      readSpecPrompt("s.txt", target, caller);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(join(caller, "s.txt"));
    expect(msg).toContain(join(target, "s.txt"));
  });
});
