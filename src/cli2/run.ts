/**
 * Dispatcher: argv -> command -> run. Owns exit codes (0 ok, 1 failed, 2 bad
 * usage) and the wording of every usage error, so no command prints a stack
 * trace or a bare code.
 */

import { readFileSync } from "node:fs";
import { resolveFromModule } from "../module-paths.js";
import type { CommandDef, GroupDef } from "./define.js";
import { CliError } from "./define.js";
import { colorEnabled, makeStyle, renderCommandHelp, renderOverview, suggest, usageLine, type Style } from "./help.js";
import { parseArgs, UsageError } from "./parse.js";

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolveFromModule(import.meta.url, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface Io {
  out(s: string): void;
  err(s: string): void;
  style: Style;
}

export function defaultIo(): Io {
  return {
    out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
    err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
    style: makeStyle(colorEnabled()),
  };
}

const find = (cmds: CommandDef[], name: string) => cmds.find((c) => c.name === name);

export interface Resolved {
  path: string[];
  cmd: CommandDef;
  rest: string[];
}

/** Walk argv down the command tree. Throws UsageError for an unknown command. */
export function resolve(groups: GroupDef[], argv: string[]): Resolved {
  const top = groups.flatMap((g) => g.commands);
  const first = argv[0];
  const cmd = find(top, first);
  if (!cmd) {
    const near = suggest(first, top.map((c) => c.name));
    throw new UsageError(`unknown command "${first}"${near ? ` — did you mean "${near}"?` : ""}`);
  }
  const path = [cmd.name];
  let cur = cmd;
  let rest = argv.slice(1);
  while (cur.subcommands?.length && rest[0] !== undefined && !rest[0].startsWith("-")) {
    const sub = find(cur.subcommands, rest[0]);
    if (!sub) {
      if (cur.run) break; // `pai providers NAME`-style: the word is an argument
      const near = suggest(rest[0], cur.subcommands.map((s) => s.name));
      throw new UsageError(
        `unknown command "${path.join(" ")} ${rest[0]}"${near ? ` — did you mean "${path.join(" ")} ${near}"?` : ""}`,
        `pai help ${path.join(" ")}`
      );
    }
    path.push(sub.name);
    cur = sub;
    rest = rest.slice(1);
  }
  return { path, cmd: cur, rest };
}

/** Run the CLI. Returns the process exit code. */
export async function runCli(groups: GroupDef[], argv: string[], io: Io = defaultIo(), root?: CommandDef): Promise<number> {
  const st = io.style;
  const overview = () =>
    renderOverview(groups, root ?? { name: "pai", summary: "Open a session by name", description: "", examples: [] }, cliVersion(), st);
  if (argv.length === 0 && !root) {
    io.out(overview());
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    io.out(cliVersion());
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    io.out(overview());
    return 0;
  }
  // Not a command word: it is a session name (or --with ...) for the daily path.
  const isCommand = argv.length > 0 && !argv[0].startsWith("-") && groups.some((g) => g.commands.some((c) => c.name === argv[0]));
  const target = !isCommand && root ? root : undefined;

  let resolved: Resolved | undefined;
  try {
    resolved = target ? { path: [], cmd: target, rest: argv } : resolve(groups, argv);
    const { cmd, path, rest } = resolved;
    const parsed = parseArgs(cmd, rest);
    const noArgs = rest.length === 0;
    if (parsed.help || (noArgs && !cmd.run && cmd.subcommands?.length)) {
      if (target) {
        io.out(overview());
        return 0;
      }
      io.out(renderCommandHelp(path, cmd, st));
      return 0;
    }
    if (!cmd.run) {
      io.err(st.red(`pai ${path.join(" ")} is not available in this build yet.`));
      io.err(cmd.later ? `Use the old command for now:  pai ${cmd.later}` : "See: pai help more");
      return 1;
    }
    return (await cmd.run(parsed)) ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(st.red(`pai: ${e.message}`));
      if (resolved) {
        io.err(`${st.bold("Usage")}  ${usageLine(resolved.path, resolved.cmd)}`);
        io.err(st.dim(`More: pai help ${resolved.path.join(" ")}`));
      } else {
        io.err(st.dim(e.hint ? `More: ${e.hint}` : "More: pai help   (lists every command)"));
      }
      return 2;
    }
    if (e instanceof CliError) {
      io.err(st.red(`pai: ${e.message}`));
      if (e.hint) io.err(`Next: ${st.bold(e.hint)}`);
      return e.exitCode;
    }
    io.err(st.red(`pai: unexpected failure: ${e instanceof Error ? e.message : String(e)}`));
    io.err("Next: re-run with PAI_DEBUG=1 for the stack trace, or report it.");
    if (process.env.PAI_DEBUG && e instanceof Error) io.err(e.stack ?? "");
    return 1;
  }
}

export { renderCommandHelp };
