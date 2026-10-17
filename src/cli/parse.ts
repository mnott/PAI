/**
 * Argument parsing driven by CommandDef — no second description of the flags.
 * Errors are UsageErrors: they say what is wrong, and the dispatcher adds the
 * Usage line and a pointer to help (exit code 2).
 */

import type { CommandDef, OptDef, RunContext } from "./define.js";
import { suggest } from "./help.js";

export class UsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

const GLOBAL_FLAGS: OptDef[] = [
  { name: "dry-run", type: "boolean", summary: "" },
  { name: "help", short: "h", type: "boolean", summary: "" },
];

export interface Parsed extends RunContext {
  help: boolean;
}

export function parseArgs(cmd: CommandDef, argv: string[]): Parsed {
  const defs = [...(cmd.options ?? []), ...GLOBAL_FLAGS.filter((g) => !(cmd.options ?? []).some((o) => o.name === g.name))];
  const byLong = new Map(defs.map((o) => [o.name, o]));
  const byShort = new Map(defs.filter((o) => o.short).map((o) => [o.short!, o]));
  const opts: RunContext["opts"] = {};
  const positional: string[] = [];
  const rest: string[] = [];
  const multi: Record<string, string[]> = {};
  const loose = cmd.allowUnknown === true;
  let seenUnknown = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      if (loose && seenUnknown) rest.push("--");
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("-") && tok.length > 1 && !/^-\d/.test(tok)) {
      let def: OptDef | undefined;
      let inline: string | undefined;
      if (tok.startsWith("--")) {
        const eq = tok.indexOf("=");
        const name = eq < 0 ? tok.slice(2) : tok.slice(2, eq);
        if (eq >= 0) inline = tok.slice(eq + 1);
        def = byLong.get(name);
        if (!def && loose) {
          seenUnknown = true;
          rest.push(tok);
          continue;
        }
        if (!def) {
          const near = suggest(name, [...byLong.keys()]);
          throw new UsageError(
            `unknown option --${name}${near ? ` — did you mean --${near}?` : ""}`,
            "pai help " + "<command> lists the options of a command"
          );
        }
      } else {
        def = byShort.get(tok[1]);
        if (!def && loose) {
          seenUnknown = true;
          rest.push(tok);
          continue;
        }
        if (!def) throw new UsageError(`unknown option ${tok.slice(0, 2)}`);
        if (tok.length > 2) inline = tok.slice(2);
      }
      if (def.type === "boolean") {
        opts[def.name] = inline === undefined ? true : inline !== "false";
        continue;
      }
      if (def.optionalValue && inline === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) opts[def.name] = def.type === "number" ? Number(argv[++i]) : argv[++i];
        else opts[def.name] = true;
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`option --${def.name} needs a value (${def.value ?? def.type.toUpperCase()})`);
      }
      if (def.type === "number") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new UsageError(`option --${def.name} needs a number, got "${value}"`);
        opts[def.name] = n;
      } else {
        opts[def.name] = value;
        if (def.repeatable) (multi[def.name] ??= []).push(value);
      }
      continue;
    }
    if (loose) rest.push(tok);
    else positional.push(tok);
  }

  for (const o of defs) if (opts[o.name] === undefined && o.default !== undefined) opts[o.name] = o.default;

  const args: RunContext["args"] = {};
  const argDefs = cmd.args ?? [];
  let p = 0;
  for (const a of argDefs) {
    if (a.variadic) {
      args[a.name] = positional.slice(p);
      p = positional.length;
    } else {
      args[a.name] = positional[p++];
    }
    const v = args[a.name];
    if (a.required && (v === undefined || (Array.isArray(v) && v.length === 0)) && !opts.help) {
      throw new UsageError(`missing required argument ${a.name} — ${a.summary.replace(/\.$/, "")}`);
    }
  }
  if (p < positional.length && !opts.help) {
    throw new UsageError(`unexpected argument "${positional[p]}"`);
  }
  if (rest.length && !cmd.passthrough && !loose) throw new UsageError(`unexpected arguments after --: ${rest.join(" ")}`);

  return { args, opts, multi, dryRun: opts["dry-run"] === true, rest, help: opts.help === true };
}
