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

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PATH_ENV_VARS } from "../src/runtime-paths.js";

const realHome = homedir();
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

/**
 * Inside a PAI worker these point at the worker's own workers.yaml copy and
 * provider, so config-writer tests read and write that instead of their temp
 * fixtures (16 failures, 2026-10-19). A test run must see none of them.
 *
 * The session-profile work added PAI_SESSION_* routing vars on top; prefix
 * clearing covers those and any further PAI_SESSION_* a later launch path
 * exports (a worker launched from a profiled session leaked
 * PAI_SESSION_WORKER_PROVIDER into run-env.test.ts's "remote provider is
 * untouched"). Prefix, not name: a new routing var cannot be added without
 * also being protected.
 *
 * PAI_PANE_* is the pane launcher's own environment (PAI_PANE_EXEC marks a
 * pane-exec child, PAI_PANE_RUN a pane run): a suite run inside a pane made
 * build-pane.test.ts see "already in a pane" and skip the pane path.
 */
for (const key of Object.keys(process.env)) {
  if (key === "PAI_WORKERS_YAML" || key.startsWith("PAI_WORKER") || key.startsWith("PAI_SESSION") || key.startsWith("PAI_PANE")) {
    delete process.env[key];
  }
}

/**
 * The local-server client timeouts buildRunEnv sets for loopback providers
 * (run-env.ts LOCAL_API_TIMEOUT_MS). A worker spawned for a local provider
 * carries them; inherited, they make run-env.test.ts's "remote provider is
 * untouched" see a remote run with the local timeouts set. A test run must
 * see none of them.
 */
for (const key of ["API_TIMEOUT_MS", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS"]) {
  delete process.env[key];
}

/**
 * Claude Code's own session identity. A test run started from inside a Claude
 * Code session inherits these, and since a6bd52a0 detectSessionName consults
 * callerIdentity(), which reads CLAUDE_JOB_DIR / CLAUDE_CODE_SESSION_ID: the
 * inherited job made status-line.test.ts's "shows the profile route without
 * PAI_SESSION_NAME, via detectSessionName" resolve the real job's name instead
 * of the fixture's (expected '' to contain 'workers: glm/fast'). The same list
 * run-env.ts strips at the spawn boundary, plus the job dir and terminal ids
 * callerIdentity and the AIBroker client read. A test that needs an identity
 * sets it explicitly (caller-identity.test.ts, run-events.test.ts).
 *
 * Prefix, not name: a new CLAUDE_CODE_* identity var cannot be added without
 * also being protected. CLAUDE_CONFIG_DIR stays — cockpit.test.ts sets it
 * itself and a run without it reads the guarded home, not the real one.
 *
 * Terminal identity (TERM_SESSION_ID, ITERM_SESSION_ID, TMUX, TMUX_PANE, the
 * ones pane.ts and pane-title.ts read to address a real terminal session) is
 * stripped too. On 2026-10-21, twice, followPaneRun tests that defaulted to
 * process.env and the real pane ops finished a run and closeOwnPane closed the
 * iTerm session inherited from the Claude session that had started the suite:
 * the operator's window disappeared. A test that needs a terminal id passes it
 * in explicitly (pane-registry.test.ts sets its own in beforeEach).
 */
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("CLAUDE_CODE_") ||
    key === "CLAUDE_JOB_DIR" ||
    key === "CLAUDE_PID" ||
    key === "CLAUDECODE" ||
    key === "TERM_SESSION_ID" ||
    key === "ITERM_SESSION_ID" ||
    key === "TMUX" ||
    key === "TMUX_PANE"
  ) {
    delete process.env[key];
  }
}

/**
 * Config and database isolation. HOME alone is not enough: PAI_HOME,
 * PAI_CONFIG_FILE and CLAUDE_CONFIG_DIR inherited from the operator's shell
 * (or a worker) point straight at the live config.yaml, whose
 * postgres.connectionString is the live database. On 2026-10-24 01:48 UTC the
 * live `projects` table was wiped by a test run that could reach it.
 *
 * Three layers:
 *  1. Read the live database name BEFORE redirecting anything and export it as
 *     PAI_TEST_LIVE_DB; createPgPool (src/storage/pg-pool.ts) refuses to
 *     connect to it ("test tried to open the live database").
 *  2. Point PAI_CONFIG_FILE at the sandbox and drop inherited PAI_HOME/CLAUDE_CONFIG_DIR,
 *     then write a config there.
 *     It keeps the live server's host and credentials, so
 *     the scratch-database tests (which derive pai_test_* URLs from the
 *     configured connection string) still work, but names a throwaway database.
 *  3. These are process.env writes, so every `pai` child a test spawns with the
 *     default env inherits the sandbox config and the guard variable.
 */
function liveConnectionString(): string | undefined {
  const real = realHome;
  const dirs = [process.env.PAI_HOME, join(real, ".pai"), join(real, ".claude", "pai")];
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const m = /connectionString:\s*["']?([^\s"']+)/.exec(readFileSync(join(dir, "config.yaml"), "utf8"));
      if (m) return m[1];
    } catch {
      // next candidate
    }
  }
  return undefined;
}

const liveUrl = liveConnectionString();
const paiHome = join(sandbox, "pai-config");
mkdirSync(paiHome, { recursive: true });
process.env.PAI_CONFIG_FILE = join(paiHome, "config.json");
// Inherited overrides would point the home resolvers back at the live dirs;
// without them they resolve under the sandbox HOME.
for (const key of ["PAI_HOME", "CLAUDE_CONFIG_DIR", "PAI_DIR", "ADAPTER_DIR"]) delete process.env[key];

if (liveUrl) {
  try {
    process.env.PAI_TEST_LIVE_DB = decodeURIComponent(new URL(liveUrl).pathname.slice(1));
    const throwaway = new URL(liveUrl);
    throwaway.pathname = "/pai_test_config_unused";
    writeFileSync(
      join(paiHome, "config.yaml"),
      `storageBackend: sqlite\npostgres:\n  connectionString: ${throwaway.toString()}\n`,
    );
  } catch {
    // unparseable URL: nothing to protect or derive from
  }
}
