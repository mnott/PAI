/**
 * Fault 2026-11-24 23:19: `pai bench run --provider gyro-s2` with gyro-s2 `enabled: false` (local).
 * Every worker start was refused by the local-provider gate (rc 2), yet the series logged
 * "done short rep1 in 1s rc=0" and the rep file carried an empty error. Preflight must abort the
 * series with the refusal message, and a non-zero script exit must log FAILED with the reason and
 * write it into the rep's error field.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkersConfig, WorkerProvider } from "../workers/config.js";
import { benchRun, runScript, writeFailedResult, type BenchRunOpts } from "./run.js";

const local = (enabled: boolean): WorkerProvider => ({
  enabled,
  protocol: "anthropic",
  baseUrl: "http://127.0.0.1:5001/v1",
  keyFile: null,
  models: { default: "m" },
  env: {},
});

const cfg = (providers: Record<string, WorkerProvider>): WorkersConfig => ({
  enabled: true,
  active: null,
  providers,
  classes: {},
  mcpSets: {},
} as unknown as WorkersConfig);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-fault-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const opts = (provider: string): BenchRunOpts => ({
  provider,
  sets: ["short"],
  reps: 1,
  real: 0,
  key: "gyro-s2-v2b",
  dir,
  realCapMin: 30,
  idleSec: 900,
  maxWrites: 15,
  out: () => {},
});

describe("preflight aborts a refused provider before any rep", () => {
  it("disabled local provider -> series aborts with the gate message and rc 1", async () => {
    const lines: string[] = [];
    const o = { ...opts("gyro-s2"), out: (l: string) => lines.push(l) };
    const rc = await benchRun(o, dir, join(dir, "no-bench-scripts"), {
      load: () => ({ raw: {}, workers: cfg({ "gyro-s2": local(false), "gyro-m": local(true) }) }),
      check: async () => false,
    });
    expect(rc).toBe(1);
    const seriesLog = readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8");
    expect(seriesLog).toContain('ABORT series gyro-s2-v2b: provider "gyro-s2" cannot run a worker');
    expect(seriesLog).toContain("is disabled");
    expect(seriesLog).not.toContain("start short rep1");
    expect(seriesLog).not.toContain("complete");
  });

  it("unknown provider -> abort", async () => {
    const rc = await benchRun(opts("ghost"), dir, join(dir, "no-bench-scripts"), {
      load: () => ({ raw: {}, workers: cfg({}) }),
      check: async () => false,
    });
    expect(rc).toBe(1);
    expect(readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8")).toContain("no worker provider named");
  });

  it("enabled local provider whose server is down -> abort", async () => {
    const rc = await benchRun(opts("gyro-s2"), dir, join(dir, "no-bench-scripts"), {
      load: () => ({ raw: {}, workers: cfg({ "gyro-s2": local(true) }) }),
      check: async () => false,
    });
    expect(rc).toBe(1);
    expect(readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8")).toContain("does not answer");
  });

  it("enabled and answering provider -> runs (preflight passes)", async () => {
    // a script that exits 0 immediately: the series completes
    const sh = join(dir, "evalset.sh");
    writeFileSync(sh, "#!/bin/sh\nexit 0\n");
    chmodSync(sh, 0o755);
    const rc = await benchRun(opts("gyro-s2"), dir, dir, {
      load: () => ({ raw: {}, workers: cfg({ "gyro-s2": local(true) }) }),
      check: async () => true,
    });
    expect(rc).toBe(0);
    expect(readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8")).toContain("done short rep1");
  });
});

describe("worker start refused mid-series (rc 2)", () => {
  it("runScript captures the refusal stderr", async () => {
    const sh = join(dir, "refused.sh");
    writeFileSync(sh, '#!/bin/sh\necho \'provider "gyro-s2" is a local (loopback) provider and is disabled\' >&2\nexit 2\n');
    chmodSync(sh, 0o755);
    const res = await runScript(sh, [], process.env, () => null);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("is disabled");
  });

  it("rep error field gets the refusal text and the series line says FAILED", async () => {
    writeFailedResult(opts("gyro-s2"), "short", 1, 2, 'provider "gyro-s2" is a local (loopback) provider and is disabled', 1);
    const rep = JSON.parse(readFileSync(join(dir, "results", "short", "gyro-s2-v2b", "rep1.json"), "utf8"));
    expect(rep.status).toBe("error");
    expect(rep.worker_rc).toBe(2);
    expect(rep.error).toContain("is disabled");
  });

  it("a refused rep logs FAILED with the reason, not done rc=0", async () => {
    const lines: string[] = [];
    const o = { ...opts("gyro-s2"), out: (l: string) => lines.push(l) };
    // preflight passes (provider enabled+up), but the script refuses like the worker start did
    const sh = join(dir, "evalset.sh");
    writeFileSync(sh, '#!/bin/sh\necho \'provider "gyro-s2" is a local (loopback) provider and is disabled\' >&2\nexit 2\n');
    chmodSync(sh, 0o755);
    const rc = await benchRun(o, dir, dir, {
      load: () => ({ raw: {}, workers: cfg({ "gyro-s2": local(true) }) }),
      check: async () => true,
    });
    expect(rc).toBe(1);
    const seriesLog = readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8");
    expect(seriesLog).toContain('FAILED short rep1: provider "gyro-s2" is a local (loopback) provider and is disabled');
    expect(seriesLog).not.toContain("done short rep1 in");
    const rep = JSON.parse(readFileSync(join(dir, "results", "short", "gyro-s2-v2b", "rep1.json"), "utf8"));
    expect(rep.status).toBe("error");
    expect(rep.error).toContain("is disabled");
  });

  it("a script that already wrote its rep file keeps it (writeFailedResult no-op)", async () => {
    const res = join(dir, "results", "short", "gyro-s2-v2b", "rep1.json");
    mkdirSync(join(dir, "results", "short", "gyro-s2-v2b"), { recursive: true });
    writeFileSync(res, JSON.stringify({ status: "error", error: "graded by script" }));
    writeFailedResult(opts("gyro-s2"), "short", 1, 2, "refusal text", 1);
    expect(JSON.parse(readFileSync(res, "utf8")).error).toBe("graded by script");
  });
});

describe("--code-graph reaches the workers and the records (2026-11-25)", () => {
  // PAI_BRIEF_CODE_GRAPH in the env of pai bench run never reaches a worker: workers start through
  // the daemon with its own environment. The decision must travel as BENCH_CODE_GRAPH -> the set
  // scripts' --code-graph flag, and be recorded so an A/B table can tell the arms apart.

  it("the series header names the arm; without the option it says default", async () => {
    const sh = join(dir, "evalset.sh");
    writeFileSync(sh, "#!/bin/sh\nexit 0\n");
    chmodSync(sh, 0o755);
    const deps = { load: () => ({ raw: {}, workers: cfg({ "gyro-s2": local(true) }) }), check: async () => true };
    const on = await benchRun({ ...opts("gyro-s2"), codeGraph: "on" }, dir, dir, deps);
    expect(on).toBe(0);
    expect(readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8")).toContain("code-graph=on");
    const off = await benchRun({ ...opts("gyro-s2"), codeGraph: "off" }, dir, dir, deps);
    expect(off).toBe(0);
    expect(readFileSync(join(dir, "series-gyro-s2-v2b.log"), "utf8")).toContain("code-graph=off");
  });

  it("BENCH_CODE_GRAPH is in the env handed to the set scripts, and only when asked", async () => {
    // a script that reports its own env: what benchRun passes is what the worker start sees
    // the script reports its own env: what benchRun passes is what the worker start sees
    const seen = join(dir, "env-seen.txt");
    const sh = join(dir, "evalset.sh");
    writeFileSync(sh, `#!/bin/sh\nprintf "%s\\n" "\${BENCH_CODE_GRAPH:-unset}" > "${seen}"\nexit 0\n`);
    chmodSync(sh, 0o755);
    const deps = { load: () => ({ raw: {}, workers: cfg({ "gyro-s2": local(true) }) }), check: async () => true };
    await benchRun({ ...opts("gyro-s2"), codeGraph: "on" }, dir, dir, deps);
    expect(readFileSync(seen, "utf8").trim()).toBe("on");
    await benchRun(opts("gyro-s2"), dir, dir, deps);
    expect(readFileSync(seen, "utf8").trim()).toBe("unset");
  });

  it("a stopped or failed rep records the arm in its result json", () => {
    writeFailedResult({ ...opts("gyro-s2"), codeGraph: "on" } as BenchRunOpts, "short", 1, 2, "refused", 1);
    expect(JSON.parse(readFileSync(join(dir, "results", "short", "gyro-s2-v2b", "rep1.json"), "utf8")).code_graph).toBe("on");
    writeFailedResult(opts("gyro-s2"), "short", 2, 2, "refused", 1);
    expect(JSON.parse(readFileSync(join(dir, "results", "short", "gyro-s2-v2b", "rep2.json"), "utf8")).code_graph).toBeUndefined();
  });

  it("the shipped set scripts turn the env into --code-graph on every worker start", () => {
    for (const f of ["evalset.sh", "realset.sh"]) {
      const text = readFileSync(join(process.cwd(), "bench", f), "utf8");
      expect(text).toContain('cgargs=(); [ "${BENCH_CODE_GRAPH:-}" = on ] && cgargs=(--code-graph on)');
      expect(text).toContain('${cgargs[@]+"${cgargs[@]}"} --class implement');
    }
  });
});
