/**
 * `pai worker priority` — read and change workers.priority.sessions without
 * editing workers.yaml by hand. Every case runs against a temp workers.yaml
 * (PAI_WORKERS_YAML), never the live one.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUPS } from "../registry.js";
import { runCli, type Io } from "../run.js";
import { makeStyle } from "../help.js";
import { workerPriorityCommand } from "./worker-config.js";
import { readPrioritySessions } from "../../workers/workers-config.js";
import { queuePriorityOf } from "../../workers/run/gate.js";

const sub = (name: string) => workerPriorityCommand.subcommands!.find((c) => c.name === name)!;

const USER = [
  "# my providers",
  "providers:",
  "  gyro:",
  "    url: http://127.0.0.1:8080",
  "    models:",
  "      default: gyro-m",
  "classes:",
  "  draft: gyro",
  "",
].join("\n");

let dir: string;
let yaml: string;
let savedYaml: string | undefined;
let written: string[];
let errs: string[];
const io: Io = { out: (s) => written.push(s), err: (s) => errs.push(s), style: makeStyle(false) };

beforeEach(() => {
  savedYaml = process.env.PAI_WORKERS_YAML;
  dir = mkdtempSync(join(tmpdir(), "pai-priority-"));
  yaml = join(dir, "workers.yaml");
  process.env.PAI_WORKERS_YAML = yaml;
  writeFileSync(yaml, USER, { mode: 0o600 });
  written = [];
  errs = [];
  // the command definitions' `out` writes process.stdout; capture it like the
  // other CLI tests do (worker.test.ts, worker-config.test.ts)
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (written.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (errs.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYaml;
});

describe("worker priority: declared surface", () => {
  it("is registered under worker with list, set, clear", () => {
    const worker = GROUPS.flatMap((g) => g.commands).find((c) => c.name === "worker")!;
    const c = worker.subcommands!.find((x) => x.name === "priority")!;
    expect(c).toBe(workerPriorityCommand);
    expect(c.subcommands!.map((s) => s.name)).toEqual(["list", "set", "clear"]);
    expect(sub("set").args!.map((a) => a.name)).toEqual(["SESSION", "PRIORITY"]);
  });
});

describe("worker priority: set / list / clear", () => {
  it("set writes the entry, keeps comments and every other key", async () => {
    expect(await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "high"], io)).toBe(0);
    expect(written.join("")).toContain("Jobs: high priority");
    const text = readFileSync(yaml, "utf8");
    expect(text).toContain("# my providers");
    expect(text).toContain("url: http://127.0.0.1:8080");
    expect(text).toContain("draft: gyro");
    expect(text).toMatch(/sessions:\s*\n\s+Jobs: high/);
    expect(readPrioritySessions(yaml)).toEqual({ Jobs: "high" });
  });

  it("an unknown session name is allowed (sessions may not be running)", async () => {
    expect(await runCli(GROUPS, ["worker", "priority", "set", "NotRunning", "low"], io)).toBe(0);
    expect(readPrioritySessions(yaml)).toEqual({ NotRunning: "low" });
  });

  it("list prints each session and the default", async () => {
    expect(await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "high"], io)).toBe(0);
    expect(await runCli(GROUPS, ["worker", "priority", "set", "Background", "low"], io)).toBe(0);
    written.length = 0;
    expect(await runCli(GROUPS, ["worker", "priority"], io)).toBe(0);
    const text = written.join("");
    expect(text).toContain("Jobs  high");
    expect(text).toContain("Background  low");
    expect(text).toContain("default: normal");
  });

  it("set normal removes the entry", async () => {
    await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "high"], io);
    written.length = 0;
    expect(await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "normal"], io)).toBe(0);
    expect(readPrioritySessions(yaml)).toEqual({});
    expect(readFileSync(yaml, "utf8")).not.toContain("Jobs");
  });

  it("clear removes the entry; clearing an unset session exits 1", async () => {
    await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "high"], io);
    written.length = 0;
    expect(await runCli(GROUPS, ["worker", "priority", "clear", "Jobs"], io)).toBe(0);
    expect(readPrioritySessions(yaml)).toEqual({});
    errs.length = 0;
    expect(await runCli(GROUPS, ["worker", "priority", "clear", "Jobs"], io)).toBe(1);
    expect(errs.join("")).toContain('no priority entry for session "Jobs"');
  });

  it("an invalid value is rejected and changes nothing", async () => {
    await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "high"], io);
    const before = readFileSync(yaml, "utf8");
    errs.length = 0;
    written.length = 0;
    expect(await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "urgent"], io)).toBe(1);
    expect(errs.join("")).toContain("priority must be high, normal or low");
    expect(readFileSync(yaml, "utf8")).toBe(before);
  });

  it("a missing argument exits 2 without touching the file", async () => {
    const before = readFileSync(yaml, "utf8");
    expect(await runCli(GROUPS, ["worker", "priority", "set", "Jobs"], io)).toBe(2);
    expect(readFileSync(yaml, "utf8")).toBe(before);
  });

  it("the entry the gate reads: a set session beats normal, an unset one stays normal", async () => {
    await runCli(GROUPS, ["worker", "priority", "set", "Jobs", "high"], io);
    const cfg = { priority: { sessions: readPrioritySessions(yaml) } };
    expect(queuePriorityOf(undefined, { sessionKey: "Jobs" }, cfg)).toBe("high");
    expect(queuePriorityOf(undefined, { sessionKey: "Other" }, cfg)).toBe("normal");
  });
});
