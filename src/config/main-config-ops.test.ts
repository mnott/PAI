/**
 * main-config-ops.ts — `pai config list/get/set/unset`, shared with the
 * MCP config_* tools. Every case runs against a temp PAI_HOME/config.json
 * via PAI_CONFIG_FILE (set before daemon/config.ts is first imported, since
 * CONFIG_FILE is resolved once at module load).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;
const savedWorkersYaml = process.env.PAI_WORKERS_YAML;

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-main-config-ops-"));
  dirs.push(d);
  return d;
}

let configFile: string;
let listConfigOp: typeof import("./main-config-ops.js")["listConfigOp"];
let getConfigValueOp: typeof import("./main-config-ops.js")["getConfigValueOp"];
let setConfigValueOp: typeof import("./main-config-ops.js")["setConfigValueOp"];
let unsetConfigValueOp: typeof import("./main-config-ops.js")["unsetConfigValueOp"];
let formatConfigGetOutput: typeof import("./main-config-ops.js")["formatConfigGetOutput"];
let MainConfigOpsError: typeof import("./main-config-ops.js")["MainConfigOpsError"];
let yamlSiblingPath: typeof import("./main-config.js")["yamlSiblingPath"];

beforeAll(async () => {
  process.env.HOME = newDir();
  const paiHome = newDir();
  process.env.PAI_HOME = paiHome;
  configFile = join(paiHome, "config.json");
  process.env.PAI_CONFIG_FILE = configFile;
  process.env.PAI_WORKERS_YAML = join(paiHome, "workers.yaml");

  ({ listConfigOp, getConfigValueOp, setConfigValueOp, unsetConfigValueOp, formatConfigGetOutput, MainConfigOpsError } =
    await import("./main-config-ops.js"));
  ({ yamlSiblingPath } = await import("./main-config.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
  if (savedWorkersYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedWorkersYaml;
});

function yamlPath(): string {
  return yamlSiblingPath(configFile);
}

beforeEach(() => {
  for (const p of [configFile, yamlPath()]) {
    if (existsSync(p)) rmSync(p);
  }
});

describe("setConfigValueOp / getConfigValueOp round trip", () => {
  it("creates config.yaml from scratch, sets a value, and get resolves it back", () => {
    const r = setConfigValueOp("search.recencyBoostDays", "45", {});

    expect(r.yamlCreated).toBe(true);
    expect(existsSync(yamlPath())).toBe(true);

    const got = getConfigValueOp("search.recencyBoostDays");
    expect(got.found).toBe(true);
    expect(got.value).toBe(45);
  });

  it("preserves a hand-written comment across a set", () => {
    writeFileSync(yamlPath(), "# keep this comment\nsearch:\n  recencyBoostDays: 90\n", "utf-8");

    setConfigValueOp("search.recencyBoostDays", "45", {});

    const text = readFileSync(yamlPath(), "utf-8");
    expect(text).toContain("# keep this comment");
    expect(text).toContain("recencyBoostDays: 45");

    expect(getConfigValueOp("search.recencyBoostDays").value).toBe(45);
  });

  it("parses true/false, null, numbers and JSON arrays/objects", () => {
    setConfigValueOp("search.rerank", "false", {});
    expect(getConfigValueOp("search.rerank").value).toBe(false);

    setConfigValueOp("search.defaultLimit", "7", {});
    expect(getConfigValueOp("search.defaultLimit").value).toBe(7);

    setConfigValueOp("identity.selfEmails", '["a@example.com","b@example.com"]', {});
    expect(getConfigValueOp("identity.selfEmails").value).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("unsetConfigValueOp", () => {
  it("removes a set value, reverting get to the built-in default", () => {
    setConfigValueOp("search.recencyBoostDays", "45", {});
    expect(getConfigValueOp("search.recencyBoostDays").value).toBe(45);

    const r = unsetConfigValueOp("search.recencyBoostDays");
    expect(r.existed).toBe(true);
    expect(getConfigValueOp("search.recencyBoostDays").value).toBe(90);
  });

  it("no-ops when the path was never set", () => {
    const r = unsetConfigValueOp("search.recencyBoostDays");
    expect(r.existed).toBe(false);
  });
});

describe("formatConfigGetOutput", () => {
  it("prints a scalar as-is regardless of json flag", () => {
    expect(formatConfigGetOutput(45)).toBe("45");
    expect(formatConfigGetOutput(45, { json: true })).toBe("45");
    expect(formatConfigGetOutput(false)).toBe("false");
  });

  it("prints an object subtree as YAML by default", () => {
    const out = formatConfigGetOutput({ recencyBoostDays: 45, rerank: false });
    expect(out).toContain("recencyBoostDays: 45");
    expect(out).toContain("rerank: false");
    expect(out).not.toContain("{");
  });

  it("prints an object subtree as JSON when json is passed", () => {
    const out = formatConfigGetOutput({ recencyBoostDays: 45 }, { json: true });
    expect(out).toBe(JSON.stringify({ recencyBoostDays: 45 }, null, 2));
  });

  it("prints an array subtree as YAML by default", () => {
    const out = formatConfigGetOutput(["a@example.com", "b@example.com"]);
    expect(out).toContain("- a@example.com");
    expect(out).toContain("- b@example.com");
  });
});

describe("secret masking", () => {
  it("masks postgres.connectionString and a *Key/token/secret/password field in list and get", () => {
    setConfigValueOp("postgres.connectionString", "postgresql://pai:hunter2@localhost:5432/pai", { force: true });
    setConfigValueOp("tasks.providers.todoist.apiKey", "sk-super-secret-token-9999", { force: true });

    const got = getConfigValueOp("postgres.connectionString");
    expect(got.value).not.toContain("hunter2");
    expect(got.value).toBe("****/pai");

    const list = listConfigOp({});
    expect(list.yaml).not.toContain("hunter2");
    expect(list.yaml).not.toContain("sk-super-secret-token-9999");
    expect(list.yaml).toContain("****9999");
    expect(JSON.stringify(list.data)).not.toContain("hunter2");
  });
});

describe("type validation refusals", () => {
  it("refuses an unknown top-level key without --force", () => {
    expect(() => setConfigValueOp("notARealTopLevelKey", "1", {})).toThrow(MainConfigOpsError);
    expect(getConfigValueOp("notARealTopLevelKey").found).toBe(false);
  });

  it("--force allows an unknown top-level key", () => {
    const r = setConfigValueOp("notARealTopLevelKey", "1", { force: true });
    expect(r.value).toBe(1);
    expect(getConfigValueOp("notARealTopLevelKey").value).toBe(1);
  });

  it("refuses a value whose type disagrees with the default without --force", () => {
    expect(() => setConfigValueOp("search.recencyBoostDays", "not-a-number", {})).toThrow(MainConfigOpsError);
  });

  it("--force allows a type mismatch", () => {
    const r = setConfigValueOp("search.recencyBoostDays", "not-a-number", { force: true });
    expect(r.value).toBe("not-a-number");
  });
});
