import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The route line names the real source of the provider choice: only a
 * --provider the caller typed says "flag: --provider"; --local says
 * "(local)"; a routing-policy pin says "(routing policy: <mode>)" — like
 * the session-profile case says "(session profile)". Everything runs
 * against a temp PAI_HOME with --print-cmd: no spawn, no live config.
 */

const root = mkdtempSync(join(tmpdir(), "pai-routewhy-"));
const home = join(root, "home");
const logDir = join(root, "logs", "workers");

// CONFIG_FILE is a module-level constant, evaluated when daemon/config.ts is
// first imported (main-config-ops.test.ts relies on this): pin it at the
// temp config before anything pulls that module in.
process.env.PAI_CONFIG_FILE = join(home, "config.yaml");
process.env.PAI_WORKERS_YAML = join(home, "workers.yaml");

const { runWorker } = await import("./run.js");
const { resolveTarget } = await import("./routing.js");
const { parseWorkersConfig } = await import("./config.js");
const { clearPolicy, writePolicy } = await import("./policy.js");

let localPort = 0;
let localStop: () => Promise<void> = async () => {};

/** A loopback server on an ephemeral port answering /v1/models (the probe every local check uses). */
async function startLocal(): Promise<() => Promise<void>> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  localPort = (srv.address() as AddressInfo).port;
  return () => new Promise<void>((r) => srv.close(() => r()));
}

const yamlFor = (port: number): string => [
  "providers:",
  "  glm:",
  "    url: https://glm.example.invalid",
  "    models:",
  "      default: glm-big",
  "  loc1:",
  `    url: http://127.0.0.1:${port}`,
  "    models:",
  "      default: flash-a",
  "  loc2:",
  "    url: http://127.0.0.1:45992",
  "    models:",
  "      default: flash-b",
  "",
].join("\n");

beforeAll(async () => {
  localStop = await startLocal();
  mkdirSync(home, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(home, "config.yaml"), `workers:\n  enabled: true\n  logDir: ${logDir}\n`);
  writeFileSync(join(home, "workers.yaml"), yamlFor(localPort));
  writeFileSync(join(home, "session-profiles.yaml"), "job-search:\n  workers:\n    provider: glm\n");
}, 10_000);

afterAll(async () => {
  await localStop();
  delete process.env.PAI_CONFIG_FILE;
  delete process.env.PAI_WORKERS_YAML;
  try {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".pai-scratch", `routewhy-cli-${process.pid}`), { recursive: true, force: true });
  } catch {
    // best effort
  }
});


/** The real CLI argv → plan path (buildRunPlan), so the flags tested are the ones typed. */
const capture = async (argv: Record<string, string | boolean>, env: Record<string, string> = {}): Promise<string> => {
  const { buildRunPlan } = await import("../cli/commands/worker.js");
  const plan = buildRunPlan({ args: {}, opts: argv, dryRun: false, rest: ["-p", "x"] });
  if (plan.kind !== "run") throw new Error("expected a run plan");
  const prev = { ...process.env };
  Object.assign(process.env, { PAI_HOME: home, ...env });
  const write = process.stderr.write.bind(process.stderr);
  let err = "";
  let out = "";
  process.stderr.write = ((c: string | Uint8Array) => {
    err += typeof c === "string" ? c : Buffer.from(c).toString();
    return true;
  }) as typeof process.stderr.write;
  const log = console.log;
  console.log = (s?: unknown) => {
    out += String(s);
  };
  try {
    await runWorker(plan.run);
  } finally {
    process.stderr.write = write;
    console.log = log;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
  return err + "\n" + out;
};

describe("route reason: the real source", () => {
  it("--provider the caller typed still says flag: --provider", async () => {
    const s = await capture({ provider: "glm", "print-cmd": true });
    expect(s).toContain("route glm/glm-big (flag: --provider)");
    expect(s).not.toContain("session profile");
  });

  it("--local says (local), not flag: --provider", async () => {
    // one loopback provider, its port answering: resolveLocalProvider picks it
    try {
      const s = await capture({ local: true, "print-cmd": true });
      expect(s).toContain("route loc1/flash-a (local)");
      expect(s).not.toContain("flag: --provider");
    } finally {
    }
  });

  it("a loopback provider's argv keeps the per-run note token out of the system prompt (shared prefix)", async () => {
    const s = await capture({ local: true, "print-cmd": true });
    const [argv, stdin] = s.split('"stdin":');
    expect(stdin).toContain("PAI note [");
    expect(argv).not.toContain("PAI note [");
  });

  it("a routing-policy pin says (routing policy: <mode>), not flag: --provider", async () => {
    // the policy pins loc1; the port answers so routeRun's findLocal takes it
    writePolicy(logDir, "prefer-local");
    try {
      const s = await capture({ "print-cmd": true });
      expect(s).toContain("route loc1/flash-a (routing policy: prefer-local)");
      expect(s).not.toContain("flag: --provider");
    } finally {
      clearPolicy(logDir);
    }
  });

  it("the session profile still says (session profile)", async () => {
    const s = await capture({ "print-cmd": true }, { PAI_SESSION_NAME: "job-search" });
    expect(s).toContain("route glm/glm-big (session profile)");
    expect(s).not.toContain("flag: --provider");
  });

  it("the CLI itself: pai worker run --print-cmd --local -p x prints (local)", async () => {
    // a temp outDir build of this worktree's src — never the live install
    // under the worktree's node_modules so the external deps resolve
    const outDir = join(process.cwd(), ".pai-scratch", `routewhy-cli-${process.pid}`);
    const built = spawnSync(join(process.cwd(), "node_modules", ".bin", "esbuild"), [
      "src/cli/index.ts",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=esm",
      "--external:onnxruntime-node",
      // node_modules stay external (the production bundle does the same):
      // the CLI pulls in the whole dependency tree
      "--packages=external",
      `--outdir=${outDir}`,
    ], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`esbuild failed: ${built.stderr}`);
    try {
      // PAI_WORKER_ALLOW_HIDDEN: a headless run needs the operator's
      // hidden-run consent even for a --print-cmd dry run (pane guard)
      const r = spawnSync(process.execPath, [join(outDir, "index.js"), "worker", "run", "--print-cmd", "--local", "-p", "x"], {
        // the bundle keeps node_modules external: run it where they resolve
        cwd: process.cwd(),
        env: { ...process.env, PAI_HOME: home, PAI_CONFIG_FILE: join(home, "config.yaml"), PAI_WORKERS_YAML: join(home, "workers.yaml"), PAI_WORKER_ALLOW_HIDDEN: "1" },
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("route loc1/flash-a (local)");
      expect(JSON.parse(r.stdout).route).toBe("loc1/flash-a (local)");
    } finally {
    }
  }, 120_000);

  it("resolveTarget names no source for a flag pin: the caller does", () => {
    const cfg = parseWorkersConfig({
      enabled: true,
      providers: { glm: { baseUrl: "https://glm.example.invalid", models: { default: "glm-big" } } },
    });
    const t = resolveTarget(cfg, mkdtempSync(join(tmpdir(), "tgt-")), { flagProvider: "glm" });
    expect(t.via).toBe("flag");
    expect(t.routeWhy).toBeUndefined();
  });
});
