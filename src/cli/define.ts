/**
 * The one shape every pai command is declared in. Help, the overview, the
 * Markdown reference (`pai doc`) and the argument parser all read it, so the
 * text people see and the behaviour they get cannot drift apart.
 */

import type { Style } from "./help.js";

export interface ArgDef {
  /** Upper-case placeholder shown in Usage, e.g. NAME_OR_ID. */
  name: string;
  summary: string;
  required?: boolean;
  /** Collects every remaining positional argument. */
  variadic?: boolean;
}

export interface OptDef {
  /** Long flag without dashes, e.g. "provider". The same name means the same thing on every command. */
  name: string;
  short?: string;
  type: "string" | "boolean" | "number";
  /** Value placeholder for string/number flags, e.g. NAME. */
  value?: string;
  default?: string | number | boolean;
  summary: string;
  /** May be given several times; every value is in RunContext.multi (opts holds the last). */
  repeatable?: boolean;
  /** String flag whose value may be left out (`--auto-exit` or `--auto-exit 30`); absent value reads as true. */
  optionalValue?: boolean;
}

export interface RunContext {
  args: Record<string, string | string[] | undefined>;
  opts: Record<string, string | number | boolean | undefined>;
  /** Every value of a repeatable option, in order. */
  multi?: Record<string, string[]>;
  /** Global --dry-run: print the exec line instead of executing. */
  dryRun: boolean;
  /** Everything after a bare `--` (passed to claude verbatim). */
  rest: string[];
}

/** Thrown by a command to fail with a plain message and the next thing to type. */
export class CliError extends Error {
  constructor(message: string, readonly hint?: string, readonly exitCode = 1) {
    super(message);
  }
}

export interface CommandDef {
  name: string;
  summary: string;
  /** Longer description shown by `pai help <command>`. */
  description: string;
  args?: ArgDef[];
  options?: OptDef[];
  /** Real, runnable command lines. */
  examples: string[];
  /** Related commands, written as they are typed, e.g. "pai open". */
  seeAlso?: string[];
  subcommands?: CommandDef[];
  /** Set on a top-level shortcut: the full `noun verb` it stands for. */
  aliasOf?: string;
  /** Listed on the first screen (`pai`); everything else is under `pai more`. */
  daily?: boolean;
  /** Works, but is not listed in help (an old spelling kept for callers). */
  hidden?: boolean;
  /** Accept `-- args` and pass them on. */
  passthrough?: boolean;
  /** Options and words this command does not know are kept, in order, in `rest` (for commands that wrap another program). */
  allowUnknown?: boolean;
  /**
   * The command's run. `io` is the same Io the dispatcher got: commands that
   * spawn a probe process read `io.run` when it is set (tests inject a runner;
   * production leaves it unset and spawns for real).
   */
  run?: (ctx: RunContext, io?: Io) => Promise<number | void> | number | void;
}

export type GroupId = "sessions" | "providers" | "help" | "workers" | "memory" | "daemon";

export interface GroupDef {
  id: GroupId;
  title: string;
  /** Shown on the overview screen; otherwise only under `pai help more`. */
  daily: boolean;
  commands: CommandDef[];
}

/** A command run's output channel; `run` is the spawn seam probe commands use (tests inject it). */
export interface Io {
  out(s: string): void;
  err(s: string): void;
  style: Style;
  /** Replaces spawning a probe process (argv, env, timeout) — tests only. */
  run?: (argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ rc: number; stdout: string; stderr: string }>;
}

/** Shared flags: one spelling, one meaning, everywhere. */
export const OPT = {
  project: { name: "project", type: "string", value: "NAME", summary: "Only this project (name or path)" },
  provider: { name: "provider", type: "string", value: "NAME", summary: "Provider to run on (see: pai providers)" },
  model: { name: "model", type: "string", value: "ID", summary: "Model id on that provider (default: its default model)" },
  json: { name: "json", type: "boolean", default: false, summary: "Machine-readable JSON output" },
  dryRun: { name: "dry-run", type: "boolean", default: false, summary: "Print the exec line instead of executing" },
} as const satisfies Record<string, OptDef>;
