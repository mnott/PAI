/**
 * Runs a command whose behaviour lives in a Commander `register*Commands`
 * function (src/cli2/impl). The new parser has already validated the words
 * and flags against the CommandDef; the original tokens are then handed to
 * Commander unchanged, so positional order, repeated flags, stdout format and
 * exit codes are exactly what hooks, skills and MCP prompts have always seen.
 */

import { Command, CommanderError } from "commander";
import type { CommandDef } from "../define.js";
import { err } from "./utils.js";

export type Register = (cmd: Command) => void;

/** Source of the raw tokens (after the program name). Tests replace it. */
export const rawSource = { argv: (): string[] => process.argv.slice(2) };

/** Build the Commander program for one group, parse `tokens` as `<group> <rest...>`, return the exit code. */
export async function runCommander(group: string, register: Register, tokens: string[]): Promise<number> {
  const program = new Command();
  program.name("pai").exitOverride();
  register(program.command(group));
  try {
    await program.parseAsync([group, ...tokens], { from: "user" });
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    // Same wording as the old entry point: the message alone, exit 1 (PAI_DEBUG=1 adds the stack).
    console.error(err(e instanceof Error ? e.message : String(e)));
    if (process.env.PAI_DEBUG && e instanceof Error) console.error(e.stack);
    return 1;
  }
}

/** `legacyRunner("project", register)` returns L(def): def with a run() that forwards everything typed after the group word. */
export function legacyRunner(group: string, register: Register) {
  return (def: Omit<CommandDef, "run">): CommandDef => ({
    ...def,
    run: () => runCommander(group, register, rawSource.argv().slice(1)),
  });
}

/**
 * Run an old-style command and return its exit code. The old commands report
 * failure by setting process.exitCode; the new entry point exits with the
 * number a command returns, so the two are bridged here.
 */
export async function legacy(fn: () => Promise<void> | void): Promise<number> {
  process.exitCode = undefined;
  await fn();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}
