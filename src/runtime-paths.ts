/**
 * runtime-paths.ts — the shared files PAI talks to the running daemon through.
 *
 * Sockets, logs and pidfiles live at fixed absolute paths under /tmp, and every
 * one of them is shared with a *live* daemon. That makes them the same hazard
 * as any other piece of real user state a test can reach: writing one from a
 * test does not fail, it corrupts something already running, silently.
 *
 * The home guard in test/setup-home-guard.ts does not cover them. It works by
 * redirecting HOME, so it protects paths *derived* from the home directory and
 * nothing else — a hardcoded "/tmp/pai.sock" walks straight past it. Verified
 * on 2026-08-01 by snapshotting all five and running the suite: nothing writes
 * to them today. But "no test does this yet" is not a property, and the next
 * daemon test to be written would clobber the live socket with nothing to stop
 * it.
 *
 * So each path is read from an environment variable with the historical /tmp
 * value as its default. Behaviour is unchanged for every real invocation; the
 * test setup overrides the variables and the whole class becomes unreachable
 * rather than merely absent, the same way the home guard works.
 *
 * Read at call time, not at module load: the test setup file runs before any
 * module is imported, but resolving these eagerly would still bake in whatever
 * the environment held at import and make the override order matter.
 */

/** IPC socket for the PAI daemon. */
export function paiSocketPath(): string {
  return process.env.PAI_SOCKET_PATH ?? "/tmp/pai.sock";
}

/** IPC socket for the AIBroker daemon — read by PAI, owned by AIBroker. */
export function aibrokerSocketPath(): string {
  return process.env.PAI_AIBROKER_SOCKET_PATH ?? "/tmp/aibroker.sock";
}

/** Where the daemon's stdout and stderr are collected. */
export function daemonLogPath(): string {
  return process.env.PAI_DAEMON_LOG_PATH ?? "/tmp/pai-daemon.log";
}

/** Pidfile for the running daemon. */
export function daemonPidPath(): string {
  return process.env.PAI_DAEMON_PID_PATH ?? "/tmp/pai-daemon.pid";
}

/** Where the launchd scheduler tick writes its output. */
export function schedulerLogPath(): string {
  return process.env.PAI_SCHEDULER_LOG_PATH ?? "/tmp/pai-scheduler.log";
}

/**
 * Every runtime path, for the test guard to redirect in one place.
 *
 * Listed here rather than in the guard so that adding a path and forgetting to
 * protect it is not possible: the guard iterates this.
 */
export const RUNTIME_PATH_ENV_VARS = [
  "PAI_SOCKET_PATH",
  "PAI_AIBROKER_SOCKET_PATH",
  "PAI_DAEMON_LOG_PATH",
  "PAI_DAEMON_PID_PATH",
  "PAI_SCHEDULER_LOG_PATH",
] as const;
