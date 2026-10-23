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
import { readWorkersSection, writeWorkersSection, parseWorkersConfig, parseProvider, WorkersConfigError } from "./config.js";
import {
  starterWorkersYamlText,
  workersYamlPath,
  workersYamlLegacyNotice,
  needsWorkersYamlRelocation,
  relocateWorkersYaml,
  inlineWorkersYamlKeys,
  readWorkersYaml,
  readMergeVerify,
  writeWorkersYamlText,
  initWorkersYaml,
  migrateWorkersToYaml,
} from "./workers-config.js";
import { addProvider, useProvider, setProviderEnabled, setClass, setProviderModel } from "./providers.js";

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
    // the starter's worker / quick rows migrate into the tiers (Quick check folds into t2, its differing order noted)
    expect(workers.classes.worker).toBeUndefined();
    expect(workers.tiers.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(workers.tiers[2]).toMatchObject({ models: ["anthropic"], default: true });
    expect(workers.tiers[2]!.description).toContain("anthropic/fast");
    expect(workers.mcpSets.desktop).toEqual(["clickr"]);
    expect(workers.nativeModels.default).toBe("sonnet");
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
    expect(workers.tiers.find((t) => t.id === "t2")!.models).toEqual(["real"]);
    expect(workers.tiers.find((t) => t.id === "t2")!.description).toContain("real/fast");
    expect(workers.providers.real.models.fast).toBe("real-fast");
    expect(workers.providers.real.models.default).toBe("real-default");
  });

  it("rejects a role whose provider has no such model configured", () => {
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
    expect(() => readWorkersSection(jsonPath)).toThrow(/provider "real" has no "turbo" model configured/);
  });

  it("rejects a role name that is not well-formed, even though the set of names is open", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
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
        "  spotcheck: real/Turbo",
        "mcp_sets: {}",
        "",
      ].join("\n"),
      "utf8"
    );
    expect(() => readWorkersSection(jsonPath)).toThrow(/not a valid capability name/);
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

describe("useProvider re-points classes pinned to a provider", () => {
  it("re-points a plain string target and preserves a string's /alias", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    addProvider({
      name: "newprov",
      baseUrl: "https://newprov.example.com",
      model: "newprov-default",
      fastModel: "newprov-fast",
      configPath: jsonPath,
    });
    setProviderModel("newprov", "image", "newprov-image", jsonPath);

    const { repointed } = useProvider("newprov", jsonPath);

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("newprov");
    // the tiers are explicit ordered lists: `use` does not rewrite them
    expect(workers.tiers.find((t) => t.id === "t2")!.models).toEqual(["anthropic"]);
    // "image: glm/image" keeps its alias, just re-pointed to the new provider
    expect(workers.classes.image).toBe("newprov/image");
    expect(repointed).toBe(Object.keys(workers.classes).length);
  });

  it("re-points an object target's provider field, keeping every other field", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    addProvider({
      name: "newprov",
      baseUrl: "https://newprov.example.com",
      model: "newprov-default",
      fastModel: "newprov-fast",
      configPath: jsonPath,
    });
    setProviderModel("newprov", "image", "newprov-image", jsonPath);
    setClass("pinned", { provider: "glm", mcp: ["fs"], maxCostTier: 2 }, jsonPath);

    const { repointed } = useProvider("newprov", jsonPath);

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.classes.pinned).toEqual({ provider: "newprov", mcp: ["fs"], maxCostTier: 2 });
    expect(repointed).toBeGreaterThan(0);
  });

  it("leaves a constraint-only object target (no provider) untouched", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    addProvider({
      name: "newprov",
      baseUrl: "https://newprov.example.com",
      model: "newprov-default",
      fastModel: "newprov-fast",
      configPath: jsonPath,
    });
    setProviderModel("newprov", "image", "newprov-image", jsonPath);
    setClass("auto-routed", { maxCostTier: 2, requireTags: ["fast"] }, jsonPath);

    useProvider("newprov", jsonPath);

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.classes["auto-routed"]).toEqual({ maxCostTier: 2, requireTags: ["fast"] });
  });

  it("drops the /alias when the new provider has no such model, still re-pointing", () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    // no fastModel/image: this provider only has a default model configured
    addProvider({
      name: "barebones",
      baseUrl: "https://barebones.example.com",
      model: "barebones-default",
      configPath: jsonPath,
    });

    const { repointed } = useProvider("barebones", jsonPath);

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("barebones");
    // implement had no alias: re-pointed
    expect(workers.tiers.find((t) => t.id === "t2")!.models).toEqual(["anthropic"]);
    // image needed a model "barebones" doesn't have: alias dropped,
    // still moved to barebones (its default model) rather than left on the
    // old provider
    expect(workers.classes.image).toBe("barebones");
    expect(repointed).toBe(Object.keys(workers.classes).length);
  });

  it('"use auto" sets active only and leaves every pinned class alone', () => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    const before = readWorkersSection(jsonPath).workers.classes;

    const { repointed } = useProvider("auto", jsonPath);

    const { workers } = readWorkersSection(jsonPath);
    expect(workers.active).toBe("auto");
    expect(workers.classes).toEqual(before);
    expect(repointed).toBe(0);
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

  it("moves ~/.claude/workers.yaml to ~/.pai/workers.yaml, renaming the old file aside", () => {
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

    const newPath = join(dir, ".pai", "workers.yaml");
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

describe("merge.verify", () => {
  it("reads the string, undefined when unset, and rejects a non-string", () => {
    const d = newDir();
    const p = join(d, "workers.yaml");
    expect(readMergeVerify(p)).toBeUndefined();
    writeFileSync(p, "merge:\n  verify: npx tsc --noEmit\n", "utf8");
    expect(readMergeVerify(p)).toBe("npx tsc --noEmit");
    writeFileSync(p, "providers: {}\n", "utf8");
    expect(readMergeVerify(p)).toBeUndefined();
    writeFileSync(p, "merge:\n  verify: 42\n", "utf8");
    expect(() => readMergeVerify(p)).toThrow(/merge\.verify: must be a non-empty string/);
    writeFileSync(p, "merge: nope\n", "utf8");
    expect(() => readMergeVerify(p)).toThrow(/merge: must be a mapping/);
  });
});

describe("provider router key in workers.yaml", () => {
  function setup() {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    const { raw, workers } = readWorkersSection(jsonPath);
    const name = Object.keys(workers.providers).find((n) => n !== "anthropic")!;
    return { jsonPath, yamlPath, raw, workers, name };
  }

  it("absent key leaves router undefined", () => {
    const { workers, name } = setup();
    expect(workers.providers[name].router).toBeUndefined();
  });

  it("router: false is read from yaml and kept by a round-trip write", () => {
    const { jsonPath, yamlPath, raw, workers, name } = setup();
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(new RegExp(`^(  ${name}:\\n)`, "m"), "$1    router: false\n"));
    const read = readWorkersSection(jsonPath);
    expect(read.workers.providers[name].router).toBe(false);
    writeWorkersSection(read.raw, read.workers, jsonPath);
    expect(readWorkersSection(jsonPath).workers.providers[name].router).toBe(false);
    void raw; void workers;
  });

  it("writing router: false on a provider persists it to yaml", () => {
    const { jsonPath, yamlPath, raw, workers, name } = setup();
    workers.providers[name].router = false;
    writeWorkersSection(raw, workers, jsonPath);
    expect(readFileSync(yamlPath, "utf8")).toMatch(/router: false/);
    expect(readWorkersSection(jsonPath).workers.providers[name].router).toBe(false);
  });

  it("rejects a non-boolean router", () => {
    const { jsonPath, yamlPath, name } = setup();
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(new RegExp(`^(  ${name}:\\n)`, "m"), "$1    router: nope\n"));
    expect(() => readWorkersSection(jsonPath)).toThrow(/router/);
  });
});

describe("provider contract key in workers.yaml", () => {
  function setup() {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText());
    const { raw, workers } = readWorkersSection(jsonPath);
    const name = Object.keys(workers.providers).find((n) => n !== "anthropic")!;
    return { jsonPath, yamlPath, raw, workers, name };
  }
  const addKey = (yamlPath: string, name: string, line: string) =>
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(new RegExp(`^(  ${name}:\\n)`, "m"), `$1    ${line}\n`));

  it("absent key leaves contract undefined", () => {
    const { workers, name } = setup();
    expect(workers.providers[name].contract).toBeUndefined();
  });

  it("contract is read from yaml and reaches the parsed provider", () => {
    const { jsonPath, yamlPath, name } = setup();
    addKey(yamlPath, name, "contract: /tmp/x-contract.md");
    expect(readWorkersSection(jsonPath).workers.providers[name].contract).toBe("/tmp/x-contract.md");
  });

  it("parseProvider honours contract and rejects a non-string", () => {
    const base = { baseUrl: "http://x", keyFile: "/tmp/k", models: { default: "a" } };
    expect(parseProvider("p", { ...base, contract: "/tmp/c.md" }).contract).toBe("/tmp/c.md");
    expect(() => parseProvider("p", { ...base, contract: 5 })).toThrow(/contract/);
  });

  it("contract survives a round-trip write", () => {
    const { jsonPath, yamlPath, name } = setup();
    addKey(yamlPath, name, "contract: /tmp/x-contract.md");
    const read = readWorkersSection(jsonPath);
    writeWorkersSection(read.raw, read.workers, jsonPath);
    expect(readFileSync(yamlPath, "utf8")).toMatch(/contract: \/tmp\/x-contract.md/);
    expect(readWorkersSection(jsonPath).workers.providers[name].contract).toBe("/tmp/x-contract.md");
  });
});

describe("worker_model", () => {
  const raw = (extra: Record<string, unknown>) => ({ baseUrl: "https://x.example.invalid", models: { default: "m", fast: "f" }, ...extra });
  it("parses default|fast, defaults to unset, rejects anything else", () => {
    expect(parseProvider("p", raw({ workerModel: "fast" })).workerModel).toBe("fast");
    expect(parseProvider("p", raw({})).workerModel).toBeUndefined();
    expect(() => parseProvider("p", raw({ workerModel: "slow" }))).toThrow(WorkersConfigError);
  });
  it("round-trips through the yaml key worker_model", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-"));
    const yamlPath = isolateYaml(dir);
    writeWorkersYamlText(yamlPath, starterWorkersYamlText().replace("    tier: 3\n    models:\n      default: glm-5.3[1m]", "    tier: 3\n    worker_model: fast\n    models:\n      default: glm-5.3[1m]"));
    expect(readWorkersSection(join(dir, "config.json")).workers.providers.glm.workerModel).toBe("fast");
  });
});

describe("provider characteristics (registered endpoints)", () => {
  const load = (extra: string[]) => {
    const dir = newDir();
    const jsonPath = join(dir, "config.json");
    const yamlPath = isolateYaml(dir);
    writeFileSync(
      yamlPath,
      ["active: null", "providers:", "  box:", "    url: http://box.lan:8000", "    models:", "      default: m", ...extra, "classes: {}", "mcp_sets: {}", ""].join("\n"),
      "utf8",
    );
    return readWorkersSection(jsonPath);
  };

  it("parses characteristics with context_tokens", () => {
    const w = load(["    characteristics:", "      classes: [t1]", "      context_tokens: 32000", "      tags: [fast]"]);
    expect(w.workers.providers.box.characteristics).toEqual({ classes: ["t1"], contextTokens: 32000, tags: ["fast"] });
  });

  it("rejects a bad context_tokens and an unknown key", () => {
    expect(() => load(["    characteristics:", "      context_tokens: -1"])).toThrow(/context_tokens/);
    expect(() => load(["    characteristics:", "      speed: 3"])).toThrow(/unknown key speed/);
  });
});

describe("workers.yaml writers touch only what they were asked to change", () => {
  const seed = (yamlPath: string): string => {
    // deliberately not in the serialiser's normal form (leading blank line, odd spacing)
    const text = "\nproviders:\n  glm:   # my note\n    enabled: true\n    url: http://x.invalid/v1\n    models: {default: m}\n  other:\n    enabled: false\n    url: http://y.invalid/v1\n    models: {default: n}\nactive: glm\n";
    writeFileSync(yamlPath, text);
    return text;
  };

  it("a write that changes nothing leaves the file byte-identical", () => {
    const dir = newDir();
    const yamlPath = isolateYaml(dir);
    const jsonPath = join(dir, "config.json");
    const text = seed(yamlPath);
    const { raw, workers } = readWorkersSection(jsonPath, () => {});
    const before = statSync(yamlPath).mtimeMs;
    writeWorkersSection(raw, workers, jsonPath);
    expect(readFileSync(yamlPath, "utf8")).toBe(text);
    expect(statSync(yamlPath).mtimeMs).toBe(before);
  });

  it("a stale read does not revert keys changed on disk meanwhile", () => {
    const dir = newDir();
    const yamlPath = isolateYaml(dir);
    const jsonPath = join(dir, "config.json");
    seed(yamlPath);
    const { raw, workers } = readWorkersSection(jsonPath, () => {});
    // someone else flips `other` on after this read
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace("enabled: false", "enabled: true"));
    workers.active = "other";
    writeWorkersSection(raw, workers, jsonPath);
    const out = readFileSync(yamlPath, "utf8");
    expect(out).toMatch(/other:\n\s+enabled: true/);
    expect(out).toMatch(/active: other/);
  });
});
