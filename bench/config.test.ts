/**
 * Fault 2026-11-25, series cg-off signal-2: realset.sh wrote ONE private config per series and every
 * task worker inherited PAI_CONFIG_FILE. Task 3 ran pai commands as part of its task, which rewrote
 * that file through the config store (workers.enabled:false, routing order lost); tasks 4 and 5 then
 * failed in 1 s with "pai: workers are off". The bench measured its own config damage, not the model.
 * Fix: the per-task loop regenerates the private config from the template before EVERY task start
 * (bench/config.sh write_bench_config). These tests drive the real scripts with stub `git`/`pai` and
 * assert a config damaged by one task is restored from the template before the next task starts.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = process.cwd();
const BENCH = join(REPO, "bench");
const TASKS = ["t1", "t2", "t3"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** fake BENCH dir: task dirs with meta.env (only FIX/TESTS are read) plus a symlink to the real template */
function makeFakeBench(): string {
  const b = join(dir, "fakebench");
  mkdirSync(join(b, "tasks"), { recursive: true });
  for (const t of TASKS) {
    mkdirSync(join(b, "tasks", t));
    writeFileSync(join(b, "tasks", t, "meta.env"), `FIX=HEAD\nTESTS=x.test.ts\n`);
  }
  symlinkSync(join(BENCH, "config-eval.template.yaml"), join(b, "config-eval.template.yaml"));
  return b;
}

/** stub bin dir: `git`/`npx` no-op the clone/diff/test plumbing, `pai` records calls and can damage PAI_CONFIG_FILE like the config store does */
function makeStubBin(damageOnCall: number | null): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  const script = join(bin, "pai");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
n=$(cat "$CALLS" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$CALLS"
if [ -n "$DAMAGE_ON" ] && [ "$n" = "$DAMAGE_ON" ]; then
  printf 'workers:\\n  enabled: false\\n' > "$PAI_CONFIG_FILE"   # what the config store did to the shared file
fi
echo '{"instrument":null}' > "$PAI_CONFIG_FILE.worker.json"
exit 0
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(script, 0o755);
  return bin;
}

const cfgPath = (set: string, label: string): string =>
  set === "real"
    ? join(dir, "out", "work", "real", label, "config.yaml")
    : join(dir, "out", "work", "short", "gyro-s2", "rep999", "config.yaml");

/** the workers section must be enabled — that is what the config store rewrite killed (the template's own escalate.enabled:false is fine) */
const workersEnabled = (file: string): boolean => {
  const s = readFileSync(file, "utf8");
  return /workers:\n\s+enabled:\s+true/.test(s);
};

function runScript(script: string, args: string[], env: Record<string, string>): void {
  execFileSync(join(BENCH, script), args, {
    cwd: dir,
    env: { ...process.env, BENCH_DIR: join(dir, "out"), CALLS: join(dir, "calls.txt"), ...env },
  });
}

describe("realset.sh per-task config isolation", () => {
  it("config damaged by task 1 is restored from the template before task 2 starts (and stays clean to the end)", () => {
    const bin = makeStubBin(1); // the first worker run rewrites PAI_CONFIG_FILE through the config store
    runScript("realset.sh", ["gyro-s2", "-", "999"], {
      PATH: `${bin}:${process.env.PATH}`,
      TASKS: TASKS.join(" "),
      BENCH: makeFakeBench(),
      DAMAGE_ON: "1",
    });
    const cfg = cfgPath("real", "gyro-s2-rep999");
    expect(workersEnabled(cfg)).toBe(true); // every later task start rewrote it from the template
  });

  it("without damage the config still renders from the template with the provider pinned", () => {
    const bin = makeStubBin(null);
    runScript("realset.sh", ["gyro-s2", "-", "999"], {
      PATH: `${bin}:${process.env.PATH}`,
      TASKS: TASKS.join(" "),
      BENCH: makeFakeBench(),
    });
    const cfg = cfgPath("real", "gyro-s2-rep999");
    expect(readFileSync(cfg, "utf8")).toContain("order: [gyro-s2]");
  });
});

describe("evalset.sh config fresh before the run", () => {
  it("renders the private config from the template before the worker run", () => {
    const bin = makeStubBin(null);
    runScript("evalset.sh", ["gyro-s2", "-", "short", "999"], { PATH: `${bin}:${process.env.PATH}` });
    expect(workersEnabled(cfgPath("eval", ""))).toBe(true);
  });

  it("config damaged before the run is restored from the template immediately before it", () => {
    const bin = makeStubBin(null);
    // simulate a rewrite of the private config between setup and the run, the way the config store did
    const cfg = cfgPath("eval", "");
    mkdirSync(join(dir, "out", "work", "short", "gyro-s2", "rep999"), { recursive: true });
    writeFileSync(cfg, "workers:\n  enabled: false\n");
    runScript("evalset.sh", ["gyro-s2", "-", "short", "999"], { PATH: `${bin}:${process.env.PATH}` });
    expect(workersEnabled(cfg)).toBe(true);
  });
});
