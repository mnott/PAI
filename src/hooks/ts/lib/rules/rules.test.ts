import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "./load.js";
import { evaluateRules } from "./eval.js";
import { lintRules } from "./lint.js";
import { BUILTIN_RULES } from "./builtin.generated.js";
import type { Rule } from "./types.js";

const builtinIds = new Set(BUILTIN_RULES.map((r) => r.id));
const userOnly = (rules: Rule[]) => rules.filter((r) => !builtinIds.has(r.id));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pai-rules-"));
}

function writeRule(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  return dir;
}

const rule = (over: Partial<Rule> & { id: string; match: string }): Rule => ({
  severity: "block",
  reason: "test",
  ...over,
});

describe("loadRules", () => {
  it("reports a bad regex as an error and skips the rule, never throws", () => {
    const dir = writeRule(tempDir(), "bad.rule.yaml", "id: bad\nseverity: block\nmatch: '(unclosed'\nreason: r\n");
    const { rules, errors } = loadRules([dir]);
    expect(userOnly(rules)).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("bad");
    expect(errors[0]).toContain("invalid regex");
  });

  it("skips a rule missing fields and reports it", () => {
    const dir = writeRule(tempDir(), "nofields.rule.yaml", "id: x\nseverity: block\n");
    const { rules, errors } = loadRules([dir]);
    expect(userOnly(rules)).toEqual([]);
    expect(errors[0]).toContain("missing");
  });

  it("reads a top-level list of rules", () => {
    const dir = writeRule(tempDir(), "two.rule.yaml", "- id: a\n  severity: block\n  match: foo\n  reason: r\n- id: b\n  severity: warn\n  match: bar\n  reason: r\n");
    const { rules, errors } = loadRules([dir]);
    expect(errors).toEqual([]);
    expect(userOnly(rules).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("accepts a bare YAML regex node and takes its flags", () => {
    const dir = writeRule(tempDir(), "regex.rule.yaml", "id: inj\nseverity: block\nmatch: /ignore/i\nreason: r\n");
    const { rules } = loadRules([dir]);
    expect(rules.find((r) => r.id === "inj")?.match).toBe("ignore");
    expect(rules.find((r) => r.id === "inj")?.flags).toBe("i");
  });

  it("a later rule with the same id replaces the builtin, severity off disables it", () => {
    const dir = writeRule(tempDir(), "override.rule.yaml", "id: chmod-zero\nseverity: warn\nmatch: /chmod 000/\nreason: softer\n");
    const { rules } = loadRules([dir]);
    const chmod = rules.find((r) => r.id === "chmod-zero");
    expect(chmod?.severity).toBe("warn");
    expect(chmod?.reason).toBe("softer");

    const offDir = writeRule(tempDir(), "off.rule.yaml", "id: chmod-zero\nseverity: off\nreason: disabled\n");
    const off = loadRules([dir, offDir]);
    expect(off.rules.find((r) => r.id === "chmod-zero")).toBeUndefined();
  });

  it("a missing directory is not an error", () => {
    const { rules, errors } = loadRules([join(tempDir(), "nope")]);
    expect(errors).toEqual([]);
    expect(rules.length).toBeGreaterThan(0); // built-ins still load
  });
});

describe("evaluateRules", () => {
  it("returns the first block hit before any confirm or warn", () => {
    const rules = [rule({ id: "w", match: "x", severity: "warn" }), rule({ id: "c", match: "x", severity: "confirm" }), rule({ id: "b", match: "x", severity: "block" })];
    expect(evaluateRules(rules, "Bash", "echo x")?.rule.id).toBe("b");
  });

  it("returns the first confirm hit when no block hits", () => {
    const rules = [rule({ id: "w", match: "x", severity: "warn" }), rule({ id: "c", match: "x", severity: "confirm" })];
    expect(evaluateRules(rules, "Bash", "echo x")?.rule.id).toBe("c");
  });

  it("returns the warn hit when nothing else hits", () => {
    const rules = [rule({ id: "w", match: "x", severity: "warn" })];
    expect(evaluateRules(rules, "Bash", "echo x")?.rule.id).toBe("w");
  });

  it("drops quoted strings unless the rule is quoted: true", () => {
    const rules = [rule({ id: "b", match: "rm -rf /" })];
    expect(evaluateRules(rules, "Bash", 'echo "rm -rf /"')).toBeNull();
    expect(evaluateRules(rules, "Bash", 'rm -rf "/"')).toBeNull();
  });

  it("tests a quoted: true rule with quote marks removed", () => {
    const rules = [rule({ id: "b", match: "rm -rf /", quoted: true })];
    expect(evaluateRules(rules, "Bash", 'rm -rf "/"')?.rule.id).toBe("b");
  });

  it("a quoted non-git text does not hit a confirm rule", () => {
    const rules = [rule({ id: "c", match: "push -f", severity: "confirm" })];
    expect(evaluateRules(rules, "Bash", 'echo "push -f"')).toBeNull();
  });

  it("matches only the default Bash tool unless tool is set", () => {
    const rules = [rule({ id: "b", match: "x" }), rule({ id: "e", match: "x", tool: "Edit" })];
    expect(evaluateRules(rules, "Bash", "x")?.rule.id).toBe("b");
    expect(evaluateRules(rules, "Edit", "x")?.rule.id).toBe("e");
  });
});

describe("lintRules", () => {
  it("flags a fixture that does not hit and one that wrongly hits", () => {
    const rules = [rule({ id: "r", match: "abc", tests: { match: ["zzz"], no_match: ["abc"] } })];
    const lints = lintRules(rules);
    expect(lints[0].ok).toBe(false);
    expect(lints[0].failures.length).toBe(2);
  });

  it("passes every builtin rule's fixtures", () => {
    const lints = lintRules(BUILTIN_RULES);
    const failed = lints.filter((l) => !l.ok);
    expect(failed.map((f) => `${f.id}: ${f.failures.join("; ")}`)).toEqual([]);
  });
});
