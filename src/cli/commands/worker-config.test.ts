import { describe, expect, it, vi } from "vitest";
import { CliError, type CommandDef } from "../define.js";
import { parseArgs, UsageError } from "../parse.js";
import { GROUPS } from "../registry.js";
import { runCli, type Io } from "../run.js";
import { makeStyle } from "../help.js";
import { routerCommand } from "./router.js";
import {
  PROVIDER_EDIT_COMMANDS,
  WORKER_CONFIG_COMMANDS,
  buildClassTarget,
  collectEnv,
  collectTags,
  controlsArgv,
  parseCostTier,
  workerClassesCommand,
  workerProvidersCommand,
} from "./worker-config.js";
import { useCommand } from "./providers.js";

const sub = (c: CommandDef, name: string) => c.subcommands!.find((s) => s.name === name)!;

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s), style: makeStyle(false) }, out, err };
}

describe("repeatable options", () => {
  const add = sub(workerProvidersCommand, "add");
  it("collects every --env and --tags value in order", () => {
    const p = parseArgs(add, ["glm", "--url", "https://x.invalid", "--model", "m", "--env", "A=1", "--env", "B=2", "--tags", "fast", "--tags", "code,vision"]);
    expect(p.args.NAME).toBe("glm");
    expect(p.multi).toEqual({ env: ["A=1", "B=2"], tags: ["fast", "code,vision"] });
    expect(collectEnv(p.multi!.env)).toEqual({ A: "1", B: "2" });
    expect(collectTags(p.multi!.tags)).toEqual(["fast", "code", "vision"]);
  });
  it("an empty --tags is kept so update can clear the tags", () => {
    const p = parseArgs(sub(workerProvidersCommand, "update"), ["glm", "--tags", ""]);
    expect(p.multi!.tags).toEqual([""]);
    expect(collectTags(p.multi!.tags)).toEqual([]);
  });
  it("a missing NAME is a usage error", () => {
    expect(() => parseArgs(add, ["--model", "m"])).toThrow(UsageError);
  });
});

describe("value rules keep the old messages", () => {
  it("--env needs NAME=VALUE", () => expect(() => collectEnv(["oops"])).toThrow('--env expects NAME=VALUE, got "oops"'));
  it("an unknown tag names the valid ones", () => expect(() => collectTags(["cheap"])).toThrow(/"cheap" is not a tag \(from: code/));
  it("cost tier is 1..5", () => {
    expect(parseCostTier("3")).toBe(3);
    for (const bad of ["0", "6", "x"]) expect(() => parseCostTier(bad)).toThrow(/cost tier must be an integer 1/);
  });
});

describe("buildClassTarget", () => {
  it("a bare target stays a string", () => expect(buildClassTarget("glm/fast", {})).toBe("glm/fast"));
  it("constraints build the object form", () => {
    expect(buildClassTarget(undefined, { maxCostTier: 2, requireTags: ["code"], mcp: "a, b", order: "x,y" })).toEqual({
      maxCostTier: 2,
      requireTags: ["code"],
      mcp: ["a", "b"],
      order: ["x", "y"],
    });
  });
  it("nothing at all, or an alias with constraints, is refused", () => {
    expect(() => buildClassTarget(undefined, {})).toThrow(/give a target/);
    expect(() => buildClassTarget("glm/fast", { maxCostTier: 1 })).toThrow(/cannot be combined/);
  });
});

describe("registry shape", () => {
  const walk = (c: CommandDef, path: string[], f: (c: CommandDef, p: string[]) => void) => {
    f(c, path);
    for (const s of c.subcommands ?? []) walk(s, [...path, s.name], f);
  };
  it("every ported command has a summary, description and 2+ examples", () => {
    for (const c of [...WORKER_CONFIG_COMMANDS, routerCommand]) {
      walk(c, [c.name], (cmd, p) => {
        expect(cmd.summary, p.join(" ")).toBeTruthy();
        expect(cmd.description, p.join(" ")).toBeTruthy();
        expect(cmd.examples.length, p.join(" ")).toBeGreaterThanOrEqual(2);
      });
    }
  });
  it("covers every old subcommand name", () => {
    const names = (c: CommandDef) => c.subcommands!.map((s) => s.name);
    expect(names(workerProvidersCommand)).toEqual(expect.arrayContaining(["add", "update", "remove", "use", "enable", "disable", "test", "list"]));
    expect(names(workerClassesCommand)).toEqual(["list", "set", "unset"]);
    expect(names(WORKER_CONFIG_COMMANDS.find((c) => c.name === "config")!)).toEqual(["path", "init", "migrate", "check", "inline-keys"]);
    expect(names(routerCommand)).toEqual(["start", "stop", "restart", "status", "run", "stats"]);
    expect(WORKER_CONFIG_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining(["providers", "classes", "roles", "config", "local", "bench", "policy", "fallback", "pool", "proxy", "mcp", "on", "off", "install", "controls"])
    );
  });
  it("roles is a hidden alias of classes", () => {
    const roles = WORKER_CONFIG_COMMANDS.find((c) => c.name === "roles")!;
    expect(roles.hidden).toBe(true);
    expect(roles.subcommands).toBe(workerClassesCommand.subcommands);
  });
  it("`pai providers` and `pai worker providers` share one implementation", () => {
    const top = GROUPS.flatMap((g) => g.commands).find((c) => c.name === "providers")!;
    expect(sub(top, "use")).toBe(useCommand);
    expect(sub(workerProvidersCommand, "use")).toBe(useCommand);
    for (const c of PROVIDER_EDIT_COMMANDS) {
      expect(sub(top, c.name)).toBe(c);
      expect(sub(workerProvidersCommand, c.name)).toBe(c);
    }
  });
  it("router and worker are registered", () => {
    const all = GROUPS.flatMap((g) => g.commands);
    expect(all.find((c) => c.name === "router")).toBeDefined();
    const worker = all.find((c) => c.name === "worker")!;
    expect(worker.subcommands!.find((c) => c.name === "providers")).toBeDefined();
  });
});

describe("exit codes and errors", () => {
  it("a missing argument exits 2", async () => {
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "providers", "remove"], c.io)).toBe(2);
    expect(c.err.join("\n")).toContain("missing required argument NAME");
  });
  it("a bad action exits 1 with the next command", async () => {
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "fallback", "bogus"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain('unknown fallback action "bogus" (expected: on, off, status)');
    expect(c.err.join("\n")).toContain("Next: pai worker fallback status");
  });
  it("proxy and mcp reject unknown words without touching anything", async () => {
    for (const [argv, msg] of [
      [["worker", "proxy", "bogus"], 'unknown proxy argument "bogus"'],
      [["worker", "mcp", "bogus"], 'unknown mcp argument "bogus"'],
      [["worker", "pool", "bogus"], 'unknown pool action "bogus"'],
    ] as const) {
      const c = capture();
      expect(await runCli(GROUPS, [...argv], c.io)).toBe(1);
      expect(c.err.join("\n")).toContain(msg);
    }
  });
  it("controls needs you or me", async () => {
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "controls", "w1", "them"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain('<who> must be "you" or "me"');
  });
  it("router stats rejects a bad span", async () => {
    const c = capture();
    expect(await runCli(GROUPS, ["router", "stats", "--since", "banana"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("Next: pai router stats --since 1h");
  });
  it("help for the hidden alias still renders", async () => {
    const c = capture();
    expect(await runCli(GROUPS, ["worker", "roles", "--help"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("pai worker roles");
  });
  it("CliError carries hint and exit code", () => {
    const e = new CliError("x", "pai y");
    expect([e.hint, e.exitCode]).toEqual(["pai y", 1]);
  });
});

describe("clickr argv for controls", () => {
  it("you hands over with agent and pid; me takes back", () => {
    expect(controlsArgv("w1", "you", 42)).toEqual(["controls", "you", "--agent", "w1", "--pid", "42"]);
    expect(controlsArgv("w1", "me", 42)).toEqual(["controls", "me"]);
  });
});

describe("config check duplicate model ids", () => {
  it("warns when two enabled providers declare one model id", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = join(mkdtempSync(join(tmpdir(), "wcheck-")), "workers.yaml");
    writeFileSync(
      f,
      "providers:\n  a:\n    url: http://127.0.0.1:8018\n    models:\n      default: same-model\n  b:\n    url: http://127.0.0.1:8034\n    models:\n      default: same-model\n",
      { mode: 0o600 }
    );
    const c = capture();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((x: string | Uint8Array) => (lines.push(String(x)), true));
    try {
      expect(await runCli(GROUPS, ["worker", "config", "check", f], c.io)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain("model id same-model is declared by a, b");
  });
});
