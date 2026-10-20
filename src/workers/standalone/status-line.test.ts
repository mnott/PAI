import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The status line's route part, end to end: the built script runs against a
 * temp PAI_HOME (config + workers.yaml + profiles there, nothing live
 * touched). It must show the worker route for a session that never went
 * through `pai` (no PAI_SESSION_NAME) — the name comes from detectSessionName
 * — and pay for that detection at most once per 5 minutes: the cache file
 * under the workers log dir answers the second run.
 */

const root = mkdtempSync(join(tmpdir(), "pai-statusline-e2e-"));
const home = join(root, "home");
const repo = join(root, "repo");
const logDir = join(home, "logs", "workers");
const outDir = join(root, "build");

let script: string;

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  // the dual-format read prefers the config.yaml sibling: write that
  writeFileSync(join(home, "config.yaml"), `workers:\n  enabled: true\n  logDir: ${logDir}\n`);
  writeFileSync(
    join(home, "workers.yaml"),
    [
      "providers:",
      "  glm:",
      "    url: https://glm.example.invalid",
      "    models:",
      "      default: glm-big",
      // no class pins a provider: the cheap classes must not resolve
      // cross-provider, so the bar's resolver stays on the profile path
      "classes: {}",
      "",
    ].join("\n")
  );
  writeFileSync(join(home, "session-profiles.yaml"), "job-search:\n  workers:\n    provider: glm\n    model: fast\n");
  // the AIBroker registry (under $HOME/.aibroker — the vitest home guard
  // points HOME at a throwaway dir): the bridge for a session `pai` never
  // started (no PAI_SESSION_NAME)
  mkdirSync(join(process.env.HOME ?? "", ".aibroker"), { recursive: true });
  writeFileSync(join(process.env.HOME ?? "", ".aibroker", "session-names.json"), JSON.stringify({ "SL-UUID": "job-search" }));
  // same shape as scripts/build-hooks.mjs builds it (onnxruntime-node is a
  // native binding: never bundled, resolved at runtime)
  const built = spawnSync(join(process.cwd(), "node_modules", ".bin", "esbuild"), [
    "src/workers/standalone/status-line.ts",
    "--bundle",
    "--platform=node",
    "--target=node20",
    "--format=esm",
    "--external:onnxruntime-node",
    // the same require shim scripts/build-hooks.mjs applies to every standalone entry
    "--banner:js=import { createRequire as __paiCreateRequire } from 'node:module'; const require = __paiCreateRequire(import.meta.url);",
    `--outdir=${outDir}`,
  ], {
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`esbuild failed: ${built.stderr}`);
  script = join(outDir, "status-line.js");
}, 120_000);

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // temp dir cleanup is best effort
  }
});

const runBar = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], {
    cwd: repo,
    // CONFIG_FILE is a module-level constant (evaluated at vitest import,
    // before any env stub): name the temp config explicitly
    env: {
      ...process.env,
      PAI_HOME: home,
      PAI_CONFIG_FILE: join(home, "config.yaml"),
      PAI_WORKERS_YAML: join(home, "workers.yaml"),
      // the one-time "old location" notices would pollute the stderr check
      PAI_QUIET_NOTICES: "1",
      // the bundle sits in a temp dir: name the shipped defaults explicitly
      PAI_DEFAULTS_DIR: join(process.cwd(), "src", "config", "defaults"),
      ...env,
    },
    encoding: "utf8",
  });

describe("status line route for every session", () => {
  it("shows the profile route without PAI_SESSION_NAME, via detectSessionName", () => {
    mkdirSync(logDir, { recursive: true });
    // the claude session bridges to the AIBroker name through the map the
    // bar itself refreshes (recordSessionMapEntry)
    writeFileSync(join(logDir, "claude-session-map.json"), JSON.stringify({ [`${repo}\u0000sl-cc-1`]: { session: "sl-cc-1", ts: 1, term: "w1t0p0:SL-UUID" } }));
    const env = { ITERM_SESSION_ID: "w1t0p0:SL-AAA", CLAUDE_CODE_SESSION_ID: "sl-cc-1" };
    const first = runBar(env);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("workers: glm/fast");
    // the detection result sits in the cache file under the workers log dir
    const caches = readdirSync(logDir).filter((n) => n.startsWith("session-name-") && n.endsWith(".json"));
    expect(caches.length).toBe(1);
    expect(JSON.parse(readFileSync(join(logDir, caches[0]), "utf8")).name).toBe("job-search");
    // second run: the fresh cache answers, the same line
    const second = runBar(env);
    expect(second.stdout).toContain("workers: glm/fast");
    expect(readdirSync(logDir).filter((n) => n.startsWith("session-name-")).length).toBe(1);
  });

  it("a different session identity gets its own cache entry and no profile route", () => {
    const out = runBar({ ITERM_SESSION_ID: "w1t0p0:SL-BBB", CLAUDE_CODE_SESSION_ID: "sl-cc-2" });
    expect(out.stdout).not.toContain("workers:");
    expect(existsSync(logDir)).toBe(true);
    expect(readdirSync(logDir).filter((n) => n.startsWith("session-name-")).length).toBe(2);
  });

  it("PAI_SESSION_NAME still answers without a scan", () => {
    const out = runBar({ PAI_SESSION_NAME: "job-search", ITERM_SESSION_ID: "w1t0p0:SL-CCC", CLAUDE_CODE_SESSION_ID: "sl-cc-3" });
    expect(out.stdout).toContain("workers: glm/fast");
  });
});
