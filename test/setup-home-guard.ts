/**
 * Point HOME at a throwaway directory for the whole test run.
 *
 * Modules routinely compute a path from homedir() at import time — poller.ts's
 * STATE_FILE is one — so a test never has to mention a home path to write to
 * one. On 2026-08-01 a single non-dry tick with no state-file override had been
 * persisting fixture ids and a frozen clock into the real
 * ~/.pai/scheduler-state.json on every run, for as long as the test existed.
 * Nothing failed, because a test that corrupts live state still passes.
 *
 * That was the mild version. The same evening, AIBroker found its own suite
 * writing to the live PAILot offline queue at ~/.aibroker/pailot-queue.json and
 * replacing it with eight fixtures — 99,772,955 bytes down to 885, saved with
 * backup: false, unrecoverable, on every one of ~30 runs that night.
 *
 * Fixing each site as it is discovered does not hold: the next module to derive
 * a path from homedir() reintroduces it silently, and the failure is invisible
 * by construction. Redirecting HOME once, before any module loads, makes the
 * whole class unreachable rather than merely absent.
 *
 * A test that fails because of this is telling you it depends on real user
 * state. That is the bug, not this file.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PATH_ENV_VARS } from "../src/runtime-paths.js";

const sandbox = mkdtempSync(join(tmpdir(), "pai-test-home-"));

process.env.HOME = sandbox;
// os.homedir() prefers these on their respective platforms and ignores HOME,
// so setting only HOME would leave the guard half-applied.
process.env.USERPROFILE = sandbox;
process.env.XDG_CONFIG_HOME = join(sandbox, ".config");

/**
 * Sockets, logs and pidfiles are NOT home-derived — they are hardcoded absolute
 * paths under /tmp, shared with a live daemon, and redirecting HOME does
 * nothing for them. That distinction was missed once already: a fake-HOME run
 * was taken as proof the suite touched no real state, when by construction it
 * could only ever have inspected what landed under the redirected home.
 *
 * Iterating the exported list rather than naming paths here means a new runtime
 * path cannot be added without also being protected.
 */
for (const key of RUNTIME_PATH_ENV_VARS) {
  process.env[key] = join(sandbox, "runtime", key.toLowerCase());
}
