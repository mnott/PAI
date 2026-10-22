import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, homeRel } from "../daemon/config.js";
import { normalizeRegistryPaths } from "../router/cockpit-registry.js";
import { parseLocalConfig } from "./local-tiers.js";
import { providerKeyPath } from "./config.js";
import { addProvider } from "./providers.js";
import { normalizePathsText } from "./normalize-paths.js";

const FAKE = "/home/user";
const YAML = `# top comment
providers:
  glm:
    url: https://example.invalid/v1
    key_file: ${FAKE}/.claude/pai/keys/glm   # keep me
    models: { default: m }
  other:
    key_file: "${FAKE}/keys/other"
  rel:
    key_file: ~/.claude/pai/keys/rel
  elsewhere:
    key_file: /srv/keys/x
  note-only:
    note: "see ${FAKE}/docs"
`;

describe("homeRel / expandHome", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HOME;
    process.env.HOME = FAKE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });

  it("round-trips and leaves foreign paths alone", () => {
    expect(homeRel(`${FAKE}/a/b`)).toBe("~/a/b");
    expect(homeRel(FAKE)).toBe("~");
    expect(homeRel(`${FAKE}x/a`)).toBe(`${FAKE}x/a`);
    expect(homeRel("/srv/x")).toBe("/srv/x");
    expect(expandHome(homeRel(`${FAKE}/a/b`))).toBe(`${FAKE}/a/b`);
  });

  it("the loader expands every path-typed field through expandHome", () => {
    expect(providerKeyPath({ keyFile: "~/k" } as never)).toBe(`${FAKE}/k`);
    const cfg = parseLocalConfig(
      {
        local_launcher: { python: "~/py", script: "~/sc" },
        local_tiers: {
          a: { engine: "vllm-mlx", provider: "p", model: "~/m", port: 1, served: "s" },
          b: { engine: "strata", provider: "p", config: "~/c.yaml", python: "~/py2", port: 2 },
          c: { engine: "script", provider: "p", start: "~/run.sh", port: 3 },
          d: { engine: "command", provider: "p", location: "~/loc", start_command: "x {port}", health: "http://h", port: 4 },
        },
      },
      { p: { url: "http://127.0.0.1:1/v1", model: "s" } },
    );
    expect(cfg.launcher.python).toBe(`${FAKE}/py`);
    expect(cfg.launcher.script).toBe(`${FAKE}/sc`);
    expect(cfg.tiers.a!.model).toBe(`${FAKE}/m`);
    expect(cfg.tiers.b!.config).toBe(`${FAKE}/c.yaml`);
    expect(cfg.tiers.b!.python).toBe(`${FAKE}/py2`);
    expect(cfg.tiers.c!.start).toBe(`${FAKE}/run.sh`);
    expect(cfg.tiers.d!.location).toBe(`${FAKE}/loc`);
  });
});

describe("normalizePathsText", () => {
  it("rewrites only path-valued lines, keeps comments, is idempotent", () => {
    const r = normalizePathsText(YAML, FAKE);
    expect(r.changes.map((c) => [c.line, c.field])).toEqual([[5, "key_file"], [8, "key_file"]]);
    expect(r.text).toContain("key_file: ~/.claude/pai/keys/glm   # keep me");
    expect(r.text).toContain('key_file: "~/keys/other"');
    expect(r.text).toContain(`note: "see ${FAKE}/docs"`);
    expect(r.text).toContain("key_file: /srv/keys/x");
    expect(r.text.split("\n").length).toBe(YAML.split("\n").length);
    expect(normalizePathsText(r.text, FAKE)).toEqual({ text: r.text, changes: [] });
  });
});

describe("normalizeRegistryPaths on a file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "norm-paths-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dry run lists and writes nothing; --write backs up then rewrites", () => {
    const f = join(dir, "workers.yaml");
    writeFileSync(f, YAML, { mode: 0o600 });
    const dry = normalizeRegistryPaths(f, { home: FAKE });
    expect(dry.changes).toHaveLength(2);
    expect(readFileSync(f, "utf8")).toBe(YAML);
    expect(existsSync(join(dir, "workers-backups"))).toBe(false);

    const w = normalizeRegistryPaths(f, { home: FAKE, write: true });
    expect(w.backup).toMatch(/^workers\.yaml\.\d{8}-\d{6}\.bak$/);
    expect(readFileSync(join(dir, "workers-backups", w.backup!), "utf8")).toBe(YAML);
    expect(readFileSync(f, "utf8")).toBe(normalizePathsText(YAML, FAKE).text);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    const again = normalizeRegistryPaths(f, { home: FAKE, write: true });
    expect(again).toEqual({ changes: [] });
    expect(readdirSync(join(dir, "workers-backups"))).toHaveLength(1);
  });
});

describe("writers emit ~/", () => {
  let dir: string;
  let saved: { home?: string; cfg?: string };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "norm-writer-"));
    saved = { home: process.env.HOME, cfg: process.env.PAI_WORKERS_YAML };
    process.env.HOME = dir;
    process.env.PAI_WORKERS_YAML = join(dir, "workers.yaml");
  });
  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.cfg === undefined) delete process.env.PAI_WORKERS_YAML;
    else process.env.PAI_WORKERS_YAML = saved.cfg;
    rmSync(dir, { recursive: true, force: true });
  });

  it("addProvider writes key_file home-relative, for generated and passed key files", () => {
    expect(homedir()).toBe(dir);
    writeFileSync(join(dir, "workers.yaml"), "providers: {}\n");
    addProvider({ name: "g1", baseUrl: "https://example.invalid/v1", model: "m", key: "secret", configPath: join(dir, "c.json") } as never);
    addProvider({ name: "g2", baseUrl: "https://example.invalid/v1", model: "m", keyFile: join(dir, "k2"), configPath: join(dir, "c.json") } as never);
    const text = readFileSync(join(dir, "workers.yaml"), "utf8");
    expect(text).not.toContain(dir);
    expect(text).toMatch(/key_file: ~\/.*keys\/g1/);
    expect(text).toContain("key_file: ~/k2");
  });
});

describe("editor save", () => {
  it("normalizes home paths to ~/", async () => {
    const { saveRegistry, defaultRegistryCtx, hashText } = await import("../router/cockpit-registry.js");
    const dir = mkdtempSync(join(tmpdir(), "norm-save-"));
    const saved = process.env.HOME;
    process.env.HOME = FAKE;
    try {
      const f = join(dir, "workers.yaml");
      const base = "providers:\n  a:\n    url: http://127.0.0.1:1/v1\n    models: { default: m }\n";
      writeFileSync(f, base);
      const r = saveRegistry(base.replace("models:", `key_file: ${FAKE}/k\n    models:`), hashText(base), defaultRegistryCtx(f));
      expect(r.ok).toBe(true);
      expect(readFileSync(f, "utf8")).toContain("key_file: ~/k");
      expect(readFileSync(f, "utf8")).not.toContain(FAKE);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
