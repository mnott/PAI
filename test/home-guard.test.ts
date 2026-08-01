/**
 * The guard guarding itself.
 *
 * setup-home-guard.ts is load-bearing but invisible: if setupFiles stops being
 * wired, or the file is renamed, every other test goes on passing while quietly
 * writing to the real ~/.pai again. That is precisely the failure mode it
 * exists to prevent, so it needs an assertion rather than trust.
 *
 * Manifest-diffing the home directory does NOT substitute for this. Checked on
 * 2026-08-01: PAI's daemon rewrites config.json, work-queue.json, registry.db
 * and the vault index continuously, so a before/after comparison shows changes
 * with no tests running at all. Real writes hide in that noise.
 */

import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

describe("test home is sandboxed", () => {
  it("does not resolve to the real home directory", () => {
    // Modules capture paths from homedir() at import time, so a leak here means
    // any module-level constant in the codebase points at real user data.
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(homedir()).toContain("pai-test-home-");
  });

  it("keeps the paths real code derives from it inside the sandbox", () => {
    // The exact shape that leaked: poller.ts computes this at module load and
    // persisted fixture ids into the live scheduler state on every run.
    expect(join(homedir(), ".pai", "scheduler-state.json")).toContain(tmpdir());
  });

  // Asserting homedir() alone covers only the HOME half of the guard. On macOS
  // and Linux that is the half that does the work, so dropping USERPROFILE
  // would leave every test above passing while the guard is inert on Windows —
  // a guard that reads as covered is worse than none.
  //
  // Each is checked for being SET before being compared. AIBroker's first
  // version of this assertion compared two undefined values and passed with the
  // guard unwired: a test against vacuous guards that was itself vacuous.
  it.each(["HOME", "USERPROFILE", "XDG_CONFIG_HOME"])("redirects %s", (name) => {
    const value = process.env[name];
    expect(value, `${name} is not set — the guard did not run`).toBeTruthy();
    expect(value!).toContain(tmpdir());
  });
});
