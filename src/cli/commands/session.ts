/**
 * Sessions: `pai session list|open|new|rename`, plus the daily shortcuts
 * `pai ls`, `pai open`, `pai new`, `pai rename`.
 */

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { readWorkersSection, type WorkersConfig } from "../../workers/config.js";
import { launchableProviderNames, LaunchError } from "../../workers/launch.js";
import { CliError, OPT, type CommandDef, type RunContext } from "../define.js";
import { renderTable, makeStyle, colorEnabled, type Style } from "../help.js";
import { fetchLiveSessions } from "../lib/aibroker-client.js";
import { dryRunText, buildHarness, execHarness, type Harness } from "../lib/harness.js";
import { probeResume, transcriptModelFor } from "../lib/launch.js";
import { providerHealth, readBudget, type Health } from "../lib/health.js";
import { renameSession } from "../lib/names.js";
import {
  assertAvailable,
  chooseProvider,
  inferOrigin,
  modelFor,
  type Choice,
  type SessionOrigin,
} from "../lib/provider-choice.js";
import {
  fmtAge,
  resolveSessionByNameOrId,
  scanSessions,
  type ScannedSession,
} from "../lib/session-scan.js";
import { legacy } from "../lib/legacy.js";
import { cmdRename } from "./session/commands.js";
import { getProviderOrNative } from "../../workers/config.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function loadWorkers(): WorkersConfig {
  try {
    return readWorkersSection().workers;
  } catch (e) {
    throw new CliError(
      `cannot read the provider configuration: ${e instanceof Error ? e.message : String(e)}`,
      "pai config path   (shows which file is read)"
    );
  }
}

/** Where a session's working directory is: registry-known paths first, as the old resolver did. */
export function sessionDir(s: Pick<ScannedSession, "clcDirectory" | "registryRootPath" | "decodedPath">): string | undefined {
  for (const c of [s.clcDirectory, s.registryRootPath, s.decodedPath]) {
    if (!c) continue;
    try {
      return realpathSync(c);
    } catch {
      /* stale path, try the next */
    }
  }
  return undefined;
}

const projectOf = (s: ScannedSession) => basename(sessionDir(s) ?? s.decodedPath) || s.decodedPath;
const nameOf = (s: ScannedSession) => s.friendlyName ?? s.aiTitle ?? projectOf(s);

export interface SessionRow {
  id: string;
  uuid: string;
  name: string;
  project: string;
  provider: string;
  model: string;
  lastActive: string;
  lastActiveMs: number;
  status: string;
  /** Last thing the user typed, one line. */
  message: string;
  /** Working directory the session opens in, when it still exists. */
  dir?: string;
  /** Can the provider it last ran on be used right now? */
  health: Health;
}

/** Last user text on one line, without the <tag> wrappers Claude Code adds to notifications. */
export function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/<[^>]{1,60}>/g, " ").replace(/\s+/g, " ").trim();
}

function originOf(s: ScannedSession, workers: WorkersConfig | null): SessionOrigin | null {
  const model = transcriptModelFor(s.uuid, s.encodedDir);
  return inferOrigin(model, workers?.providers ?? {});
}

export async function collectRows(opts: { project?: string; all?: boolean; workers?: boolean }): Promise<SessionRow[]> {
  const { rows } = await collectView(opts);
  return rows;
}

export async function collectView(opts: { project?: string; all?: boolean; workers?: boolean; limit?: number }): Promise<{ rows: SessionRow[]; workers: WorkersConfig | null }> {
  let workers: WorkersConfig | null = null;
  try {
    workers = readWorkersSection().workers;
  } catch {
    /* provider column falls back to what the model name says */
  }
  const [scanned, live] = await Promise.all([
    scanSessions({ limit: opts.limit ?? (opts.all ? 1000 : opts.workers ? 25 : 150), filter: opts.all ? "all" : "named", workers: opts.workers }),
    fetchLiveSessions().catch(() => []),
  ]);
  const liveIds = new Set(live.filter((l) => l.kind === "claude").map((l) => l.sessionId));
  const needle = opts.project?.toLowerCase();
  const budget = workers ? await readBudget(workers) : {};
  const rows = scanned
    .filter((s) => !needle || projectOf(s).toLowerCase().includes(needle) || s.decodedPath.toLowerCase().includes(needle))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, opts.limit ?? (opts.all ? 1000 : 25))
    .map((s) => {
      const origin = originOf(s, workers);
      return {
        id: s.shortId,
        uuid: s.uuid,
        name: nameOf(s),
        project: projectOf(s),
        provider: origin?.provider ?? "—",
        model: origin?.model ?? "—",
        lastActive: `${fmtAge(s.mtime)}${fmtAge(s.mtime) === "now" ? "" : " ago"}`,
        lastActiveMs: s.mtime,
        status: liveIds.has(s.uuid) ? "live" : s.sessionStatus,
        message: oneLine(s.lastUserPrompt),
        dir: sessionDir(s),
        health: origin && workers ? providerHealth(origin.provider, workers, budget) : ({ state: "ok", reason: "ok" } as Health),
      };
    });
  return { rows, workers };
}

const statusColor = (st: Style, s: string) =>
  s === "live" || s === "resumable" ? st.green(s) : s === "orphan" ? st.dim(s) : st.yellow(s);

export function rowsTable(rows: SessionRow[], st: Style, numbered = false): string {
  const head = [...(numbered ? ["#"] : []), "ID", "Name", "Project", "Provider", "Model", "Last active", "Status"];
  return renderTable(
    head,
    rows.map((r, i) => [
      ...(numbered ? [st.dim(String(i + 1))] : []),
      st.cyan(r.id),
      r.name.length > 34 ? r.name.slice(0, 33) + "…" : r.name,
      r.project.length > 24 ? r.project.slice(0, 23) + "…" : r.project,
      r.provider,
      r.model,
      r.lastActive,
      statusColor(st, r.status),
    ]),
    st
  );
}

const out = (s: string) => process.stdout.write(s + "\n");
const style = () => makeStyle(colorEnabled());

function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a))));
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const listCommand: CommandDef = {
  name: "list",
  summary: "List sessions, newest first",
  description:
    "Shows your named sessions with the provider and model each last ran on, how long ago it was active, and whether it can be reopened.\n" +
    "Status: live = running now · resumable = can be reopened · stub / transcript-only = partial history · orphan = unnamed (--all).",
  options: [
    { ...OPT.project },
    { name: "all", type: "boolean", default: false, summary: "Include unnamed sessions and show more than the newest 25" },
    { name: "workers", type: "boolean", default: false, summary: "Also show sessions started by background workers (hidden by default)" },
    { ...OPT.json },
  ],
  examples: ["pai ls", "pai ls --project api", "pai ls --all --json", "pai ls --workers"],
  seeAlso: ["pai open", "pai rename", "pai providers"],
  async run(ctx) {
    const rows = await collectRows({ project: ctx.opts.project as string | undefined, all: ctx.opts.all === true, workers: ctx.opts.workers === true });
    if (ctx.opts.json) return void out(JSON.stringify(rows, null, 2));
    const st = style();
    if (rows.length === 0) {
      out("No sessions found" + (ctx.opts.project ? ` for project "${ctx.opts.project}"` : "") + ".");
      out(st.dim("Start one with: pai new"));
      return;
    }
    out(rowsTable(rows, st));
    out("");
    out(st.dim(`${rows.length} session${rows.length === 1 ? "" : "s"} · reopen one with: pai open <name or id>`));
  },
};

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/** Pure planning half of `open`, exported for tests: what provider, why. */
export function planOpen(input: {
  workers: Pick<WorkersConfig, "providers" | "active" | "nativeModels">;
  origin: SessionOrigin | null;
  flagProvider?: string;
  flagModel?: string;
  name: string;
}): Choice {
  const { workers, origin, flagProvider, flagModel, name } = input;
  const choice = chooseProvider({ flagProvider, flagModel, origin, active: workers.active });
  assertAvailable(choice.provider, launchableProviderNames(workers), (alt) => `pai open "${name}" --provider ${alt}`);
  return choice;
}

const openCommand: CommandDef = {
  name: "open",
  summary: "Reopen a session (on its own provider unless --provider is given)",
  description:
    "Continues a session with its full history. The provider is chosen in this order, and nothing else is consulted:\n" +
    "  1. --provider, if you give it (always wins; if it is unavailable the command fails and lists the ones that are)\n" +
    "  2. the provider the session last ran on\n" +
    "  3. the active provider (pai providers)\n" +
    "Without NAME_OR_ID you pick from a numbered list.",
  args: [{ name: "NAME_OR_ID", summary: "Session name, or the id from `pai ls` (a prefix is enough)" }],
  options: [
    { ...OPT.provider, summary: "Open on this provider, whatever the session used before" },
    { ...OPT.model },
    { ...OPT.dryRun },
  ],
  examples: ["pai open", "pai open my-session", "pai open 3a9f1c2e --provider kimi", "pai open my-session --dry-run"],
  seeAlso: ["pai ls", "pai new", "pai providers"],
  async run(ctx: RunContext) {
    const st = style();
    const workers = loadWorkers();
    const sessions = await scanSessions({ limit: 500, filter: "named" });
    let query = ctx.args.NAME_OR_ID as string | undefined;
    if (!query) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CliError("no session given and no terminal to pick from", "pai ls   then   pai open <name or id>");
      }
      const rows = (await collectRows({})).slice(0, 15);
      if (rows.length === 0) throw new CliError("there are no sessions to open", "pai new");
      out(rowsTable(rows, st, true));
      const a = (await ask("\nOpen which? number, name or id: ")).trim();
      if (!a) throw new CliError("nothing picked", "pai open <name or id>");
      query = /^\d+$/.test(a) ? rows[Number(a) - 1]?.uuid : a;
      if (!query) throw new CliError(`"${a}" is not a number from the list`, "pai ls");
    }

    let session: ScannedSession;
    let name: string | undefined;
    try {
      ({ session, friendlyName: name } = resolveSessionByNameOrId(sessions, query));
    } catch (e) {
      throw new CliError(String(e instanceof Error ? e.message : e).split("\n\n")[0], "pai ls   (shows names and ids)");
    }
    name = name ?? nameOf(session);
    const cwd = sessionDir(session);
    if (!cwd) {
      throw new CliError(
        `the folder of session "${name}" no longer exists (${session.decodedPath})`,
        `cd <an existing folder> && pai new --name "${name}"`
      );
    }

    const origin = originOf(session, workers);
    const choice = planOpen({
      workers,
      origin,
      flagProvider: ctx.opts.provider as string | undefined,
      flagModel: ctx.opts.model as string | undefined,
      name,
    });
    const provider = getProviderOrNative(workers, choice.provider)!;
    const model = ctx.opts.model ? (ctx.opts.model as string) : modelFor(provider, choice.model);

    const probe = probeResume(session.uuid, cwd);
    if (!probe.ok) {
      throw new CliError(
        `session "${name}" has no history that can be continued (${probe.reason ?? "unknown reason"})`,
        `cd ${JSON.stringify(cwd)} && pai new --name ${JSON.stringify(name)} --provider ${choice.provider}`
      );
    }

    let harness: Harness;
    try {
      harness = await buildHarness(workers, { provider: choice.provider, model, cwd, resume: session.uuid, name });
    } catch (e) {
      if (e instanceof LaunchError || (e as Error).name === "WorkersConfigError") {
        throw new CliError(
          (e as Error).message,
          `pai open "${name}" --provider ${launchableProviderNames(workers).find((n) => n !== choice.provider) ?? "anthropic"}`
        );
      }
      throw e;
    }

    out(`Opening "${name}" on ${st.bold(harness.provider)} (${harness.model})`);
    if (origin && origin.provider !== harness.provider) {
      out(
        st.yellow(
          `Note: this session last ran on ${origin.provider} (${origin.model}). It continues with its history on ${harness.provider}; ` +
            `if ${harness.provider} rejects that history, start fresh: cd ${JSON.stringify(cwd)} && pai new --name ${JSON.stringify(name)} --provider ${harness.provider}`
        )
      );
    }
    if (ctx.dryRun) return void out(dryRunText(harness));
    return execHarness(harness, workers);
  },
};

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

const newCommand: CommandDef = {
  name: "new",
  summary: "Start a fresh session in this folder",
  description:
    "Starts Claude Code in the current folder on the chosen provider. Without --provider it uses the active provider (see `pai providers`).",
  options: [
    { ...OPT.provider, summary: "Provider to start on (default: the active provider)" },
    { ...OPT.model },
    { name: "name", type: "string", value: "NAME", summary: "Session name (default: the folder name)" },
    { ...OPT.dryRun },
  ],
  examples: ["pai new", "pai new --provider glm", "pai new --provider kimi --model k3 --name spike", "pai new --dry-run"],
  seeAlso: ["pai open", "pai providers"],
  async run(ctx) {
    const st = style();
    const workers = loadWorkers();
    const cwd = process.cwd();
    const name = (ctx.opts.name as string | undefined) ?? (basename(cwd) || "session");
    const choice = chooseProvider({
      flagProvider: ctx.opts.provider as string | undefined,
      flagModel: ctx.opts.model as string | undefined,
      origin: null,
      active: workers.active,
    });
    assertAvailable(choice.provider, launchableProviderNames(workers), (alt) => `pai new --provider ${alt}`);
    let harness: Harness;
    try {
      harness = await buildHarness(workers, { provider: choice.provider, model: choice.model, cwd, name });
    } catch (e) {
      if (e instanceof LaunchError || (e as Error).name === "WorkersConfigError") {
        throw new CliError((e as Error).message, "pai providers   (lists what is available)");
      }
      throw e;
    }
    out(`Starting "${name}" on ${st.bold(harness.provider)} (${harness.model})`);
    if (ctx.dryRun) return void out(dryRunText(harness));
    return execHarness(harness, workers);
  },
};

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

const renameCommand: CommandDef = {
  name: "rename",
  summary: "Give a session a new name",
  description: "Changes the name `pai ls` shows and `pai open` accepts. The history is untouched.",
  args: [
    { name: "ID", required: true, summary: "Session id from `pai ls` (a prefix is enough) or its current name" },
    { name: "NAME", required: true, summary: "The new name" },
    { name: "NEW_SLUG", summary: "Only for the old note form `session rename PROJECT NUMBER NEW_SLUG`: renames a session note instead" },
  ],
  options: [],
  examples: ["pai rename 3a9f1c2e api-spike", 'pai rename old-name "new name"', "pai session rename my-project 12 fix-login-bug"],
  seeAlso: ["pai ls", "pai open"],
  async run(ctx) {
    if (ctx.args.NEW_SLUG !== undefined) {
      return legacy(() => cmdRename(ctx.args.ID as string, ctx.args.NAME as string, ctx.args.NEW_SLUG as string));
    }
    const sessions = await scanSessions({ limit: 500, filter: "all" });
    let session: ScannedSession;
    try {
      ({ session } = resolveSessionByNameOrId(sessions, ctx.args.ID as string));
    } catch (e) {
      throw new CliError(String(e instanceof Error ? e.message : e).split("\n\n")[0], "pai ls   (shows names and ids)");
    }
    const name = (ctx.args.NAME as string).trim();
    if (!name) throw new CliError("the new name is empty", 'pai rename <id> "<new name>"');
    if (ctx.dryRun) return void out(`would rename ${session.shortId} to "${name}"`);
    const { previous } = renameSession(session.uuid, name, sessionDir(session));
    out(`Renamed ${session.shortId}${previous ? ` "${previous}"` : ""} → "${name}"`);
  },
};

// ---------------------------------------------------------------------------
// Exports: the group and its daily shortcuts
// ---------------------------------------------------------------------------

export const sessionCommand: CommandDef = {
  name: "session",
  summary: "Work with sessions: list, open, new, rename",
  description: "Everything about sessions lives under `pai session`; the daily verbs also exist as short top-level commands.",
  examples: ["pai session list", "pai session open my-session", "pai session new --provider glm"],
  seeAlso: ["pai ls", "pai open", "pai new"],
  subcommands: [listCommand, openCommand, newCommand, renameCommand],
};

export const lsCommand: CommandDef = { ...listCommand, name: "ls", aliasOf: "session list", daily: true };
export const openTop: CommandDef = { ...openCommand, aliasOf: "session open" };
export const newTop: CommandDef = { ...newCommand, aliasOf: "session new" };
export const renameTop: CommandDef = { ...renameCommand, aliasOf: "session rename" };
