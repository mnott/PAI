/**
 * priority.ts — workers never take CPU from the operator's interactive work.
 *
 * (1) the worker's process (and so every Bash child) starts under `taskpolicy -b` on macOS (background QoS:
 *     low CPU and IO priority, efficiency cores), `nice -n 10` elsewhere; workers.priority.background, default true.
 * (2) every Bash command of a worker gets a `ulimit -S -t N` prefix (workers.priority.cpuSecondsPerCommand, default 300),
 *     so a runaway loop dies on its own. Test runs and builds through their doors run uncapped (soft limit raised).
 */

import type { PriorityConfig } from "./config.js";
import { isTestCommand } from "./hang-probe.js";

export const DEFAULT_CPU_SECONDS = 300;
/** Exit status of a process killed by SIGXCPU (128 + 24 on macOS and Linux x86/arm). */
const XCPU_RC = 152;

/** Is background priority on (default true)? */
export function backgroundEnabled(cfg?: Pick<PriorityConfig, "background">): boolean {
  return cfg?.background !== false;
}

/** The command line prefixed with the background-priority wrapper; unchanged when disabled or already wrapped. */
export function backgroundArgv(argv: string[], cfg?: Pick<PriorityConfig, "background">, platform: string = process.platform): string[] {
  if (!backgroundEnabled(cfg) || !argv.length || argv[0] === "taskpolicy" || argv[0] === "nice") return argv;
  return platform === "darwin" ? ["taskpolicy", "-b", ...argv] : ["nice", "-n", "10", ...argv];
}

/** CPU seconds one Bash command may use; 0 = no cap. */
export function cpuSecondsOf(cfg?: Pick<PriorityConfig, "cpuSecondsPerCommand">): number {
  const n = cfg?.cpuSecondsPerCommand;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_CPU_SECONDS;
}

/**
 * The Bash command with the CPU cap in front. `uncapped` (test/build doors) lifts the soft limit instead, so a
 * limit inherited from an earlier command of the same shell does not bite. Idempotent.
 */
export function withCpuLimit(command: string, seconds: number, uncapped = false): string {
  if (/^ulimit -S -t /.test(command)) return command;
  if (uncapped || seconds <= 0) return `ulimit -S -t unlimited 2>/dev/null\n${command}`;
  return (
    `ulimit -S -t ${seconds} 2>/dev/null\n${command}\n` +
    `__pai_rc=$?; [ "$__pai_rc" -eq ${XCPU_RC} ] && echo "CPU time limit exceeded (${seconds} s per command, workers.priority.cpuSecondsPerCommand): a loop or a heavy job; fix the loop, or run builds and tests through their door" >&2; (exit $__pai_rc)`
  );
}

/**
 * Build tools whose work lives in a long-lived detached daemon (Gradle, Kotlin, Xcode's build service, sccache) or runs for minutes of
 * CPU. RLIMIT_CPU is inherited by every descendant and counts per process, so under the cap the Gradle daemon is SIGXCPU-killed mid-compile
 * ("Gradle build daemon disappeared unexpectedly", 2026-11-26) while the same command from a plain pane survives.
 */
const BUILD_TOOL_RE =
  /(^|[\s;&|(`/])(\.\/)?(gradlew?|mvnw?|flutter\s+(build|run|test|assemble)|xcodebuild|cargo\s+(build|test|check|clippy|install|run|bench)|swift\s+(build|test)|make|cmake|ninja|bazel|ndk-build|fastlane|pod\s+install|build-[\w.-]+\.sh|build\.sh)(\s|$|;|&|\|)/;

/** True for a command that runs a build tool; its detached daemons would inherit the CPU cap. */
export function isBuildToolCommand(command: string): boolean {
  return BUILD_TOOL_RE.test(command);
}

/** True for commands that legitimately need more CPU time: test runs (the test-run wrapper), build tools and the machine-wide build queue. */
export function isHeavyDoor(command: string): boolean {
  return isTestCommand(command) || isBuildToolCommand(command) || command.includes("pai worker test-run") || /\bpai build (run|lock)\b/.test(command);
}

/** The Bash command a worker actually runs: test/build doors uncapped, everything else under the CPU cap. */
export function capBashCommand(command: string, cfg?: Pick<PriorityConfig, "cpuSecondsPerCommand">): string {
  return withCpuLimit(command, cpuSecondsOf(cfg), isHeavyDoor(command));
}
