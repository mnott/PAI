/**
 * The one way PAI reads the whole process table. A table with a few dozen
 * Xcode swift-frontend processes (23k-99k char command lines) is over 1 MB,
 * Node's default maxBuffer, so a bare execFileSync("ps", ...) died with ENOBUFS.
 * Here the buffer is large and every line is cut to MAX_LINE chars after reading
 * (the identifying words of a command come first).
 */
import { execFileSync } from "node:child_process";

export const PS_MAX_BUFFER = 64 * 1024 * 1024;
export const PS_MAX_LINE = 1024;

export type PsRunner = (args: string[]) => string;

const realRunner: PsRunner = (args) =>
  execFileSync("ps", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: PS_MAX_BUFFER, timeout: 15_000 });

/** Cut each line of `text` to `max` chars. */
export function truncateLines(text: string, max = PS_MAX_LINE): string {
  return text
    .split("\n")
    .map((l) => (l.length > max ? l.slice(0, max) : l))
    .join("\n");
}

/** `ps -axo <format>` with a large buffer and truncated lines; throws when ps fails. */
export function psTable(format: string, run: PsRunner = realRunner, maxLine = PS_MAX_LINE): string {
  return truncateLines(run(["-axo", format]), maxLine);
}

/** psTable that retries, then returns null ("unknown") instead of throwing. */
export function psTableOrNull(format: string, run: PsRunner = realRunner, tries = 3, maxLine = PS_MAX_LINE): string | null {
  for (let i = 0; i < tries; i++) {
    try {
      return psTable(format, run, maxLine);
    } catch {
      /* retry */
    }
  }
  return null;
}
