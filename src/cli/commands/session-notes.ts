/**
 * Session notes and checkpoints: `pai session info|tag|route|handover|checkpoint|autosave|active|recent|goto|pause|auto-route|cleanup|restore|slug`
 * and the plural `pai sessions ...` group. The logic lives in ./session/ and ./session-cleanup/;
 * this file declares the commands. Names, flags and output are the old ones (hooks and prompts call them).
 */

import { OPT, type CommandDef, type OptDef, type RunContext } from "../define.js";
import { cmdActive, cmdAutoRoute, cmdInfo, cmdRename, cmdRoute, cmdSlug, cmdTag } from "./session/commands.js";
import { cmdAutosave } from "./session/autosave.js";
import { cmdCheckpoint } from "./session/checkpoint.js";
import { cmdClearNames } from "./session/clear-names.js";
import { cmdEnd } from "./session/end.js";
import { cmdGoto } from "./session/goto.js";
import { cmdHandover } from "./session/handover.js";
import { cmdPause } from "./session/pause.js";
import { cmdPauseAll } from "./session/pause-all.js";
import { cmdRecent } from "./session/recent.js";
import { cmdRestore } from "./session/restore.js";
import { runCleanup } from "./session-cleanup/cleanup.js";
import { legacy } from "../lib/legacy.js";
import { lsCommand } from "./session.js";

const str = (v: unknown): string | undefined => (v === undefined ? undefined : String(v));

const SESSION_ID: OptDef = {
  name: "session-id",
  type: "string",
  value: "UUID",
  summary: "Claude Code session id; recorded as the handle for `claude --resume`",
};
const BODY_FILE: OptDef = {
  name: "body-file",
  type: "string",
  value: "FILE",
  summary: "File holding the checkpoint text to save ('-' reads standard input). Required unless --no-body",
};
const NO_BODY: OptDef = { name: "no-body", type: "boolean", default: false, summary: "Save a checkpoint with metadata only, no text" };
const JSON_RAW: OptDef = { ...OPT.json, summary: "Print raw JSON instead of a table" };
const COUNT: OptDef = { name: "n", short: "n", type: "number", value: "COUNT", default: 20, summary: "Most sessions to show" };
const ALL_ORPHANS: OptDef = { name: "all", type: "boolean", default: false, summary: "Also show unnamed sessions" };

const slugArgs = [
  { name: "PROJECT", required: true, summary: "Project slug, as shown by `pai project list`" },
  { name: "NUMBER", required: true, summary: "Session note number (or `latest`)" },
];

const pauseOpts = (c: RunContext) => ({
  dryRun: c.dryRun,
  bodyFile: c.opts["body-file"] as string | undefined,
  sessionId: c.opts["session-id"] as string | undefined,
  noBody: c.opts["no-body"] === true,
});

export const infoCmd: CommandDef = {
  name: "info",
  summary: "Show everything known about one session note",
  description: "Prints title, date, status, tags, file and linked sessions of one session note.",
  args: slugArgs,
  examples: ["pai session info my-project 12", "pai session info my-project latest"],
  seeAlso: ["pai session tag", "pai session list"],
  run: (c) => legacy(() => cmdInfo(c.args.PROJECT as string, c.args.NUMBER as string)),
};

const renameNoteCmd: CommandDef = {
  name: "rename",
  summary: "Rename a session note (file, title and registry)",
  description: "Gives a session note a new slug: the file on disk, its first heading and the registry entry all change.",
  args: [...slugArgs, { name: "NEW_SLUG", required: true, summary: "New short name for the note" }],
  examples: ["pai sessions rename my-project 12 fix-login-bug", "pai sessions rename my-project 3 release-notes"],
  seeAlso: ["pai session slug"],
  run: (c) => legacy(() => cmdRename(c.args.PROJECT as string, c.args.NUMBER as string, c.args.NEW_SLUG as string)),
};
export { renameNoteCmd };

export const slugCmd: CommandDef = {
  name: "slug",
  summary: "Suggest a short name for a session note from its transcript",
  description: "Reads the conversation and proposes a descriptive slug. With --apply the note is renamed to it.",
  args: slugArgs,
  options: [{ name: "apply", type: "boolean", default: false, summary: "Rename the note to the suggested slug" }],
  examples: ["pai session slug my-project 12", "pai session slug my-project latest --apply"],
  seeAlso: ["pai sessions rename"],
  run: (c) => legacy(() => cmdSlug(c.args.PROJECT as string, c.args.NUMBER as string, { apply: c.opts.apply === true })),
};

export const tagCmd: CommandDef = {
  name: "tag",
  summary: "Show or set the tags of a session note",
  description: "Without tags, prints the current ones. Tags can be separated by spaces or commas.",
  args: [...slugArgs, { name: "TAGS", variadic: true, summary: "Tags to set" }],
  examples: ["pai session tag my-project 12", "pai session tag my-project 12 bugfix,urgent"],
  seeAlso: ["pai session info"],
  run: (c) => legacy(() => cmdTag(c.args.PROJECT as string, c.args.NUMBER as string, (c.args.TAGS as string[]) ?? [])),
};

export const routeCmd: CommandDef = {
  name: "route",
  summary: "Link a session note to another project",
  description: "Adds a cross-reference from the note to a target project, so it shows up there too.",
  args: [...slugArgs, { name: "TARGET", required: true, summary: "Slug of the project to link to" }],
  options: [{ name: "type", type: "string", value: "KIND", default: "related", summary: "Kind of link: related, follow-up or reference" }],
  examples: ["pai session route my-project 12 other-project", "pai session route my-project 12 other-project --type follow-up"],
  seeAlso: ["pai session auto-route"],
  run: (c) =>
    legacy(() => cmdRoute(c.args.PROJECT as string, c.args.NUMBER as string, c.args.TARGET as string, { type: c.opts.type as string })),
};

export const handoverCmd: CommandDef = {
  name: "handover",
  summary: "Write the \"Continue\" block of a project's TODO.md",
  description:
    "Records the last session, the time and the working directory in the project's TODO.md so the next session can pick up where this one stopped.\n" +
    "The stop and pre-compact hooks run it for you. Pass --session-id whenever it is known: it decides whether an existing checkpoint belongs to this session and must be kept.",
  args: [
    { name: "PROJECT", summary: "Project slug (default: the project of the current directory)" },
    { name: "NUMBER", summary: "Session note number or `latest` (default: latest)" },
  ],
  options: [SESSION_ID],
  examples: ["pai session handover", "pai session handover my-project latest --session-id 3a9f1c2e-0000-4000-8000-000000000000"],
  seeAlso: ["pai pause", "pai session autosave"],
  run: (c) =>
    legacy(() => cmdHandover(c.args.PROJECT as string | undefined, c.args.NUMBER as string | undefined, c.opts["session-id"] as string | undefined)),
};

export const checkpointCmd: CommandDef = {
  name: "checkpoint",
  summary: "Add a timestamped line to the active session note",
  description: "Meant for hooks: quick and silent. It does nothing if the last checkpoint is newer than --min-gap seconds.",
  args: [{ name: "MESSAGE", required: true, summary: "Text to record" }],
  options: [{ name: "min-gap", type: "number", value: "SECONDS", default: 300, summary: "Least seconds between two checkpoints" }],
  examples: ['pai session checkpoint "finished the parser"', 'pai session checkpoint "tests green" --min-gap 60'],
  seeAlso: ["pai session handover"],
  run: (c) => legacy(() => cmdCheckpoint(c.args.MESSAGE as string, { minGap: str(c.opts["min-gap"]) })),
};

export const autosaveCmd: CommandDef = {
  name: "autosave",
  summary: "Refresh the \"Continue\" block from the transcript (for hooks)",
  description:
    "Runs unattended from live hooks so an interrupted session still leaves a usable handover. A checkpoint written by the session itself is never overwritten. Silent, and always exits 0.\n" +
    "With --dry-run it prints the block it would write.",
  options: [
    SESSION_ID,
    { name: "min-gap", type: "number", value: "SECONDS", default: 240, summary: "Least seconds between two autosaves, across all triggers" },
  ],
  examples: ["pai session autosave --dry-run", "pai session autosave --session-id 3a9f1c2e-0000-4000-8000-000000000000 --min-gap 120"],
  seeAlso: ["pai session handover", "pai pause"],
  run: (c) =>
    legacy(() =>
      cmdAutosave({ sessionId: c.opts["session-id"] as string | undefined, minGap: str(c.opts["min-gap"]), dryRun: c.dryRun })
    ),
};

export const activeCmd: CommandDef = {
  name: "active",
  summary: "Sessions that were active in the last hour",
  description: "Finds running sessions by looking at which transcripts changed recently.",
  options: [{ name: "minutes", type: "number", value: "N", default: 60, summary: "Count a session as active if it changed within N minutes" }, JSON_RAW],
  examples: ["pai session active", "pai session active --minutes 15 --json"],
  seeAlso: ["pai ls"],
  run: (c) => legacy(() => cmdActive({ minutes: str(c.opts.minutes), json: c.opts.json === true })),
};

export const recentCmd: CommandDef = {
  name: "recent",
  summary: "Named sessions with their resume status, live ones first",
  description:
    "The classic session catalog. Status: resumable = can be reopened · stub / transcript-only = partial history · orphan = unnamed (--all).\n" +
    "`pai ls` is the friendlier table.",
  options: [COUNT, ALL_ORPHANS, { name: "all-tabs", type: "boolean", default: false, summary: "Show every terminal tab under Live Sessions, including plain shells" }, JSON_RAW],
  examples: ["pai session recent", "pai session recent -n 5 --json"],
  seeAlso: ["pai ls", "pai session active"],
  run: (c) => legacy(() => cmdRecent({ n: str(c.opts.n), all: c.opts.all === true, allTabs: c.opts["all-tabs"] === true, json: c.opts.json === true })),
};

export const gotoCmd: CommandDef = {
  name: "goto",
  summary: "Open a session by name or id (same as `pai open`)",
  description: "Resumes the session when it can be resumed, otherwise starts a fresh one in the same directory.",
  args: [{ name: "NAME_OR_ID", required: true, summary: "Session name or the first characters of its id" }],
  options: [
    { name: "skip-name", type: "boolean", default: false, summary: "Do not send /Name to label the tab" },
    { name: "skip-go", type: "boolean", default: false, summary: "Ignored, kept for old scripts" },
  ],
  examples: ["pai session goto my-session --dry-run", "pai session goto 3a9f1c2e"],
  seeAlso: ["pai open", "pai resume"],
  run: (c) =>
    legacy(async () => {
      process.stderr.write("Note: `pai session goto` works but `pai open` is the shorter form.\n");
      await cmdGoto(c.args.NAME_OR_ID as string, { noName: c.opts["skip-name"] === true, noGo: c.opts["skip-go"] === true, dryRun: c.dryRun });
    }),
};

export const pauseCmd: CommandDef = {
  name: "pause",
  summary: "Save a checkpoint before leaving (same as `pai pause`)",
  description:
    "Writes the \"Continue\" block of the project's TODO.md. Leave with /exit inside Claude Code; Ctrl+C skips the stop hook and the session can no longer be resumed.",
  options: [BODY_FILE, SESSION_ID, NO_BODY],
  examples: ["pai session pause --dry-run --no-body", "pai session pause --body-file notes.md"],
  seeAlso: ["pai pause", "pai end"],
  run: (c) =>
    legacy(async () => {
      process.stderr.write("Note: `pai session pause` works but `pai pause` is the shorter form.\n");
      await cmdPause(pauseOpts(c));
    }),
};

export const autoRouteCmd: CommandDef = {
  name: "auto-route",
  summary: "Find out which project the current directory belongs to",
  description: "Tries the registered project paths, then a Notes/PAI.md marker above the directory, then topic detection from --context.",
  options: [
    { name: "cwd", type: "string", value: "DIR", summary: "Directory to check (default: the current one)" },
    { name: "context", type: "string", value: "TEXT", summary: "Conversation text for the topic-based fallback" },
    JSON_RAW,
  ],
  examples: ["pai session auto-route", "pai session auto-route --cwd . --json"],
  seeAlso: ["pai session route"],
  run: (c) =>
    legacy(() => cmdAutoRoute({ cwd: c.opts.cwd as string | undefined, context: c.opts.context as string | undefined, json: c.opts.json === true })),
};

export const cleanupCmd: CommandDef = {
  name: "cleanup",
  summary: "Tidy session notes: drop empty ones, name, file and renumber",
  description:
    "Deletes empty notes, names unnamed ones, moves them into year/month folders and renumbers. Shows the plan only; nothing changes without --execute.",
  args: [{ name: "PROJECT", summary: "Only this project slug (default: all projects)" }],
  options: [
    { name: "execute", type: "boolean", default: false, summary: "Really do it (the default is a preview)" },
    { name: "no-renumber", type: "boolean", default: false, summary: "Keep the old numbers after deleting" },
    { name: "no-reindex", type: "boolean", default: false, summary: "Do not refresh the memory index afterwards" },
  ],
  examples: ["pai session cleanup", "pai session cleanup my-project --execute"],
  seeAlso: ["pai session restore"],
  run: (c) =>
    legacy(() =>
      runCleanup(c.args.PROJECT as string | undefined, {
        execute: c.opts.execute === true,
        renumber: c.opts["no-renumber"] !== true,
        reindex: c.opts["no-reindex"] !== true,
      })
    ),
};

export const restoreCmd: CommandDef = {
  name: "restore",
  summary: "Make displaced transcripts resumable again",
  description:
    "An old archiver moved transcripts out of the folder `claude --resume` reads. This lists what cannot be resumed and which checkpoints promise it. It only previews until --execute is given.",
  options: [
    { name: "execute", type: "boolean", default: false, summary: "Really restore (links the files back)" },
    { name: "promised", type: "boolean", default: false, summary: "Only sessions a checkpoint tells you to resume" },
    { name: "cwd", type: "string", value: "DIR", summary: "Only sessions of this working directory" },
    { name: "all", type: "boolean", default: false, summary: "List every displaced session, not just the largest" },
    { name: "include-stubs", type: "boolean", default: false, summary: "Also restore transcripts without any conversation" },
    JSON_RAW,
  ],
  examples: ["pai session restore", "pai session restore --promised --execute"],
  seeAlso: ["pai session cleanup"],
  run: (c) =>
    legacy(() =>
      cmdRestore({
        execute: c.opts.execute === true,
        promised: c.opts.promised === true,
        cwd: c.opts.cwd as string | undefined,
        all: c.opts.all === true,
        includeStubs: c.opts["include-stubs"] === true,
        json: c.opts.json === true,
      })
    ),
};

/** Subcommands added to `pai session` (list/open/new/rename are the foundation's). */
export const SESSION_NOTE_COMMANDS: CommandDef[] = [
  infoCmd, slugCmd, tagCmd, routeCmd, handoverCmd, checkpointCmd, autosaveCmd, activeCmd,
  recentCmd, gotoCmd, pauseCmd, autoRouteCmd, cleanupCmd, restoreCmd,
];

// ---------------------------------------------------------------------------
// pai sessions (plural)
// ---------------------------------------------------------------------------

const sessionsList: CommandDef = {
  name: "list",
  summary: "Named sessions with their resume status",
  description: "Same as `pai session recent`.",
  options: [COUNT, ALL_ORPHANS, { name: "all-tabs", type: "boolean", default: false, summary: "Show every terminal tab under Live Sessions, including plain shells" }, JSON_RAW],
  examples: ["pai sessions list", "pai sessions list -n 5 --json"],
  seeAlso: ["pai ls"],
  run: recentCmd.run,
};

const sessionsPause: CommandDef = {
  name: "pause",
  summary: "Save a checkpoint for the current session",
  description: "Same as `pai pause`.",
  options: [{ name: "dry-run", type: "boolean", summary: "Preview the block without writing it" }, BODY_FILE, SESSION_ID, NO_BODY],
  examples: ["pai sessions pause --dry-run --no-body", "pai sessions pause --body-file notes.md"],
  seeAlso: ["pai pause"],
  run: (c) => legacy(() => cmdPause(pauseOpts(c))),
};

export const sessionsPauseAll: CommandDef = {
  name: "pause-all",
  summary: "Pause every live session (needs AIBroker)",
  description: "Sends 'pause session' to each live terminal pane. Same as `pai pause all`.",
  options: [
    { name: "exit", type: "boolean", default: false, summary: "Also send /exit to each session after it has saved" },
    { name: "wait", type: "number", value: "MS", default: 5000, summary: "Milliseconds to wait before /exit" },
    { name: "only", type: "string", value: "NAME", summary: "Only sessions whose name or id contains NAME" },
  ],
  examples: ["pai sessions pause-all --dry-run", "pai sessions pause-all --only api --exit"],
  seeAlso: ["pai pause"],
  run: (c) =>
    legacy(() => cmdPauseAll({ exit: c.opts.exit === true, dryRun: c.dryRun, only: c.opts.only as string | undefined, wait: c.opts.wait as number | undefined })),
};

const sessionsEnd: CommandDef = {
  name: "end",
  summary: "Finish the current session",
  description: "Same as `pai end`.",
  options: [BODY_FILE, SESSION_ID, NO_BODY],
  examples: ["pai sessions end --dry-run --no-body", "pai sessions end --body-file notes.md"],
  seeAlso: ["pai end"],
  run: (c) => legacy(() => cmdEnd(pauseOpts(c))),
};

export const clearNamesCmd: CommandDef = {
  name: "clear-names",
  summary: "Wipe the stored tab names (recovery)",
  description:
    "Clears the AIBroker name store and the pai name from every live iTerm2 tab. Use it when tab names are corrupt; afterwards re-label each tab with /Name.",
  examples: ["pai clear-names --dry-run", "pai clear-names"],
  seeAlso: ["pai sessions pause-all"],
  run: (c) => legacy(() => cmdClearNames({ dryRun: c.dryRun })),
};

const sessionsGoto: CommandDef = {
  ...gotoCmd,
  options: [],
  examples: ["pai sessions goto my-session --dry-run", "pai sessions goto 3a9f1c2e"],
  run: (c) => legacy(() => cmdGoto(c.args.NAME_OR_ID as string, { dryRun: c.dryRun })),
};

const sessionsHandover: CommandDef = {
  ...handoverCmd,
  args: [
    { name: "PROJECT", summary: "Project slug (default: the project of the current directory)" },
    { name: "SESSION_ID", summary: "Session id or note number" },
  ],
  options: [],
  examples: ["pai sessions handover", "pai sessions handover my-project latest"],
  run: (c) => legacy(() => cmdHandover(c.args.PROJECT as string | undefined, c.args.SESSION_ID as string | undefined)),
};

export const sessionsCommand: CommandDef = {
  name: "sessions",
  summary: "Old plural session commands (use `ls` and `session`)",
  description:
    "Everything `pai session` does, under the plural name. Bare `pai sessions` lists sessions like `pai ls`.",
  options: lsCommand.options,
  examples: ["pai sessions", "pai sessions list", "pai sessions active"],
  seeAlso: ["pai ls", "pai session"],
  subcommands: [
    sessionsList, sessionsGoto, sessionsPause, sessionsPauseAll, sessionsEnd,
    { ...infoCmd }, { ...renameNoteCmd }, { ...slugCmd }, { ...tagCmd }, { ...routeCmd },
    sessionsHandover, { ...checkpointCmd }, { ...activeCmd }, clearNamesCmd, { ...autoRouteCmd },
  ],
  run: lsCommand.run,
};
