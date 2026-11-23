/**
 * Run-level git identity guard (vitest globalSetup/globalTeardown).
 *
 * A test that runs `git config user.name X` with cwd defaulting to the repo
 * rewrites the operator's identity: a linked worktree shares the main repo's
 * .git/config, so the write lands on main and every later merge commit is
 * authored by the fixture (the real checkout picked up "bench <b@b>" on
 * 2026-11-19; 148 merge commits on main until it was restored by hand on
 * 2026-11-23).
 *
 * The per-test version of this guard made git-heavy tests time out and was
 * dropped (reverted in 78280e82). This is the cheap version: one
 * `git config --local --get` pair at setup, one comparison at teardown, for
 * the whole run. On a change it restores the recorded values, prints one loud
 * line naming the change, and fails the run (non-zero exit) so the merge gate
 * reverts. The worker-side backstop (src/workers/git-identity.ts) covers
 * worker add/merge; this covers the gate's own vitest run in the main
 * checkout.
 */

import { execFileSync } from "node:child_process";
import { readGitIdentity, type GitIdentity } from "./git-identity.js";

/** Snapshot the repo identity once, before any test module loads. */
export function setup(): void {
  (globalThis as { __paiGitIdentityBaseline?: GitIdentity }).__paiGitIdentityBaseline =
    readGitIdentity(process.cwd());
}

/**
 * Compare against the snapshot; restore and fail the run on a change.
 * Throwing from globalTeardown makes vitest exit non-zero.
 */
export function teardown(): void {
  const base = (globalThis as { __paiGitIdentityBaseline?: GitIdentity }).__paiGitIdentityBaseline;
  if (!base) return; // not a repo at setup: nothing to protect
  const now = readGitIdentity(process.cwd());
  const changed: string[] = [];
  for (const field of ["name", "email"] as const) {
    if (now[field] === base[field]) continue;
    changed.push(`user.${field} ${now[field] ?? "(unset)"} -> ${base[field] ?? "(unset)"}`);
  }
  if (!changed.length) return;
  // Restore first, then fail: the repo must not stay corrupted even though the run fails.
  for (const field of ["name", "email"] as const) {
    if (now[field] === base[field]) continue;
    const key = `user.${field}`;
    if (base[field] === null) {
      try { execConfig(["--unset", key]); } catch { /* already gone */ }
    } else {
      execConfig([key, base[field]!]);
    }
  }
  const line = `git identity guard: the test run changed the repo's git identity (${changed.join("; ")}); restored. A test wrote git config into the real repo — pass an explicit temp dir or \`-C <tmp>\`; never let a fixture write the operator's identity.`;
  console.error(`WARNING ${line}`);
  throw new Error(line);
}

function execConfig(args: string[]): void {
  execFileSync("git", ["-C", process.cwd(), "config", "--local", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}
