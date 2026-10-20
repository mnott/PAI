/**
 * The shipped default delegation table: a fresh config (no workers.yaml)
 * routes every standard class through the defaults' tiers, a user `tiers:`
 * block replaces them (no concatenation) and `pai worker classes` lists them.
 * Temp config dir only; the live files are never touched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkersSection } from "./config.js";
import { findTier } from "./route-lists.js";
import { workerClassesCommand } from "../cli/commands/worker-config.js";

const MAPPING: Record<string, string> = {
  orchestrate: "t1", plan: "t1",
  implement: "t2", research: "t2", draft: "t2", review: "t2", complex: "t2", simple: "t2", spotcheck: "t2",
};

let dir: string;
let configPath: string;
let yamlPath: string;
const saved = process.env.PAI_WORKERS_YAML;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-default-tiers-"));
  configPath = join(dir, "config.json");
  yamlPath = join(dir, "workers.yaml"); // not created: a fresh install
  writeFileSync(configPath, "{}\n", "utf8");
  process.env.PAI_WORKERS_YAML = yamlPath;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = saved;
  rmSync(dir, { recursive: true, force: true });
});

const read = () => readWorkersSection(configPath, () => {}).workers;

describe("shipped default delegation table", () => {
  it("a fresh config has t0 / t1 / t2 with the default model lists", () => {
    const { tiers } = read();
    expect(tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(tiers[0].models).toEqual(["anthropic/opus", "glm/glm-5.3"]);
    expect(tiers[0].session).toBe(true);
    expect(tiers[1].models).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash"]);
    // no local provider on a fresh install: the `local` placeholder drops out
    expect(tiers[2].models).toEqual(["anthropic/sonnet", "glm/glm-5.3-flash"]);
    for (const t of tiers) expect(t.note).toBeTruthy();
  });

  it("every standard class resolves to its tier", () => {
    const { tiers } = read();
    for (const [cls, id] of Object.entries(MAPPING)) expect(findTier(tiers, cls)?.id).toBe(id);
  });

  it("the same defaults apply under a user workers.yaml that names no tiers", () => {
    writeFileSync(yamlPath, "providers:\n  glm:\n    url: https://api.example.com/anthropic\n    key: k\n    models:\n      default: glm-1\n");
    expect(read().tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
  });

  it("a user tiers block replaces the defaults, lists included", () => {
    writeFileSync(yamlPath, "tiers:\n  - id: x1\n    name: Only\n    models: [anthropic/haiku]\n    default: true\n");
    const { tiers } = read();
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({ id: "x1", models: ["anthropic/haiku"] });
  });

  it("a user model list replaces the default list of the same tier", () => {
    writeFileSync(
      yamlPath,
      "tiers:\n  - id: t0\n    name: Session\n    models: [anthropic/haiku]\n    session: true\n  - id: t2\n    name: Worker\n    models: [anthropic/haiku]\n    default: true\n"
    );
    const { tiers } = read();
    expect(tiers.map((t) => t.models)).toEqual([["anthropic/haiku"], ["anthropic/haiku"]]);
  });

  it("`pai worker classes` on a fresh config lists the classes", () => {
    const prev = process.env.PAI_CONFIG_FILE;
    process.env.PAI_CONFIG_FILE = configPath;
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    try {
      workerClassesCommand.run!({ args: {}, flags: {}, io: { out: () => {}, err: () => {}, style: { dim: (s: string) => s } } } as never);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = prev;
    }
    const text = out.join("\n");
    for (const cls of Object.keys(MAPPING)) expect(text).toContain(cls);
    expect(text).not.toContain("no classes set");
  });
});
