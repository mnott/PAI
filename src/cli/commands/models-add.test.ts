import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseLocalConfig, planStart, lifecycleOf, stopCommandFor } from "../../workers/local-tiers.js";
import { withExplicitLifecycle } from "../../router/cockpit-registry.js";
import { addModel, smokeTest } from "./models-add.js";
import { killInstance, launchDetached, portOpen } from "./worker-config.js";

const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
});

const providers = { p: { url: "http://127.0.0.1:8100/v1", model: "served-p" } };

describe("normaliser fills the lifecycle per kind", () => {
  const cfg = parseLocalConfig(
    parse(`
local_tiers:
  v: { provider: p, model: /m/vllm, served: s, port: 8100 }
  sc: { engine: script, provider: p, start: /srv/serve.sh, port: 8101 }
  st: { engine: strata, provider: p, config: /nonexistent/st.json, port: 8102 }
  c: { engine: command, provider: p, start_command: "/bin/srv --port {port}", stop_command: "rm /tmp/x-{port}", ready: "listening", port: 8103 }
`),
    providers,
  );
  it("location and health default from the kind", () => {
    expect(cfg.tiers.v).toMatchObject({ location: "/m/vllm", health: "http://127.0.0.1:{port}/v1/models" });
    expect(cfg.tiers.sc!.location).toBe("/srv/serve.sh");
    expect(cfg.tiers.st!.location).toBe("/nonexistent/st.json");
    expect(cfg.tiers.c).toMatchObject({ location: "", ready: "listening", stopCommand: "rm /tmp/x-{port}" });
  });
  it("start derives from the kind, an explicit command wins and takes the port", () => {
    expect(lifecycleOf(cfg, cfg.tiers.sc!).start).toBe("/bin/bash /srv/serve.sh --port 8101");
    expect(planStart(cfg, cfg.tiers.c!, 9000).argv).toEqual(["/bin/srv", "--port", "9000"]);
    expect(planStart(cfg, cfg.tiers.c!, 9000).env).toEqual({ PORT: "9000" });
    expect(stopCommandFor(cfg.tiers.c!, 9000)).toBe("rm /tmp/x-9000");
    expect(lifecycleOf(cfg, cfg.tiers.c!).stop).toContain("listener on port 8103");
  });
  it("engine command needs start_command", () => {
    expect(() => parseLocalConfig({ local_tiers: { x: { engine: "command", provider: "p", port: 1 } } }, {})).toThrow(/start_command/);
  });
});

describe("serializer writes the lifecycle explicitly", () => {
  const text = `providers:
  p:
    url: http://127.0.0.1:8100/v1
    models:
      default: served-p
local_tiers:
  v:
    provider: p
    model: /m/vllm
    port: 8100
`;
  it("inserts location and health once, idempotently", () => {
    const once = withExplicitLifecycle(text);
    const v = (parse(once) as { local_tiers: { v: Record<string, unknown> } }).local_tiers.v;
    expect(v).toMatchObject({ location: "/m/vllm", health: "http://127.0.0.1:{port}/v1/models" });
    expect(withExplicitLifecycle(once)).toBe(once);
  });
});

describe("explicit stop", () => {
  it("kills the group and the detached child, then frees the port; a stop command takes a stubborn server down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-life-"));
    const port = await freePort();
    const pidfile = join(dir, "pid");
    const script = join(dir, "srv.cjs");
    // parent listens, forks a detached child (own group) and ignores SIGTERM; only the stop command kills it
    writeFileSync(
      script,
      `const {spawn}=require('child_process');process.on('SIGTERM',()=>{});` +
        `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();` +
        `require('fs').writeFileSync(${JSON.stringify(pidfile)},process.pid+' '+c.pid);` +
        `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000);`,
    );
    const p = spawn(process.execPath, [script], { stdio: "ignore" });
    p.unref();
    for (let i = 0; i < 50 && !(await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
    const [parent, child] = readFileSync(pidfile, "utf8").split(" ").map(Number) as [number, number];
    pids.push(parent, child);
    const inst = { id: "t#1", model: "t", provider: "p", url: "", origin: "managed" as const, port, pid: parent, state: "ready" as const, startedAt: 0, log: "" };
    await killInstance(inst, portOpen, 600, `kill -9 ${parent}`);
    expect(await portOpen(port)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect([alive(parent), alive(child)]).toEqual([false, false]);
  });
});

describe("pai models add", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "pai-add-"));
    const yamlPath = join(root, "workers.yaml");
    mkdirSync(join(root, "o"));
    writeFileSync(yamlPath, `providers:\n  other:\n    url: http://127.0.0.1:8040/v1\n    models:\n      default: o\nlocal_tiers:\n  other: { provider: other, model: ${join(root, "o")}, served: o, port: 8040 }\n`);
    return { root, yamlPath, home: join(root, "home") };
  };
  const mlxDir = (root: string) => {
    const d = join(root, "Fake-MLX-4bit");
    mkdirSync(d);
    writeFileSync(join(d, "config.json"), "{}");
    writeFileSync(join(d, "model.safetensors"), "x");
    return d;
  };

  it("writes a disabled entry for an MLX dir with a free port and its lifecycle filled", async () => {
    const { root, yamlPath, home } = setup();
    const dir = mlxDir(root);
    const r = await addModel({ source: dir, name: "fake-mlx" }, { yamlPath, home, bindable: async () => true });
    expect(r.ok, r.message).toBe(true);
    expect(r.port).toBe(8041);
    const y = parse(readFileSync(yamlPath, "utf8")) as { providers: Record<string, Record<string, unknown>>; local_tiers: Record<string, Record<string, unknown>> };
    expect(y.providers["fake-mlx"]).toMatchObject({ enabled: false, url: "http://127.0.0.1:8041/v1" });
    expect(y.providers.other!.enabled).toBe(true);
    const t = y.local_tiers["fake-mlx"]!;
    expect(t).toMatchObject({ engine: "command", location: dir, port: 8041, health: "http://127.0.0.1:{port}/v1/models" });
    expect(String(t.start_command)).toContain("mlx_lm.server");
    expect(String(t.start_command)).toContain("{port}");
    expect(existsSync(join(root, "workers-backups"))).toBe(true);
  });

  it("refuses an unknown format with the reason and writes nothing", async () => {
    const { root, yamlPath, home } = setup();
    const before = readFileSync(yamlPath, "utf8");
    const d = join(root, "weird");
    mkdirSync(d);
    writeFileSync(join(d, "model.pt"), "x");
    const r = await addModel({ source: d }, { yamlPath, home });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no MLX .* or GGUF .* weights/);
    expect(readFileSync(yamlPath, "utf8")).toBe(before);
  });

  it("refuses GGUF without llama-server, and an absent id without --download", async () => {
    const { root, yamlPath, home } = setup();
    const g = join(root, "m.gguf");
    writeFileSync(g, "x");
    const r = await addModel({ source: g }, { yamlPath, home, which: () => null });
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/llama-server .* not installed/);
    const ok = await addModel({ source: g, name: "gg" }, { yamlPath, home, which: () => "/usr/local/bin/llama-server", bindable: async () => true });
    expect(ok.ok, ok.message).toBe(true);
    expect(parse(readFileSync(yamlPath, "utf8")).local_tiers.gg.start_command).toContain("llama-server");
    let downloaded = false;
    const no = await addModel({ source: "org/absent" }, { yamlPath, home, download: () => void (downloaded = true) });
    expect(no.ok).toBe(false);
    expect(no.message).toMatch(/--download/);
    expect(downloaded).toBe(false);
  });

  it("refuses a name that exists", async () => {
    const { root, yamlPath, home } = setup();
    const r = await addModel({ source: mlxDir(root), name: "other" }, { yamlPath, home });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already exists/);
  });

  it("--try runs the smoke steps in order and reports tok/s and memory", async () => {
    const { root, yamlPath, home } = setup();
    const calls: string[] = [];
    const r = await addModel(
      { source: mlxDir(root), name: "tried", try: true },
      {
        yamlPath, home, bindable: async () => true,
        smoke: {
          launch: () => (calls.push("launch"), () => null),
          health: async () => (calls.push("health"), true),
          complete: async (_u, served, n) => (calls.push(`complete ${served} ${n}`), 16),
          rssMb: () => 1234,
          kill: async () => void calls.push("kill"),
        },
      },
    );
    expect(r.ok, r.message).toBe(true);
    expect(calls).toEqual(["launch", "health", "complete tried 16", "kill"]);
    expect(r.smoke).toMatchObject({ ok: true, rssMb: 1234 });
    expect(r.message).toMatch(/tok\/s, memory 1234 MB/);
  });

  it("smokeTest stops the server even when the completion fails", async () => {
    const cfg = parseLocalConfig({ local_tiers: { z: { engine: "command", provider: "p", start_command: "/bin/true --port {port}", port: 9 } } }, providers);
    let killed = false;
    const r = await smokeTest(cfg, "z", { launch: () => () => null, health: async () => true, complete: async () => { throw new Error("boom"); }, kill: async () => void (killed = true) });
    expect(r).toMatchObject({ ok: false, message: "boom" });
    expect(killed).toBe(true);
  });

  it("smokeTest kills a server that is still loading (no listener yet) by its launched pid", async () => {
    const port = await freePort();
    const cfg = parseLocalConfig({ local_tiers: { z: { engine: "command", provider: "p", start_command: "/bin/true --port {port}", port } } }, providers);
    let pid = 0;
    const launch: typeof launchDetached = (plan) => {
      const h = launchDetached({ ...plan, argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], logPath: join(mkdtempSync(join(tmpdir(), "smoke-")), "s.log") });
      pid = h.pid!;
      return h;
    };
    const r = await smokeTest(cfg, "z", { launch, health: async () => false, readyMs: 300, pollMs: 50 });
    expect(r.ok).toBe(false);
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((x) => setTimeout(x, 100));
    expect(alive(pid)).toBe(false);
  });
});
