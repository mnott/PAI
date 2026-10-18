/** Test helpers for commands fronted by `legacyRunner`: tree parity with the Commander implementation, and an in-process runner. */

import { Command } from "commander";
import type { CommandDef } from "../define.js";
import type { Register } from "./legacy.js";

/** Differences between a CommandDef tree and what the Commander implementation registers (empty = identical). */
export function treeDiff(def: CommandDef, cmd: Command, path = def.name): string[] {
  const out: string[] = [];
  const subs = def.subcommands ?? [];
  const names = (xs: string[]) => [...xs].sort().join(",");
  if (names(subs.map((s) => s.name)) !== names(cmd.commands.map((c) => c.name()))) {
    out.push(`${path}: subcommands ${names(subs.map((s) => s.name))} != ${names(cmd.commands.map((c) => c.name()))}`);
  }
  const flags = (o: { name: string }[]) => names(o.map((x) => x.name));
  const real = cmd.options.map((o) => ({ name: (o.long ?? "").replace(/^--/, "") }));
  const declared = (def.options ?? []).filter((o) => o.name !== "dry-run" || real.some((r) => r.name === "dry-run"));
  if (flags(declared) !== flags(real)) out.push(`${path}: options ${flags(declared)} != ${flags(real)}`);
  const argNames = (def.args ?? []).filter((a) => a.name !== "MORE").map((a) => a.name);
  const realArgs = cmd.registeredArguments.map((a) => a.name().toUpperCase().replace(/-/g, "_"));
  if (argNames.join(",") !== realArgs.join(",")) out.push(`${path}: args ${argNames} != ${realArgs}`);
  for (const s of subs) {
    const c = cmd.commands.find((x) => x.name() === s.name);
    if (c) out.push(...treeDiff(s, c, `${path} ${s.name}`));
  }
  return out;
}

export function treeFor(register: Register, group: string): Command {
  const root = new Command();
  const g = root.command(group);
  register(g);
  return g;
}

export { helpProblems, runPai } from "./test-helpers.js";
