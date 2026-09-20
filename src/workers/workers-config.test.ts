/**
 * Tests for workers.yaml — the human-editable providers/classes/mcp_sets/
 * active config that config.ts's read/write functions overlay onto the JSON
 * `workers` section. Every test runs against an isolated temp dir, pointed
 * at via PAI_WORKERS_YAML (workers.yaml no longer lives next to config.json —
 * see workersYamlPath); none of this ever touches the live ~/.claude or
 * ~/.config/pai.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readWorkersSection, writeWorkersSection, parseWorkersConfig, WorkersConfigError } from "./config.js";
import {
  starterWorkersYamlText,
  workersYamlPath,
  workersYamlLegacyNotice,
  needsWorkersYamlRelocation,
  relocateWorkersYaml,
  inlineWorkersYamlKeys,
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
const savedYamlEnv = process.env.PAI_WORKERS_YAML;
function newDir(): string {
  const d = tmpConfigDir();
  dirs.push(d);
  return d;
}

/** Points workersYamlPath() at a file inside an isolated temp dir for one test. */
function isolateYaml(dir: string): string {
  const yamlPath = join(dir, "workers.yaml");
  process.env.PAI_WORKERS_YAML = yamlPath;
  return yamlPath;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedYamlEnv === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYamlEnv;
});

describe("starter workers.yaml", () => {
  it("loads and validates", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("anthropic");
    expect(Object.keys(workers.providers).sort()).toEqual(["glm", "kimi"]);
    expect(workers.classes.implement).toBe("anthropic");
    expect(workers.classes.spotcheck).toBe("anthropic/fast");
    expect(workers.mcpSets.desktop).toEqual(["clickr"]);
    expect(workers.nativeModels.default).toBe("claude-sonnet-5");
    // the starter's example providers carry a placeholder inline key
    expect(workers.providers.glm.key).toBe("<your-api-key>");
  });
});

describe("load order — YAML beats JSON beats defaults", () => {
  it("uses built-in defaults when neither file has a workers section", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    isolateYaml(dir);
    writeFileSync(jsonPath, JSON.stringify({ socketPath: "/tmp/x" }), "utf8");
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.providers).toEqual({});
    expect(workers.active).toBeNull();
  });

  it("falls back to the JSON workers section when no workers.yaml exists", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    isolateYaml(dir);
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
    const yamlPath = isolateYaml(dir);
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
      yamlPath,
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
    const yamlPath = isolateYaml(dir);
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
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(
      yamlPath,
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
    const yamlPath = isolateYaml(dir);
    // written directly (not via writeWorkersYamlText) — this simulates a
    // hand-edited file with a mistake, which write's own validate-before-
    // commit guard would otherwise refuse to ever create in the first place
    writeFileSync(
      yamlPath,
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
    const yamlPath = isolateYaml(dir);
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

describe("inline key: field", () => {
  it("writes a quoted key: and resolves through addProvider → the CLI's --key path", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    addProvider({
      name: "demo",
      baseUrl: "https://demo.example.invalid",
      model: "demo-model",
      inlineKey: "demo-secret-1234",
      configPath: jsonPath,
    });
    const text = readFileSync(yamlPath, "utf8");
    expect(text).toMatch(/key:\s*"demo-secret-1234"/);

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.providers.demo.key).toBe("demo-secret-1234");
  });

  it("quotes a purely numeric key so it round-trips as a string, not a number", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    addProvider({
      name: "numeric",
      baseUrl: "https://numeric.example.invalid",
      model: "m",
      inlineKey: "123456789012345678",
      configPath: jsonPath,
    });
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.providers.numeric.key).toBe("123456789012345678");
    expect(typeof workers.providers.numeric.key).toBe("string");
  });
});

describe("key or key_file: neither is required (local/no-auth providers stay valid)", () => {
  it("a provider with neither still loads — this is the documented local-server shape", () => {
    // The spec that motivated inline keys also asked for a hard validation
    // error when a non-builtin provider has neither key nor key_file. That
    // would break the pre-existing, documented and separately-tested
    // "local server, no auth" shape (config.ts's own doc comment, and
    // fallback.test.ts's "uses the local placeholder token" case) for every
    // provider — JSON or YAML — that intentionally omits both. Deliberately
    // not implemented; see the task report.
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(
      yamlPath,
      [
        "active: local",
        "providers:",
        "  local:",
        "    url: http://127.0.0.1:11434/v1",
        "    models:",
        "      default: local-model",
        "classes: {}",
        "mcp_sets: {}",
        "",
      ].join("\n")
    );
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.providers.local.key).toBeUndefined();
    expect(workers.providers.local.keyFile).toBeNull();
  });
});

describe("both key and key_file present", () => {
  it("key wins at resolution time", async () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    const keyFilePath = join(dir, "key_file_token");
    writeFileSync(keyFilePath, "from-file-token\n", "utf8");
    writeWorkersYamlText(
      yamlPath,
      [
        "active: both",
        "providers:",
        "  both:",
        `    url: https://both.example.invalid`,
        `    key_file: ${keyFilePath}`,
        `    key: "from-inline-token"`,
        "    models:",
        "      default: m",
        "classes: {}",
        "mcp_sets: {}",
        "",
      ].join("\n")
    );
    const { workers } = readWorkersSection(jsonPath);
    const { resolveProviderKey } = await import("./config.js");
    expect(resolveProviderKey(workers.providers.both)).toBe("from-inline-token");
  });
});

describe("masked rendering never leaks the key", () => {
  it("providers listing shows only **** + last 4 chars", async () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    isolateYaml(dir);
    addProvider({
      name: "demo",
      baseUrl: "https://demo.example.invalid",
      model: "m",
      inlineKey: "demo-secret-1234",
      configPath: jsonPath,
    });
    const { workers } = readWorkersSection(jsonPath);
    const { describeProviders } = await import("./providers.js");
    const lines = describeProviders(workers, jsonPath);
    const joined = lines.join("\n");
    expect(joined).toContain("****1234");
    expect(joined).not.toContain("demo-secret-1234");
  });
});

describe("migrate", () => {
  it("is idempotent and refuses without --force", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    isolateYaml(dir);
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
    isolateYaml(dir);
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
    const yamlPath = isolateYaml(dir);
    const path = initWorkersYaml();
    expect(path).toBe(yamlPath);
    const loaded = readWorkersYaml(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.data.active).toBe("anthropic");
    expect(() => initWorkersYaml()).toThrow(/already exists/);
    void jsonPath;
  });

  it("writes the file mode 0600", () => {
    const dir = newDir();
    const yamlPath = isolateYaml(dir);
    initWorkersYaml();
    const mode = statSync(yamlPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("workersYamlPath resolution and the legacy transition", () => {
  it("PAI_WORKERS_YAML overrides everything", () => {
    const dir = newDir();
    const custom = join(dir, "custom-workers.yaml");
    process.env.PAI_WORKERS_YAML = custom;
    expect(workersYamlPath()).toBe(custom);
    expect(workersYamlLegacyNotice()).toBeNull();
    expect(needsWorkersYamlRelocation()).toBe(false);
  });
});

describe("writeWorkersSection strips providers/classes/mcpSets/active from JSON once YAML exists", () => {
  it("keeps pane/routing/etc in JSON but not providers", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());

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

describe("inline-keys", () => {
  it("moves a key_file's contents inline, quotes it, chmods, and keeps the key file on disk", () => {
    const dir = newDir();
    const yamlPath = isolateYaml(dir);
    const keyFilePath = join(dir, "token");
    writeFileSync(keyFilePath, "  file-token-9999  \n", "utf8");
    writeWorkersYamlText(
      yamlPath,
      [
        "active: demo",
        "providers:",
        "  demo:",
        "    url: https://demo.example.invalid",
        `    key_file: ${keyFilePath}`,
        "    models:",
        "      default: m",
        "classes: {}",
        "mcp_sets: {}",
        "",
      ].join("\n")
    );
    chmodSync(yamlPath, 0o644);

    const r = inlineWorkersYamlKeys();
    expect(r.dryRun).toBe(false);
    expect(r.inlined).toEqual([{ provider: "demo", keyFilePath }]);

    const text = readFileSync(yamlPath, "utf8");
    expect(text).toMatch(/key:\s*"file-token-9999"/);
    expect(text).not.toContain("key_file");
    expect(existsSync(keyFilePath)).toBe(true); // never deleted
    expect(statSync(yamlPath).mode & 0o777).toBe(0o600);

    // idempotent: nothing left to inline
    const r2 = inlineWorkersYamlKeys();
    expect(r2.inlined).toEqual([]);
  });

  it("--dry-run writes nothing and never prints the key value", () => {
    const dir = newDir();
    const yamlPath = isolateYaml(dir);
    const keyFilePath = join(dir, "token");
    writeFileSync(keyFilePath, "file-token-9999\n", "utf8");
    writeWorkersYamlText(
      yamlPath,
      [
        "active: demo",
        "providers:",
        "  demo:",
        "    url: https://demo.example.invalid",
        `    key_file: ${keyFilePath}`,
        "    models:",
        "      default: m",
        "classes: {}",
        "mcp_sets: {}",
        "",
      ].join("\n")
    );
    const before = readFileSync(yamlPath, "utf8");

    const r = inlineWorkersYamlKeys({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.inlined).toEqual([{ provider: "demo", keyFilePath }]);

    const after = readFileSync(yamlPath, "utf8");
    expect(after).toBe(before);
    expect(after).toContain("key_file");
  });
});

describe("relocating workers.yaml from an old default location", () => {
  const savedHome = process.env.HOME;
  const savedPaiHome = process.env.PAI_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPaiHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = savedPaiHome;
  });

  it("moves ~/.claude/workers.yaml to ~/.claude/pai/workers.yaml, renaming the old file aside", () => {
    const dir = newDir();
    delete process.env.PAI_WORKERS_YAML;
    delete process.env.PAI_HOME;
    process.env.HOME = dir;
    const oldPath = join(dir, ".claude", "workers.yaml");
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, starterWorkersYamlText(), { encoding: "utf8", mode: 0o644 });

    expect(needsWorkersYamlRelocation()).toBe(true);
    const r = relocateWorkersYaml();
    expect(r.dryRun).toBe(false);
    expect(r.fromPath).toBe(oldPath);

    const newPath = join(dir, ".claude", "pai", "workers.yaml");
    expect(r.toPath).toBe(newPath);
    expect(readFileSync(newPath, "utf8")).toBe(starterWorkersYamlText());
    expect(statSync(newPath).mode & 0o777).toBe(0o600);

    // old file renamed aside, never deleted
    expect(existsSync(oldPath)).toBe(false);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(existsSync(`${oldPath}.migrated-${stamp}`)).toBe(true);

    expect(needsWorkersYamlRelocation()).toBe(false);
    expect(workersYamlPath()).toBe(newPath);
  });

  it("prefers ~/.claude/workers.yaml over the older ~/.config/pai/workers.yaml when both exist", () => {
    const dir = newDir();
    delete process.env.PAI_WORKERS_YAML;
    delete process.env.PAI_HOME;
    process.env.HOME = dir;
    const oldPath = join(dir, ".claude", "workers.yaml");
    const olderPath = join(dir, ".config", "pai", "workers.yaml");
    mkdirSync(dirname(oldPath), { recursive: true });
    mkdirSync(dirname(olderPath), { recursive: true });
    writeFileSync(oldPath, "active: old\nproviders: {}\nclasses: {}\nmcp_sets: {}\n", {
      encoding: "utf8",
      mode: 0o644,
    });
    writeFileSync(olderPath, "active: older\nproviders: {}\nclasses: {}\nmcp_sets: {}\n", {
      encoding: "utf8",
      mode: 0o644,
    });

    const r = relocateWorkersYaml();
    expect(r.fromPath).toBe(oldPath);
    expect(readFileSync(r.toPath, "utf8")).toContain("active: old");
    // the older location is untouched
    expect(existsSync(olderPath)).toBe(true);
  });

  it("is idempotent: running again with nothing left to relocate is a no-op, not an error", () => {
    const dir = newDir();
    delete process.env.PAI_WORKERS_YAML;
    delete process.env.PAI_HOME;
    process.env.HOME = dir;
    expect(needsWorkersYamlRelocation()).toBe(false);
    const r = relocateWorkersYaml();
    expect(r.fromPath).toBeNull();
  });
});
