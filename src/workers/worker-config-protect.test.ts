import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pinWorkersYamlCopy } from "./run-env.js";
import { defaultWorkersYamlPath, inlineWorkersYamlKeys, writeWorkersYamlText } from "./workers-config.js";
import { decideWorkerGuard, type WorkerGuardContext } from "../hooks/ts/lib/worker-guard.js";

const SAVED = { ...process.env };
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pai-wcp-"));
});
afterEach(() => {
  process.env = { ...SAVED };
  rmSync(tmp, { recursive: true, force: true });
});

describe("pinWorkersYamlCopy", () => {
  it("points PAI_WORKERS_YAML at a 0600 copy of the live file outside ~/.claude/pai", () => {
    const live = join(tmp, "live.yaml");
    writeFileSync(live, "# live\nproviders: {}\n");
    process.env.PAI_WORKERS_YAML = live;
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PAI_WORKERS_YAML;
    pinWorkersYamlCopy(env, join(tmp, "copies"));
    const copy = env.PAI_WORKERS_YAML!;
    expect(copy).not.toBe(live);
    expect(copy.startsWith(join(tmp, "copies"))).toBe(true);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(live, "utf8"));
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  it("keeps a caller-set PAI_WORKERS_YAML", () => {
    const env: NodeJS.ProcessEnv = { PAI_WORKERS_YAML: "/tmp/mine.yaml" };
    pinWorkersYamlCopy(env, join(tmp, "copies"));
    expect(env.PAI_WORKERS_YAML).toBe("/tmp/mine.yaml");
  });
});

describe("worker config guard", () => {
  const home = "/home/u";
  const ctx: WorkerGuardContext = { cwd: "/w", home, worktreeRoot: "/w", inWorktree: true, mainCheckout: "/m", testScript: () => "vitest" };
  const run = (command: string, env: Record<string, string | undefined> = {}) =>
    decideWorkerGuard({ tool_name: "Bash", tool_input: { command } }, { PAI_WORKER: "1", ...env }, () => ctx).decision;

  it("denies mutating verbs against the live config", () => {
    expect(run("node x/dist/cli/index.mjs worker config inline-keys")).toBe("deny");
    expect(run("pai worker providers enable glm")).toBe("deny");
    expect(run("pai worker classes set simple glm")).toBe("deny");
  });
  it("allows them with a copy, a temp HOME, a dry run, or a read verb", () => {
    expect(run("PAI_WORKERS_YAML=/tmp/x.yaml pai worker providers enable glm")).toBe("allow");
    expect(run("HOME=/tmp/h pai worker config inline-keys")).toBe("allow");
    expect(run("pai worker config inline-keys", { PAI_WORKERS_YAML: "/tmp/copy/workers.yaml" })).toBe("allow");
    expect(run("pai worker config inline-keys --dry-run")).toBe("allow");
    expect(run("pai worker providers list")).toBe("allow");
    expect(run("PAI_WORKERS_YAML=/home/u/.claude/pai/workers.yaml pai worker providers enable glm")).toBe("deny");
  });
  it("denies writes to the live yaml by Bash and Write with the config reason", () => {
    const d = decideWorkerGuard({ tool_name: "Write", tool_input: { file_path: "/home/u/.claude/pai/workers.yaml" } }, { PAI_WORKER: "1" }, () => ctx);
    expect(d).toMatchObject({ decision: "deny", reason: expect.stringContaining("workers never write live PAI config") });
    expect(run("echo x > /home/u/.claude/settings.json")).toBe("deny");
  });
  it("is inactive outside workers", () => {
    expect(decideWorkerGuard({ tool_name: "Bash", tool_input: { command: "pai worker providers enable glm" } }, {}, () => ctx).decision).toBe("allow");
  });
});

describe("workers.yaml writer under PAI_WORKER=1", () => {
  it("refuses the default live path", () => {
    process.env.HOME = tmp; // defaultWorkersYamlPath() follows HOME via homedir()
    process.env.PAI_WORKER = "1";
    delete process.env.PAI_WORKERS_YAML;
    expect(() => writeWorkersYamlText(defaultWorkersYamlPath(), "providers: {}\n")).toThrow(/workers never write live PAI config/);
  });
  it("still writes a copy, and inline-keys on the live path is refused", () => {
    process.env.HOME = tmp;
    process.env.PAI_WORKER = "1";
    const copy = join(tmp, "copy.yaml");
    writeFileSync(copy, "providers: {}\n");
    writeWorkersYamlText(copy, "providers: {}\n");
    delete process.env.PAI_WORKERS_YAML;
    expect(() => inlineWorkersYamlKeys()).toThrow();
  });
});
