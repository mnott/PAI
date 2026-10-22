/** `pai git ...`: link commits to the session/worker that wrote them (git notes, ref pai). */

import { join } from "node:path";
import { historyDir } from "../../hooks/ts/lib/pai-paths.js";
import { GitNotesError, postCommitHook, removeGitNotes, setupGitNotes, showNote } from "../../session/git-notes.js";
import { CliError, type CommandDef } from "../define.js";

const repoOrFail = (): string => process.cwd();

export const gitCommand: CommandDef = {
  name: "git",
  summary: "Link commits to the session that wrote them",
  description: "Installs a post-commit hook that records the session and worker that edited a commit's files as a git note (ref pai).",
  examples: ["pai git setup", "pai git notes", "pai git remove"],
  seeAlso: ["pai worker ps"],
  subcommands: [
    {
      name: "setup",
      summary: "Install the post-commit hook in the current repository",
      description: "Writes .git/hooks/post-commit, keeping an existing hook as post-commit.pre-pai and calling it first, and sets notes.rewriteRef so notes follow amends and rebases.",
      examples: ["pai git setup"],
      run: () => {
        try {
          const r = setupGitNotes(repoOrFail());
          process.stdout.write(`Installed ${r.hook}${r.chained ? " (existing hook chained)" : ""}\n`);
          return 0;
        } catch (e) {
          if (e instanceof GitNotesError) throw new CliError(e.message, "Fix it and re-run pai git setup");
          throw new CliError("Not a git repository", "Run it inside a repository");
        }
      },
    },
    {
      name: "remove",
      summary: "Remove the hook and restore the previous one",
      description: "Deletes the PAI post-commit hook, puts a chained hook back and unsets notes.rewriteRef.",
      examples: ["pai git remove"],
      run: () => {
        process.stdout.write(removeGitNotes(repoOrFail()) ? "Removed the PAI post-commit hook\n" : "No PAI hook installed\n");
        return 0;
      },
    },
    {
      name: "notes",
      summary: "Show the PAI note of a commit",
      description: "Prints the session and worker recorded for a commit (default HEAD), or 'no PAI note'.",
      args: [{ name: "REV", summary: "Commit to show (default HEAD)" }],
      examples: ["pai git notes", "pai git notes HEAD~1"],
      run: (ctx) => {
        process.stdout.write((showNote(repoOrFail(), ctx.args.REV as string | undefined) ?? "no PAI note") + "\n");
        return 0;
      },
    },
    {
      name: "hook",
      summary: "Git hook entry points (called by git)",
      description: "Internal: `pai git hook post-commit` is what the installed hook runs. Always exits 0.",
      examples: ["pai git hook post-commit"],
      hidden: true,
      subcommands: [
        {
          name: "post-commit",
          summary: "Record the sessions that edited the last commit's files",
          description: "Skips during rebase and cherry-pick; looks back 6 hours in the raw captures. Always exits 0.",
          examples: ["pai git hook post-commit"],
          run: () => {
            postCommitHook(process.cwd(), join(historyDir(), "raw-outputs"));
            return 0;
          },
        },
      ],
    },
  ],
};
