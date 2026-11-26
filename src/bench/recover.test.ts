/**
 * Fault 2026-11-26 (series h2h-g2-dualA / h2h-g2-dualB): the series watchdog fired after the engine stalled,
 * and writeStoppedResult wrote {"status":"stopped","n":5,"passed":0,"tasks":[]} although three tasks had
 * already finished with hidden-test logs in the work dir. A stopped real rep must be recovered from what
 * realset.sh left behind: tests.log = finished (graded), worker.json without tests.log = interrupted,
 * nothing = not-run. n counts attempted tasks; never an empty tasks list when tasks ran.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bench-recover-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** run recover_real_rep exactly like run.ts does: argv + env only, no interpolation (bash >=5.3 array quirks are part of what this pins) */
function recover(work: string, out: string, tasks: string): unknown {
  const res = spawnSync("bash", ["-c", '. "$1"; shift; recover_real_rep "$@"', "recover", join(process.cwd(), "bench", "recover.sh"), out, "k", "1", work, "k-rep1", "watchdog-stopped: IDLE 900s"], { stdio: "ignore", env: { ...process.env, TASKS: tasks } });
  expect(res.status).toBe(0);
  return JSON.parse(readFileSync(join(out, "rep1.json"), "utf8"));
}

describe("recover_real_rep grades a stopped real rep from the work dir", () => {
  it("two finished + one interrupted + two not-run -> n=3, passed=1, never empty tasks", () => {
    const work = join(dir, "work", "real", "k-rep1");
    const out = join(dir, "results", "real", "k");
    mkdirSync(work, { recursive: true });
    // finished + passed (mirror-sync-token: 16 passed)
    writeFileSync(join(work, "mirror-sync-token.tests.log"), "Test Files  1 passed (1)\n      Tests  16 passed (16)\n");
    writeFileSync(join(work, "mirror-sync-token.worker.json"), JSON.stringify({ duration_ms: 310732 }));
    // finished + failed, with ANSI codes (prune-dist-rerun: 1 failed | 1 passed)
    writeFileSync(join(work, "prune-dist-rerun.tests.log"), "\x1b[2m Test Files \x1b[22m\x1b[31m1 failed\x1b[22m (1)\n      Tests \x1b[31m1 failed\x1b[22m | \x1b[32m1 passed\x1b[22m (2)\n");
    writeFileSync(join(work, "prune-dist-rerun.worker.json"), JSON.stringify({ duration_ms: 11873 }));
    // interrupted mid-worker: worker.json present, tests never ran
    writeFileSync(join(work, "worker-priority.worker.json"), JSON.stringify({ duration_ms: 11561 }));
    // session-move-selectors: empty worker.json (killed at start) -> not-run; escalate-loopstop: nothing -> not-run
    writeFileSync(join(work, "session-move-selectors.worker.json"), "");

    const r = recover(work, out, "prune-dist-rerun mirror-sync-token worker-priority session-move-selectors escalate-loopstop") as {
      status: string; graded: boolean; n: number; passed: number; error: string; tasks: { task: string; status: string; ok: boolean; reason: string }[];
    };
    expect(r.status).toBe("stopped");
    expect(r.graded).toBe(true);
    expect(r.error).toContain("IDLE 900s");
    expect(r.n).toBe(3); // attempted = finished + interrupted, not the not-run ones
    expect(r.passed).toBe(1);
    expect(r.tasks.length).toBe(5);
    const by = Object.fromEntries(r.tasks.map((t) => [t.task, t]));
    expect(by["mirror-sync-token"].status).toBe("graded");
    expect(by["mirror-sync-token"].ok).toBe(true);
    expect(by["prune-dist-rerun"].status).toBe("graded");
    expect(by["prune-dist-rerun"].ok).toBe(false);
    expect(by["worker-priority"].status).toBe("interrupted");
    expect(by["worker-priority"].reason).toContain("watchdog/idle");
    expect(by["session-move-selectors"].status).toBe("not-run");
    expect(by["escalate-loopstop"].status).toBe("not-run");
  });

  it("nothing ran -> n=0, all not-run, still a valid json (never crashes)", () => {
    const work = join(dir, "work", "real", "k-rep1");
    const out = join(dir, "results", "real", "k");
    mkdirSync(work, { recursive: true });
    const r = recover(work, out, "a b") as { n: number; passed: number; tasks: unknown[] };
    expect(r.n).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.tasks.length).toBe(2);
  });

  it("writeStoppedResult uses the recovery for real sets instead of an empty tasks list", () => {
    // end-to-end through run.ts: a stopped real rep with finished work files gets graded tasks
    const work = join(dir, "work", "real", "gyro-s2-rep1");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "mirror-sync-token.tests.log"), "      Tests  16 passed (16)\n");
    writeFileSync(join(work, "mirror-sync-token.worker.json"), JSON.stringify({ duration_ms: 3000 }));
    // tsx -e evaluates the snippet as CommonJS (argv[0] is plain node), so a bare ".js" specifier does not
    // resolve to the TS source; import the .ts file URL, which is what run.js resolves to at runtime.
    const res = spawnSync("npx", ["tsx", "-e", `
      import { writeStoppedResult } from "file://${join(process.cwd(), "src", "bench", "run.ts")}";
      writeStoppedResult({ dir: "${dir}", key: "gyro-s2" }, "${join(process.cwd(), "bench")}", "real", 1, { reason: "IDLE", detail: "900s without worker activity" }, 7925);
    `], { stdio: "ignore" });
    expect(res.status).toBe(0);
    const r = JSON.parse(readFileSync(join(dir, "results", "real", "gyro-s2", "rep1.json"), "utf8"));
    expect(r.status).toBe("stopped");
    expect(r.graded).toBe(true);
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(r.passed).toBe(1);
  });

  it("injection in the error text is stored verbatim, never executed", () => {
    // review 2026-11-26: run.ts must pass paths/TASKS/error as argv — $(), backticks and \ must not run.
    const work = join(dir, "work", "real", "inj-rep1");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a.tests.log"), "      Tests  3 passed (3)\n");
    writeFileSync(join(work, "a.worker.json"), JSON.stringify({ duration_ms: 1000 }));
    const marker = join(dir, "PWNED");
    // the injection payload is the Verdict detail: run.ts builds error = `watchdog-stopped: ${reason} ${detail}`,
    // so this is exactly what reaches recover.sh's argv.
    const detail = '$(touch "' + marker + '") `touch ' + marker + '` \\$(id)';
    const res = spawnSync("npx", ["tsx", "-e", `
      import { writeStoppedResult } from "file://${join(process.cwd(), "src", "bench", "run.ts")}";
      writeStoppedResult({ dir: "${dir}", key: "inj" }, "${join(process.cwd(), "bench")}", "real", 1, { reason: "IDLE", detail: ${JSON.stringify(detail)} }, 60);
    `], { stdio: "ignore", env: { ...process.env, TASKS: 'a $(touch "' + marker + '")' } });
    expect(res.status).toBe(0);
    const r = JSON.parse(readFileSync(join(dir, "results", "real", "inj", "rep1.json"), "utf8"));
    expect(r.error).toBe(`watchdog-stopped: IDLE ${detail}`); // stored verbatim
    expect(existsSync(marker)).toBe(false); // nothing executed
    expect(r.tasks.length).toBe(1);
    expect(r.passed).toBe(1);
  });
});
