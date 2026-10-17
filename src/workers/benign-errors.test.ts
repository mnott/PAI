import { describe, it, expect } from "vitest";
import {
  benignNote,
  classifyToolError,
  detectRunningWorkerErrors,
  detectToolErrors,
  normalizeError,
  type ToolErrorRecord,
} from "./tool-errors.js";

const NOW = 10_000_000_000;
const bash = (raw: string, input: string, worker = "w1"): ToolErrorRecord => ({
  ts: NOW - 1000, worker, provider: "p", label: "l", tool: "Bash", raw, input, signature: normalizeError("Bash", raw),
});

describe("benign tool exits", () => {
  const benign: Array<[string, string, string]> = [
    ["grep no match", "Exit code 1", "grep -n foo src/a.ts"],
    ["rg in a pipeline tail", "Exit code 1", "cat x | rg -i foo"],
    ["ugrep after &&", "Exit code 1", "cd src && ugrep -r foo ."],
    ["grep with a | in its pattern", "Exit code 1", "grep -E 'a|b' file"],
    ["diff differs", "Exit code 1 1c1 < a --- > b", "diff a.txt b.txt"],
    ["cmp differs", "Exit code 1 a b differ: byte 1, line 1", "cmp a b"],
    ["test false", "Exit code 1", "test -f nope"],
    ["[ false", "Exit code 1", "[ -d nope ]"],
    ["vitest red before the fix", "Exit code 1 FAIL src/a.test.ts > x AssertionError: expected 1 to be 2", "npx vitest run src/a.test.ts"],
    ["echo === separator", "(eval):1: === not found", "echo === && ls"],
    ["echo == separator", "(eval):1: == not found", "echo == && ls"],
    ["echo = separator", "(eval):1: = not found", "echo = ; ls"],
    ["== after other output", "Exit code 127 header\n(eval):3: == not found", "echo ok; echo == ; ls"],
    ["timeout 124", "Exit code 124", "timeout 30 npm test"],
    ["timeout 144", "Exit code 144", "timeout 30 sleep 40"],
  ];
  for (const [name, raw, input] of benign) {
    it(`${name} is benign and not pushed`, () => {
      const r = bash(raw, input);
      expect(classifyToolError(r).cls).toBe("benign");
      expect(detectRunningWorkerErrors([{ id: "w1", session: "s" }], [r], {}, NOW)).toEqual([]);
      expect(detectToolErrors([r, { ...r, worker: "w2" }, { ...r, worker: "w3" }], NOW, {})).toEqual([]);
    });
  }

  const real: Array<[string, string, string]> = [
    ["tsc error", "Exit code 2 src/a.ts(1,1): error TS2304: Cannot find name x", "npx tsc --noEmit"],
    ["permission denied", "Exit code 126 zsh: permission denied: ./run.sh", "./run.sh"],
    ["file not found", "Exit code 1 cat: nope: No such file or directory", "cat nope"],
    ["grep missing file (exit 2)", "Exit code 2 grep: nope: No such file or directory", "grep foo nope"],
    ["grep exit 1 with an error text", "Exit code 1 boom", "grep foo a | tee out"],
    ["diff missing file", "Exit code 1 diff: nope: No such file or directory", "diff nope b"],
    ["grep not last in the chain", "Exit code 1 npm ERR! missing script", "grep foo a; npm run nope"],
    ["vitest import crash", "Exit code 1 SyntaxError: Unexpected token", "npx vitest run src/a.test.ts"],
    ["exit 124 without timeout", "Exit code 124", "make all"],
    ["=== not found without echo", "(eval):1: === not found", "ls"],
  ];
  for (const [name, raw, input] of real) {
    it(`${name} is still pushed`, () => {
      const r = bash(raw, input);
      expect(classifyToolError(r).cls).not.toBe("benign");
      expect(detectRunningWorkerErrors([{ id: "w1", session: "s" }], [r], {}, NOW)).toHaveLength(1);
    });
  }

  it("benign and real records sharing a signature are split per record", () => {
    const good = bash("Exit code 1", "grep a b");
    const bad = bash("Exit code 1", "npm run nope");
    expect(good.signature).toBe(bad.signature);
    const pushes = detectRunningWorkerErrors([{ id: "w1", session: "s" }], [good, good, bad], {}, NOW);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].group.count).toBe(1);
    expect(pushes[0].benign).toBe(2);
    expect(benignNote(pushes[0].benign)).toBe(" (+2 benign tool exits suppressed)");
    expect(benignNote(0)).toBe("");
  });
});

describe("wrong-case tool names", () => {
  const miss = (name: string): ToolErrorRecord => ({
    ts: NOW, worker: "w1", provider: "p", label: "l", tool: name, raw: `No such tool available: ${name}`,
    signature: normalizeError(name, `No such tool available: ${name}`),
  });
  it("bash is [model]", () => expect(classifyToolError(miss("bash")).cls).toBe("model"));
  it("a genuinely missing tool stays [harness]", () => expect(classifyToolError(miss("Foo")).cls).toBe("harness"));
  it("the exact declared name missing stays [harness]", () => expect(classifyToolError(miss("Bash")).cls).toBe("harness"));
});
