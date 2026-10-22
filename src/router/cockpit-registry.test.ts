/**
 * Tests for src/router/cockpit-registry.ts. Every file lives in a temp dir;
 * the real workers.yaml is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { parse } from "yaml";
import {
  deleteBackup,
  diffBackup,
  diffLines,
  labelBackup,
  withExplicitEnabled,
  duplicateEntry,
  handleRegistryRoute,
  hashText,
  listBackups,
  readRegistry,
  restoreBackup,
  saveRegistry,
  validateRegistry,
  validateRequest,
  type RegistryCtx,
} from "./cockpit-registry.js";
import type { LocalInstance } from "../workers/local-instances.js";

const BASE = `providers:
  qwen:
    url: http://127.0.0.1:8001/v1
    models:
      default: qwen-served
  gemma:
    url: http://127.0.0.1:8002/v1
    models:
      default: gemma-served
local_tiers:
  qwen:
    provider: qwen
    model: /models/qwen
    port: 8001
  gemma:
    provider: gemma
    model: /models/gemma
    port: 8002
`;

let dir: string;
let ctx: RegistryCtx;
let clock: number;
let running: LocalInstance[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-registry-"));
  clock = Date.UTC(2026, 0, 1, 12, 0, 0);
  running = [];
  writeFileSync(join(dir, "workers.yaml"), BASE);
  ctx = {
    yamlPath: join(dir, "workers.yaml"),
    backupDir: join(dir, "backups"),
    fileExists: (p) => p.startsWith("/models/"),
    portFree: () => true,
    running: () => running,
    ledger: join(dir, "ledger.log"),
    now: () => new Date((clock += 5000)),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const errs = (text: string, c = ctx) => validateRegistry(text, c, BASE).errors;
const onDisk = () => readFileSync(ctx.yamlPath, "utf8");
const edit = (from: string, to: string) => BASE.replace(from, to);

describe("validateRegistry", () => {
  it("accepts the base file", () => expect(errs(BASE)).toEqual([]));

  it("bad YAML gives an error with a line", () => {
    const e = errs("providers:\n  a: [\n");
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]!.line).toBeGreaterThan(0);
  });

  it("missing required field names the path and line", () => {
    const e = errs(edit("    model: /models/gemma\n", ""));
    expect(e).toHaveLength(1);
    expect(e[0]!.path).toBe("local_tiers.gemma.model");
    expect(e[0]!.message).toBe("required");
    expect(e[0]!.line).toBe(BASE.split("\n").indexOf("  gemma:", 10) + 2);
  });

  it("duplicate name is refused", () => {
    const e = errs(BASE + "  qwen:\n    provider: qwen\n    model: /models/q2\n    port: 8003\n");
    expect(e.some((x) => /duplicate name "qwen"/.test(x.message))).toBe(true);
  });

  it("builtin anthropic block and a shared-engine port are accepted (live-file shape)", () => {
    const yaml = `providers:
  anthropic:
    builtin: true
    models:
      default: placeholder-model
  local:
    url: http://127.0.0.1:8035/v1
    models:
      default: served
local_tiers:
  tier-a:
    provider: local
    engine: strata
    config: /opt/placeholder/a.json
    port: 8035
  tier-b:
    provider: local
    engine: strata
    config: /opt/placeholder/b.json
    port: 8035
`;
    expect(errs(yaml)).toEqual([]);
  });

  it("different engines on one port are refused", () => {
    const yaml = `providers:
  local:
    url: http://127.0.0.1:8035/v1
    models:
      default: served
local_tiers:
  tier-a:
    provider: local
    engine: script
    start: /opt/placeholder/serve.sh
    port: 8035
  tier-b:
    provider: local
    engine: strata
    config: /opt/placeholder/b.json
    port: 8035
`;
    const e = errs(yaml);
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/port 8035 is also used by "tier-a"/);
  });

  it("duplicate port is refused", () => {
    const e = errs(edit("port: 8002", "port: 8001"));
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/port 8001 is also used by "qwen"/);
  });

  it("a new port used by a foreign process is refused, an unchanged one is not", () => {
    const busy = { ...ctx, portFree: (p: number) => p !== 9000 };
    expect(errs(edit("port: 8002", "port: 9000"), busy)[0]!.message).toMatch(/in use by another process/);
    expect(errs(BASE, { ...ctx, portFree: () => false })).toEqual([]);
  });

  it("missing model file is refused", () => {
    const e = errs(edit("/models/gemma", "/nowhere/gemma"));
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/model file not found/);
  });

  it("removing an entry with a running instance is refused with the instance id", () => {
    running = [{ id: "gemma#1", model: "gemma", provider: "gemma", url: "http://127.0.0.1:8002", origin: "managed", port: 8002, state: "ready", startedAt: 0, log: "" }];
    const gone = edit("  gemma:\n    provider: gemma\n    model: /models/gemma\n    port: 8002\n", "");
    const e = errs(gone);
    expect(e.some((x) => x.message.includes("gemma#1"))).toBe(true);
    running = [];
    expect(errs(gone)).toEqual([]);
  });

  it("a bad provider is reported through the loader's own validator", () => {
    const e = errs(edit("protocol", "protocol") + "  broken:\n    protocol: nope\n");
    // appended under local_tiers, so the shape error comes from the tier parser
    expect(e.length).toBeGreaterThan(0);
    const p = errs(edit("providers:\n", "providers:\n  broken:\n    protocol: nope\n    url: http://x/\n"));
    expect(p[0]!.path).toBe("providers.broken.protocol");
  });
});

describe("diff", () => {
  it("shows + and - lines", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual(["- b", "+ B"]);
    expect(diffLines("a", "a")).toEqual([]);
  });

  it("validateRequest returns the diff against disk", () => {
    const r = validateRequest(edit("port: 8002", "port: 8009"), hashText(BASE), ctx);
    expect(r.ok).toBe(true);
    expect(r.diff).toEqual(["-     port: 8002", "+     port: 8009"]);
  });

  it("validateRequest refuses a stale baseHash", () => {
    const r = validateRequest(BASE, "deadbeef", ctx);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/changed on disk - reload/);
  });
});

describe("saveRegistry", () => {
  const next = () => edit("port: 8002", "port: 8009");

  it("replaces the file and creates exactly one backup holding the old bytes", () => {
    const r = saveRegistry(next(), hashText(BASE), ctx);
    expect(r.ok).toBe(true);
    expect(onDisk()).toBe(next());
    const files = readdirSync(ctx.backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^workers\.yaml\.\d{8}-\d{6}\.bak$/);
    expect(readFileSync(join(ctx.backupDir, files[0]!), "utf8")).toBe(BASE);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a stale baseHash and leaves the file alone", () => {
    const r = saveRegistry(next(), hashText("something else"), ctx);
    expect(r).toEqual({ ok: false, error: "changed on disk - reload" });
    expect(onDisk()).toBe(BASE);
    expect(existsSync(ctx.backupDir)).toBe(false);
  });

  it("re-validates on the server even when the client skipped Validate", () => {
    const r = saveRegistry(edit("port: 8002", "port: 8001"), hashText(BASE), ctx);
    expect(r.ok).toBe(false);
    expect(onDisk()).toBe(BASE);
  });

  for (const step of [1, 2, 3, 4, 5, 6]) {
    it(`an injected failure at step ${step} leaves the file hash unchanged`, () => {
      const before = hashText(onDisk());
      const r = saveRegistry(next(), before, { ...ctx, failAt: (n) => { if (n === step) throw new Error(`boom ${n}`); } });
      expect(r).toEqual({ ok: false, error: `boom ${step}` });
      expect(hashText(onDisk())).toBe(before);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  }
});

describe("backups and restore", () => {
  it("restore round-trips: save A, save B, restore A gives A's bytes", () => {
    const A = BASE.replace("port: 8002", "port: 8009");
    const B = BASE.replace("port: 8002", "port: 8010");
    expect(saveRegistry(A, hashText(BASE), ctx).ok).toBe(true);
    expect(saveRegistry(B, hashText(A), ctx).ok).toBe(true);
    const aBackup = listBackups(ctx).find((b) => readFileSync(join(ctx.backupDir, b.name), "utf8") === A)!;
    const r = restoreBackup(aBackup.name, hashText(B), ctx);
    expect(r.ok).toBe(true);
    expect(onDisk()).toBe(A);
    // restoring backed up what it replaced (B)
    const kept = listBackups(ctx).map((b) => readFileSync(join(ctx.backupDir, b.name), "utf8"));
    expect(kept).toContain(B);
    expect(kept).toHaveLength(3);
  });

  it("lists newest first with size and a one-line diff summary", () => {
    const A = BASE.replace("port: 8002", "port: 8009");
    saveRegistry(A, hashText(BASE), ctx);
    saveRegistry(BASE, hashText(A), ctx);
    const l = listBackups(ctx);
    expect(l).toHaveLength(2);
    expect(l[0]!.name > l[1]!.name).toBe(true);
    expect(l[0]!.size).toBe(Buffer.byteLength(BASE));
    expect(l[0]!.summary).toBe("+1 -1 lines");
    expect(l[1]!.summary).toBe("no changes");
  });

  it("restore refuses a stale hash, a bad name and a path escape", () => {
    saveRegistry(BASE.replace("port: 8002", "port: 8009"), hashText(BASE), ctx);
    const name = listBackups(ctx)[0]!.name;
    expect(restoreBackup(name, "nope", ctx).ok).toBe(false);
    expect(restoreBackup("../workers.yaml", hashText(onDisk()), ctx).ok).toBe(false);
    expect(restoreBackup("workers.yaml.20200101-000000.bak", hashText(onDisk()), ctx).ok).toBe(false);
  });
});

describe("duplicateEntry", () => {
  it("gives a unique name and free port with every other field identical", () => {
    const r = duplicateEntry(BASE, "qwen");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("qwen-2");
    expect(r.port).toBe(8003);
    expect(validateRegistry(r.yaml, ctx, BASE).errors).toEqual([]);
    const again = duplicateEntry(r.yaml, "qwen");
    expect(again.ok && again.name).toBe("qwen-3");
    expect(again.ok && again.port).toBe(8004);
    const t = parse(r.yaml).local_tiers;
    expect({ ...t["qwen-2"], port: 0 }).toEqual({ ...t.qwen, port: 0 });
  });

  it("skips ports the machine says are taken and refuses a name clash", () => {
    const r = duplicateEntry(BASE, "qwen", { portFree: (p) => p !== 8003 });
    expect(r.ok && r.port).toBe(8004);
    expect(duplicateEntry(BASE, "qwen", { newName: "gemma" })).toEqual({ ok: false, error: 'name "gemma" already exists' });
  });
});

describe("routes", () => {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const server = http.createServer((req, res) => {
      const io = {
        sameOrigin: (r: http.IncomingMessage) => r.headers["sec-fetch-site"] !== "cross-site",
        readBody: (r: http.IncomingMessage) => new Promise<string>((ok) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => ok(d)); }),
      };
      if (!handleRegistryRoute(req, res, req.url ?? "", () => ctx, io)) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    } finally {
      server.close();
    }
  };

  it("a non-object body (null, array, number, bad JSON) answers 400 instead of hanging", async () => {
    for (const raw of ["null", "[1]", "7", "{nope"]) {
      const server = http.createServer((req, res) => {
        const io = {
          sameOrigin: () => true,
          readBody: (r: http.IncomingMessage) => new Promise<string>((ok) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => ok(d)); }),
        };
        handleRegistryRoute(req, res, req.url ?? "", () => ctx, io);
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      try {
        const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/cockpit/registry/save`, { method: "POST", body: raw, signal: AbortSignal.timeout(3000) });
        expect(r.status, raw).toBe(400);
      } finally {
        server.close();
      }
    }
  });

  it("GET /cockpit/registry returns yaml, mtime, hash", async () => {
    const r = await call("GET", "/cockpit/registry");
    expect(r.json).toMatchObject({ yaml: BASE, hash: hashText(BASE) });
    expect(typeof r.json.mtime).toBe("number");
  });

  it("save over HTTP writes a ledger line; cross-site is refused; other methods are 405", async () => {
    const ok = await call("POST", "/cockpit/registry/save", { yaml: BASE.replace("port: 8002", "port: 8009"), baseHash: hashText(BASE) });
    expect(ok.json.ok).toBe(true);
    expect(readFileSync(ctx.ledger!, "utf8")).toMatch(/COCKPIT-ACTION.*registry\.save/);
    expect(readRegistry(ctx).yaml).toContain("8009");
    const cross = await call("POST", "/cockpit/registry/save", { yaml: BASE, baseHash: "x" }, { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect((await call("PUT", "/cockpit/registry/save", {})).status).toBe(405);
    expect((await call("GET", "/cockpit/registry/backups")).json.backups).toHaveLength(1);
  });
});

describe("backup delete, name and diff", () => {
  const three = () => {
    let cur = BASE;
    for (const port of ["8009", "8010", "8011"]) {
      const next = cur.replace(/port: 80(02|09|10)/, `port: ${port}`);
      expect(saveRegistry(next, hashText(cur), ctx).ok).toBe(true);
      cur = next;
    }
    return listBackups(ctx);
  };

  it("delete removes only that backup (and its name), refuses bad names", () => {
    const before = three();
    expect(before).toHaveLength(3);
    labelBackup(before[0]!.name, "keep me", ctx);
    labelBackup(before[1]!.name, "drop me", ctx);
    expect(deleteBackup(before[1]!.name, ctx)).toEqual({ ok: true });
    expect(listBackups(ctx).map((b) => b.name)).toEqual([before[0]!.name, before[2]!.name]);
    expect(existsSync(join(ctx.backupDir, `${before[1]!.name}.label`))).toBe(false);
    expect(listBackups(ctx)[0]!.label).toBe("keep me");
    expect(deleteBackup(before[1]!.name, ctx).ok).toBe(false);
    expect(deleteBackup("../workers.yaml", ctx).ok).toBe(false);
    expect(existsSync(ctx.yamlPath)).toBe(true);
  });

  it("a name survives a reload of the list, is trimmed, and an empty one clears it", () => {
    const [b] = three();
    expect(labelBackup(b!.name, "  before  the\nport change  ", ctx)).toEqual({ ok: true, label: "before the port change" });
    expect(listBackups(ctx)[0]!.label).toBe("before the port change");
    expect(labelBackup(b!.name, "", ctx)).toEqual({ ok: true, label: "" });
    expect(listBackups(ctx)[0]!.label).toBe("");
    expect(labelBackup("workers.yaml.20200101-000000.bak", "x", ctx).ok).toBe(false);
  });

  it("diff of one backup is against the current file", () => {
    const l = three();
    const d = diffBackup(l[2]!.name, ctx);
    expect(d.ok && d.diff).toEqual(["-     port: 8011", "+     port: 8002"]);
  });

  it("routes: delete and label are POST-only with a name", async () => {
    const [b] = three();
    expect(b).toBeDefined();
    expect(labelBackup(b!.name, "x", ctx).ok).toBe(true);
    expect(deleteBackup(b!.name, ctx).ok).toBe(true);
    expect(listBackups(ctx)).toHaveLength(2);
  });
});

describe("explicit enabled", () => {
  const save = (text: string) => {
    const c = { ...ctx, explicitEnabled: true };
    expect(saveRegistry(text, hashText(onDisk()), c).ok).toBe(true);
    return onDisk();
  };

  it("save writes enabled: true on every provider that lacks it, keeps enabled: false, touches nothing else", () => {
    const text = BASE.replace("  gemma:\n", "  gemma:\n    enabled: false\n");
    const out = save(text);
    const p = parse(out).providers;
    expect(p.qwen.enabled).toBe(true);
    expect(p.gemma.enabled).toBe(false);
    expect(out.split("\n").filter((l) => l.includes("enabled")).length).toBe(2);
    expect(out.replace("    enabled: true\n", "")).toBe(text);
  });

  it("is idempotent and leaves the builtin anthropic block alone", () => {
    const text = "providers:\n  anthropic:\n    builtin: true\n    models:\n      default: opus\n" + BASE.replace("providers:\n", "");
    const once = withExplicitEnabled(text);
    expect(once).not.toContain("anthropic:\n    enabled");
    expect(withExplicitEnabled(once)).toBe(once);
    expect(parse(once).providers.qwen.enabled).toBe(true);
  });

  it("loading a file without it still defaults to enabled", () => {
    expect(parse(BASE).providers.qwen.enabled).toBeUndefined();
    expect(validateRegistry(BASE, ctx, BASE).errors).toEqual([]);
  });

  it("validate shows the enabled lines the save will add", () => {
    const r = validateRequest(BASE, hashText(BASE), { ...ctx, explicitEnabled: true });
    expect(r.diff).toEqual(["+     enabled: true", "+     enabled: true"]);
  });
});

describe("validate cost", () => {
  it("a 750-line registry validates and diffs well under 100 ms (no probe, no reload)", () => {
    const big = BASE + Array.from({ length: 700 }, (_, i) => `# filler ${i}\n`).join("");
    writeFileSync(ctx.yamlPath, big);
    validateRequest(big, hashText(big), ctx); // warm
    const t0 = performance.now();
    const r = validateRequest(big + "# x\n", hashText(big), ctx);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(100);
  });
});
