/** `pai handoff ...`: export a session's work as a portable, redacted brief. */

import { readFileSync } from "node:fs";
import { CliError, type CommandDef, type RunContext } from "../define.js";
import { buildHandoffBrief, resolveTranscript, sessionIdOf, writeHandoff } from "../../session/handoff.js";

function exportCmd(ctx: RunContext): number {
  const cwd = process.cwd();
  const session = ctx.args.SESSION as string | undefined;
  const transcript = resolveTranscript(session, cwd);
  if (!transcript) {
    throw new CliError(
      session ? `no transcript for session ${session} in ${cwd}` : `no session transcripts in ${cwd}`,
      "pai handoff export <SESSION> — or run it inside the project the session worked in"
    );
  }
  const sessionId = sessionIdOf(transcript);
  const path = writeHandoff(buildHandoffBrief(transcript), sessionId);
  console.log(path);
  console.log(`Continue with: claude "Read ${path} and continue. [pai-handoff from=${sessionId}]"`);
  return 0;
}

function showCmd(ctx: RunContext): number {
  const path = ctx.args.PATH as string;
  try {
    process.stdout.write(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`cannot read ${path}`, "pai handoff export first, then pai handoff show <PATH>");
  }
  return 0;
}

export const handoffCommand: CommandDef = {
  name: "handoff",
  summary: "Carry a session's work to a new one",
  description:
    "Exports a session transcript as a short, redacted Markdown brief (requests, files changed, recent commands, where it stopped) and prints the line to continue with. The brief never goes on the command line — only its path does. A `[pai-handoff from=<id>]` marker in the next session's first prompt is recorded in the handoff link log.",
  examples: ["pai handoff export", "pai handoff export 2026-10-22-session-id", "pai handoff show ~/.pai/handoffs/abc-20261022-1430.md"],
  seeAlso: ["pai audit tokens session"],
  subcommands: [
    {
      name: "export",
      summary: "Write the brief for a session (default: newest here)",
      description: "Prints the brief's path and the one-line continue hint. Secrets in the transcript are replaced with [REDACTED]; the brief is bounded to 48 KB.",
      args: [{ name: "SESSION", summary: "Session id or transcript path (default: newest transcript of the current directory)" }],
      examples: ["pai handoff export", "pai handoff export 2026-10-22-session-id"],
      run: exportCmd,
    },
    {
      name: "show",
      summary: "Print a handoff brief",
      description: "Prints a brief written by `pai handoff export`.",
      args: [{ name: "PATH", required: true, summary: "Brief file" }],
      examples: ["pai handoff show ~/.pai/handoffs/abc-20261022-1430.md"],
      run: showCmd,
    },
  ],
};
