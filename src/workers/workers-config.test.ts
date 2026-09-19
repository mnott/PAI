/**
 * Tests for workers.yaml — the human-editable providers/classes/mcp_sets/
 * active config that config.ts's read/write functions overlay onto the JSON
 * `workers` section. Every test runs against an isolated temp dir; none of
 * this ever touches the live ~/.config/pai.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkersSection, writeWorkersSection, parseWorkersConfig, WorkersConfigError } from "./config.js";
import {
  starterWorkersYamlText,
  workersYamlPath,
  readWorkersYaml,
  writeWorkersYamlText,
  initWorkersYaml,
  migrateWorkersToYaml,
} from "./workers-config.js";
import { addProvider, useProvider, setProviderEnabled } from "./providers.js";

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "pai-workers-yaml-"));
}

const dirs: string[] = [];
function newDir(): string {
  const d = tmpConfigDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("starter workers.yaml", () => {
  it("loads and validates", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = workersYamlPath(jsonPath);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("anthropic");
    expect(Object.keys(workers.providers).sort()).toEqual(["glm", "kimi"]);
    expect(workers.classes.implement).toBe("anthropic");
    expect(workers.classes.spotcheck).toBe("anthropic/fast");
    expect(workers.mcpSets.desktop).toEqual(["clickr"]);
    expect(workers.nativeModels.default).toBe("claude-sonnet-5");
  });
});

describe("load order — YAML beats JSON beats defaults", () => {
  it("uses built-in defaults when neither file has a workers section", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(jsonPath, JSON.stringify({ socketPath: "/tmp/x" }), "utf8");
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.providers).toEqual({});
    expect(workers.active).toBeNull();
  });

  it("falls back to the JSON workers section when no workers.yaml exists", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        workers: {
          active: "json-provider",
          providers: {
            "json-provider": { baseUrl: "https://json.example.com", models: { default: "json-model" } },
          },
        },
      }),
      "utf8"
    );
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("json-provider");
    expect(workers.providers["json-provider"].baseUrl).toBe("https://json.example.com");
  });

  it("prefers workers.yaml over a JSON workers section when both exist", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        workers: {
          active: "json-provider",
          providers: {
            "json-provider": { baseUrl: "https://json.example.com", models: { default: "json-model" } },
          },
        },
      }),
      "utf8"
    );
    writeWorkersYamlText(
      workersYamlPath(jsonPath),
      [
        "active: yaml-provider",
        "providers:",
        "  yaml-provider:",
        "    url: https://yaml.example.com",
        "    models:",
        "      default: yaml-model",
        "classes: {}",
        "mcp_sets: {}",
        "",
      ].join("\n")
    );
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("yaml-provider");
    expect(Object.keys(workers.providers)).toEqual(["yaml-provider"]);
    expect(workers.providers["yaml-provider"].baseUrl).toBe("https://yaml.example.com");
  });
});

describe("unknown provider in classes is a load error naming the line", () => {
  it("names the file and line of the offending class", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = workersYamlPath(jsonPath);
    const text = [
      "active: null",
      "providers:",
      "  real:",
      "    url: https://real.example.com",
      "    models:",
      "      default: real-model",
      "classes:",
      "  implement: real",
      "  spotcheck: ghost/fast",
      "mcp_sets: {}",
      "",
    ].join("\n");
    writeFileSync(yamlPath, text, "utf8");

    expect(() => readWorkersSection(jsonPath)).toThrow(WorkersConfigError);
    try {
      readWorkersSection(jsonPath);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(yamlPath);
      expect(msg).toMatch(/:9:/); // "spotcheck: ghost/fast" is line 9
      expect(msg).toContain('no provider named "ghost"');
    }
  });
});

describe("provider/role resolution, including fast", () => {
  it("resolves a class's provider/fast target to the fast model", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeWorkersYamlText(
      workersYamlPath(jsonPath),
      [
        "active: real",
        "providers:",
        "  real:",
        "    url: https://real.example.com",
        "    models:",
        "      default: real-default",
        "      fast: real-fast",
        "classes:",
        "  spotcheck: real/fast",
        "  implement: real",
        "mcp_sets: {}",
        "",
      ].join("\n")
    );
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.classes.spotcheck).toBe("real/fast");
    expect(workers.providers.real.models.fast).toBe("real-fast");
    expect(workers.providers.real.models.default).toBe("real-default");
  });

  it("rejects a role that names no known model capability", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    // written directly (not via writeWorkersYamlText) — this simulates a
    // hand-edited file with a mistake, which write's own validate-before-
    // commit guard would otherwise refuse to ever create in the first place
    writeFileSync(
      workersYamlPath(jsonPath),
      [
        "active: real",
        "providers:",
        "  real:",
        "    url: https://real.example.com",
        "    models:",
        "      default: real-default",
        "classes:",
        "  spotcheck: real/turbo",
        "mcp_sets: {}",
        "",
      ].join("\n"),
      "utf8"
    );
    expect(() => readWorkersSection(jsonPath)).toThrow(/unknown model role "turbo"/);
  });
});

describe("comment preservation across add → use → disable", () => {
  it("keeps a hand-written comment above an untouched provider byte-for-byte", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = workersYamlPath(jsonPath);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());

    addProvider({
      name: "newprov",
      baseUrl: "https://newprov.example.com",
      model: "newprov-default",
      configPath: jsonPath,
    });

    // hand-edit: add a fourth provider (inside the providers: map) with a
    // comment above it, right before the classes section starts
    let text = readFileSync(yamlPath, "utf8");
    text = text.replace(
      "\n# A class names a provider",
      "\n  # a new provider I am testing\n  handadded:\n    url: https://handadded.example.com\n    models:\n      default: handadded-default\n\n# A class names a provider"
    );
    writeFileSync(yamlPath, text, "utf8");

    useProvider("handadded", jsonPath);
    setProviderEnabled("newprov", false, jsonPath);

    const final = readFileSync(yamlPath, "utf8");
    expect(final).toContain("# a new provider I am testing");
    expect(final).toMatch(/active: handadded/);
    expect(final).toMatch(/newprov:\s*\n\s*enabled: false/);
  });
});

describe("migrate", () => {
  it("is idempotent and refuses without --force", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        socketPath: "/tmp/x",
        workers: {
          active: "old-provider",
          providers: {
            "old-provider": { baseUrl: "https://old.example.com", models: { default: "old-model" } },
          },
        },
      }),
      "utf8"
    );

    const r1 = migrateWorkersToYaml(jsonPath);
    expect(r1.dryRun).toBe(false);
    expect(existsSync(r1.yamlPath)).toBe(true);
    expect(existsSync(r1.backupPath!)).toBe(true);

    const rawAfter = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(rawAfter.socketPath).toBe("/tmp/x");
    expect(rawAfter.workers?.providers).toBeUndefined();
    expect(rawAfter.workers?.active).toBeUndefined();

    expect(() => migrateWorkersToYaml(jsonPath)).toThrow(/already exists/);
    expect(() => migrateWorkersToYaml(jsonPath, { force: true })).not.toThrow();
  });

  it("dry run writes nothing", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        workers: {
          active: "old-provider",
          providers: {
            "old-provider": { baseUrl: "https://old.example.com", models: { default: "old-model" } },
          },
        },
      }),
      "utf8"
    );
    const r = migrateWorkersToYaml(jsonPath, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(existsSync(r.yamlPath)).toBe(false);
    expect(r.yamlText).toContain("old-provider");
    const rawStill = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(rawStill.workers.providers["old-provider"]).toBeDefined();
  });
});

describe("init", () => {
  it("writes a file that loads and validates, and refuses a second time", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const path = initWorkersYaml(jsonPath);
    expect(path).toBe(workersYamlPath(jsonPath));
    const loaded = readWorkersYaml(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.data.active).toBe("anthropic");
    expect(() => initWorkersYaml(jsonPath)).toThrow(/already exists/);
  });
});

describe("writeWorkersSection strips providers/classes/mcpSets/active from JSON once YAML exists", () => {
  it("keeps pane/routing/etc in JSON but not providers", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    writeWorkersYamlText(workersYamlPath(jsonPath), starterWorkersYamlText());

    const { raw, workers } = readWorkersSection(jsonPath);
    workers.pane.fontSize = 20;
    writeWorkersSection(raw, workers, jsonPath);

    const rawJson = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(rawJson.workers.pane.fontSize).toBe(20);
    expect(rawJson.workers.providers).toBeUndefined();
    expect(rawJson.workers.classes).toBeUndefined();
    expect(rawJson.workers.active).toBeUndefined();

    // and the YAML still has the real data
    const reloaded = readWorkersSection(jsonPath);
    expect(reloaded.workers.active).toBe("anthropic");
    expect(Object.keys(reloaded.workers.providers).sort()).toEqual(["glm", "kimi"]);
  });
});
