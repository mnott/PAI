/**
 * Runs a command implementation that registers itself on a Commander node
 * (the memory, kg, zettel, ... bodies) from a parsed CommandDef call. The
 * CommandDef is the only description of flags a user sees; this turns the
 * parsed values back into the exact argv those implementations expect.
 */

import { Command, CommanderError } from "commander";
import type { CommandDef, RunContext } from "../define.js";
import { CliError } from "../define.js";

/** Rebuild argv (positionals in declared order, then set options) from a parsed call. */
export function argvFromContext(def: Pick<CommandDef, "args" | "options">, ctx: RunContext): string[] {
  const out: string[] = [];
  for (const a of def.args ?? []) {
    const v = ctx.args[a.name];
    if (Array.isArray(v)) out.push(...v);
    else if (v !== undefined) out.push(v);
  }
  for (const o of def.options ?? []) {
    const v = ctx.opts[o.name];
    if (v === undefined || v === false) continue;
    if (o.type === "boolean") out.push(`--${o.name}`);
    else out.push(`--${o.name}`, String(v));
  }
  return out;
}

/**
 * `path` is the command words below the registered node, e.g. ["tokens", "files"].
 * `parent` names the node `register` attaches to (e.g. "memory").
 */
export async function runBridged(
  register: (node: Command) => void,
  parent: string,
  path: string[],
  def: Pick<CommandDef, "args" | "options">,
  ctx: RunContext
): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  register(program.command(parent));
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "pai", parent, ...path, ...argvFromContext(def, ctx)]);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) return 0;
      throw new CliError(e.message.replace(/^error: /, ""), `pai help ${[parent, ...path].join(" ")}`, e.exitCode);
    }
    throw e;
  }
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;
  return code;
}

/** Attach a bridged `run` to a definition. */
export function bridged(
  register: (node: Command) => void,
  parent: string,
  path: string[],
  def: Omit<CommandDef, "run">
): CommandDef {
  return { ...def, run: (ctx) => runBridged(register, parent, path, def, ctx) };
}
