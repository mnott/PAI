/** `pai help` and `pai doc`. */

import { writeFileSync } from "node:fs";
import { CliError, OPT, type CommandDef } from "../define.js";
import { colorEnabled, makeStyle, renderCommandHelp, renderMarkdown, renderMore, renderOverview, suggest } from "../help.js";
import { GROUPS } from "../registry.js";
import { rootCommand } from "./root.js";
import { cliVersion, resolve } from "../run.js";
import { UsageError } from "../parse.js";
import { renderPages, writePages } from "../docgen.js";

export const helpCommand: CommandDef = {
  name: "help",
  summary: "Explain a command (same as `pai <command> --help`)",
  description: "Without arguments shows the overview. `pai help more` lists every command that is not a daily one.",
  args: [{ name: "COMMAND", variadic: true, summary: "Command and optional subcommand, e.g. `session open`" }],
  examples: ["pai help", "pai help open", "pai help providers use", "pai help more"],
  seeAlso: ["pai doc"],
  run(ctx) {
    const st = makeStyle(colorEnabled());
    const words = (ctx.args.COMMAND as string[]) ?? [];
    if (words.length === 0) return void process.stdout.write(renderOverview(GROUPS, rootCommand, cliVersion(), st) + "\n");
    if (words[0] === "more") return void process.stdout.write(renderMore(GROUPS, st) + "\n");
    const r = resolve(GROUPS, words);
    if (r.rest.length) {
      const near = suggest(r.rest[0], r.cmd.subcommands?.map((s) => s.name) ?? []);
      throw new UsageError(`no command "${[...r.path, r.rest[0]].join(" ")}"${near ? ` — did you mean "${[...r.path, near].join(" ")}"?` : ""}`);
    }
    process.stdout.write(renderCommandHelp(r.path, r.cmd, st));
  },
};

export const docCommand: CommandDef = {
  name: "doc",
  summary: "Write the Markdown command reference",
  description:
    "Regenerates the reference from the same definitions `pai help` reads, so the docs cannot drift from the commands. Prints to stdout unless --out is given.",
  options: [
    { name: "out", type: "string", value: "FILE", summary: "Write to this file instead of stdout" },
    { name: "dir", type: "string", value: "DIR", summary: "Write one page per command plus README.md into this folder (used by the docs build)" },
    { name: "examples", type: "string", value: "DIR", summary: "With --dir: splice hand-written <command>.md examples from this folder" },
    { ...OPT.dryRun, summary: "Show where it would write, write nothing" },
  ],
  examples: ["pai doc", "pai doc --out docs/cli.md", "pai doc --dir docs/commands --examples docs/commands/_examples"],
  seeAlso: ["pai help"],
  run(ctx) {
    const dir = ctx.opts.dir as string | undefined;
    if (dir) {
      const pages = renderPages(GROUPS, ctx.opts.examples as string | undefined);
      if (ctx.dryRun) return void process.stdout.write(`would write ${pages.length} pages to ${dir}\n`);
      try {
        writePages(dir, pages);
      } catch (e) {
        throw new CliError(`cannot write ${dir}: ${(e as Error).message}`, "pai doc --dir <writable folder>");
      }
      return void process.stdout.write(`Wrote ${pages.length} pages to ${dir}\n`);
    }
    const md = renderMarkdown(GROUPS, cliVersion());
    const file = ctx.opts.out as string | undefined;
    if (!file) return void process.stdout.write(md + "\n");
    if (ctx.dryRun) return void process.stdout.write(`would write ${md.length} bytes to ${file}\n`);
    try {
      writeFileSync(file, md + "\n");
    } catch (e) {
      throw new CliError(`cannot write ${file}: ${(e as Error).message}`, "pai doc --out <writable file>");
    }
    process.stdout.write(`Wrote ${file}\n`);
  },
};
