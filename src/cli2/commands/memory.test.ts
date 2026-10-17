import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { argvFromContext, runBridged } from "../lib/bridge.js";
import { parseArgs, UsageError } from "../parse.js";
import { resolve, runCli, type Io } from "../run.js";
import { makeStyle } from "../help.js";
import { GROUPS } from "../registry.js";
import type { CommandDef } from "../define.js";
import { auditCommand } from "./audit.js";
import { kgCommand } from "./kg.js";
import { memoryCommand, findCommand } from "./memory.js";
import { observationCommand } from "./observation.js";
import { obsidianCommand } from "./obsidian.js";
import { skillCommand } from "./skill.js";
import { zettelCommand } from "./zettel.js";

const ALL = [memoryCommand, findCommand, kgCommand, zettelCommand, observationCommand, obsidianCommand, skillCommand, auditCommand];
const walk = (c: CommandDef, path: string[] = []): Array<[string[], CommandDef]> => [
  [[...path, c.name], c],
  ...(c.subcommands ?? []).flatMap((s) => walk(s, [...path, c.name])),
];
const leaf = (path: string[]) => resolve(GROUPS, path).cmd;

describe("definitions", () => {
  it("every command has a one-line summary, a description and 2+ runnable examples", () => {
    for (const [path, c] of ALL.flatMap((c) => walk(c))) {
      expect(c.summary, path.join(" ")).not.toMatch(/\n/);
      expect(c.description.length, path.join(" ")).toBeGreaterThan(10);
      expect(c.examples.length, path.join(" ")).toBeGreaterThanOrEqual(1);
      if (c.run) expect(c.examples.length, path.join(" ")).toBeGreaterThanOrEqual(2);
      for (const e of c.examples) expect(e.startsWith("pai " + path[0])).toBe(true);
    }
  });
  it("keeps every old name reachable", () => {
    const names = [
      "memory index", "memory embed", "memory search", "memory status", "memory settings", "memory backend detect", "memory backend use",
      "memory backend provision", "memory reembed", "memory sources", "memory pass", "kg backfill", "kg query", "kg list", "kg stats",
      "zettel explore", "zettel surprise", "zettel converse", "zettel themes", "zettel health", "zettel suggest",
      "observation list", "observation search", "observation stats", "obsidian sync", "obsidian status", "obsidian open",
      "skill telemetry", "find", "audit tokens", "audit tokens files", "audit tokens hooks", "audit tokens session", "audit tokens spawn",
      "audit tokens daemon", "audit tokens env", "audit tokens schedule", "audit tokens skills", "audit tokens subagents",
      "audit tokens mcp", "audit tokens ladder",
    ];
    for (const n of names) {
      const r = resolve(GROUPS, n.split(" "));
      expect(r.rest, n).toEqual([]);
      expect(r.cmd.run, n).toBeTypeOf("function");
      expect(r.cmd.later, n).toBeUndefined();
    }
  });
});

describe("argv reconstruction", () => {
  it("memory search keeps positionals, values and --no-rerank", () => {
    const cmd = leaf(["memory", "search"]);
    const p = parseArgs(cmd, ["hello", "--project", "p1", "--limit", "5", "--no-rerank", "--recency", "0"]);
    const argv = argvFromContext(cmd, p);
    expect(argv[0]).toBe("hello");
    expect(argv).toEqual(expect.arrayContaining(["--project", "p1", "--limit", "5", "--no-rerank", "--recency", "0"]));
  });
  it("audit tokens files passes variadic paths and --json", () => {
    const cmd = leaf(["audit", "tokens", "files"]);
    const argv = argvFromContext(cmd, parseArgs(cmd, ["a.md", "b.md", "--json"]));
    expect(argv).toEqual(["a.md", "b.md", "--json"]);
  });
  it("false and unset booleans are not emitted; defaults are", () => {
    const cmd = leaf(["kg", "list"]);
    expect(argvFromContext(cmd, parseArgs(cmd, []))).toEqual(["--limit", "50"]);
    const bf = leaf(["kg", "backfill"]);
    expect(argvFromContext(bf, parseArgs(bf, ["--dry-run"]))).toEqual(["--dry-run"]);
  });
  it("find -n maps to --n", () => {
    const p = parseArgs(findCommand, ["q", "-n", "3", "--json"]);
    expect(p.opts.n).toBe(3);
    expect(p.opts.json).toBe(true);
  });
  it("unknown flag is a usage error naming the nearest flag", () => {
    expect(() => parseArgs(leaf(["memory", "search"]), ["q", "--limt", "3"])).toThrow(UsageError);
  });
});

describe("runBridged", () => {
  const def = { args: [{ name: "X", required: true, summary: "" }], options: [{ name: "flag", type: "boolean" as const, summary: "" }] };
  const ctx = (x: string, flag: boolean) => ({ args: { X: x }, opts: { flag }, dryRun: false, rest: [] });

  it("hands the rebuilt argv to the registered action and returns exit code 0", async () => {
    const seen = vi.fn();
    const reg = (n: Command) => void n.command("go <x>").option("--flag").action((x, o) => seen(x, o));
    expect(await runBridged(reg, "grp", ["go"], def, ctx("v", true))).toBe(0);
    expect(seen).toHaveBeenCalledWith("v", { flag: true });
  });
  it("returns the exit code an action sets", async () => {
    const reg = (n: Command) => void n.command("go <x>").action(() => { process.exitCode = 1; });
    expect(await runBridged(reg, "grp", ["go"], def, ctx("v", false))).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });
  it("turns a missing required option into a plain error with the help command", async () => {
    const reg = (n: Command) => void n.command("go <x>").requiredOption("--id <n>", "id").action(() => {});
    await expect(runBridged(reg, "grp", ["go"], def, ctx("v", false))).rejects.toMatchObject({ hint: "pai help grp go", exitCode: 1 });
  });
});

describe("exit codes through the dispatcher", () => {
  const io = (): Io & { errs: string[] } => {
    const errs: string[] = [];
    return { out: () => {}, err: (s) => errs.push(s), style: makeStyle(false), errs };
  };
  it("a missing required argument is exit 2", async () => {
    const i = io();
    expect(await runCli(GROUPS, ["memory", "search"], i)).toBe(2);
    expect(i.errs.join("\n")).toContain("missing required argument QUERY");
  });
  it("a zettel command without its required vault option fails with exit 1 and a next step", async () => {
    const i = io();
    expect(await runCli(GROUPS, ["zettel", "surprise", "n"], i)).toBe(1);
    expect(i.errs.join("\n")).toContain("Next: pai help zettel surprise");
  });
  it("help for a group lists its subcommands", async () => {
    const out: string[] = [];
    expect(await runCli(GROUPS, ["kg"], { out: (s) => out.push(s), err: () => {}, style: makeStyle(false) })).toBe(0);
    expect(out.join("\n")).toMatch(/backfill[\s\S]*query[\s\S]*list[\s\S]*stats/);
  });
});
