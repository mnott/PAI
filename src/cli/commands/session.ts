/**
 * Sessions: `pai session list|open|new|rename`, plus the daily shortcuts
 * `pai ls`, `pai open`, `pai new`, `pai rename`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { ANTHROPIC_NATIVE, readWorkersSection, WorkersConfigError, type WorkersConfig, nativeOrchestratorModel } from "../../workers/config.js";
import { launchableProviderNames, LaunchError } from "../../workers/launch.js";
import { CliError, OPT, type CommandDef, type RunContext } from "../define.js";
import { renderTable, makeStyle, colorEnabled, type Style } from "../help.js";
import { fetchLiveSessions } from "../lib/aibroker-client.js";
import { dryRunText, buildHarness, execHarness, type Harness } from "../lib/harness.js";
import { encodedProjectDir, probeResume, transcriptModelFor, transcriptResumeContext } from "../lib/launch.js";
import { providerHealth, readBudget, readBudgetSnapshot, saveBudgetSnapshot, type Health } from "../lib/health.js";
import type { BudgetReading } from "../../workers/budget.js";
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
import { getProfile, SESSION_NAME_ENV } from "../../workers/session-profile-store.js";
import { resolveLocalProvider } from "../../workers/local-provider.js";
import { httpModelsCheck, type PortCheck } from "../lib/setups.js";

/** The real port probe of `--local` (the cached daemon answer is never trusted for "none"). */
const probeLocal: PortCheck = httpModelsCheck;
import { addSessionSchedulingHeaders, buildRunEnv, pinnedSettings } from "../../workers/run-env.js";
import { SESSION_CODE_GRAPH_LINE } from "../../workers/report.js";
import { resolveSessionMcp, sessionSlimArgs, SESSION_MCP_SERVERS } from "../../workers/slim-profile.js";
import { readMcpServers } from "../../workers/mcp.js";
import { localCompactWindow, MIN_COMPACT_WINDOW } from "../../workers/run-env.js";
import { effectiveMainConfig } from "../../config/shipped-defaults.js";
import { paiConfigFilePath } from "../../daemon/config.js";
import { claudeProjectsDir } from "../../config/pai-home.js";
import { claudeJsonPath } from "../../config/claude-json.js";
import { workersLogDir } from "../../workers/paths.js";
import { prepareDir } from "../lib/new-dir.js";
import { legacy } from "../lib/legacy.js";
import { resolveSessionFolder, type FolderResolution } from "../lib/folder-resolve.js";
import type { TtyIn, TtyOut } from "../lib/picker.js";
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

/**
 * Resolve a session's folder, moving it when the stored path is gone: the
 * registry's moved-project detection, a tolerant segment match against the
 * real directory entries, then the Claude project-dir encoding. A unique
 * match rebinds the registry and returns the new folder; several matches are
 * returned as candidates; none keeps the caller's old error.
 */
async function resolveFolder(s: Pick<ScannedSession, "clcDirectory" | "registryRootPath" | "decodedPath" | "encodedDir">): Promise<FolderResolution> {
  return resolveSessionFolder([s.clcDirectory, s.registryRootPath, s.decodedPath], s.encodedDir);
}

/**
 * The folder a session opens in, resolving a stale one first: a unique match
 * rebinds the registry and prints one "folder moved" line; several matches
 * get picked; none keeps the caller's old error, naming the deepest existing
 * ancestor. Exported for `pai open` and the picker's `openRow`.
 */
export async function openableDir(
  name: string,
  stored: Pick<ScannedSession, "clcDirectory" | "registryRootPath" | "decodedPath" | "encodedDir">,
  knownDir: string | undefined,
  term: { isTTY: boolean; st: Style; input: TtyIn; output: TtyOut },
  out: (s: string) => void
): Promise<string> {
  if (knownDir) return knownDir;
  const r = await resolveFolder(stored);
  if (r.dir) {
    if (r.rebound) out(term.st.yellow(`folder moved: ${stored.decodedPath} -> ${r.dir}`));
    return r.dir;
  }
  if (r.candidates && r.candidates.length > 1) {
    if (!term.isTTY) {
      const listed = r.candidates.map((c) => `\n  ${c}`).join("");
      throw new CliError(
        `the folder of "${name}" no longer exists; several folders match (${listed})`,
        `pai project rebind <slug> <one of the listed folders>`
      );
    }
    const { runPicker } = await import("../lib/picker.js");
    const picked = await runPicker(
      {
        title: "Several folders match — pick one",
        headers: ["Folder"],
        items: r.candidates,
        cells: (c) => [c],
        searchText: (c) => c,
        footer: "Enter picks, Esc quits",
      },
      term.st,
      term.input,
      term.output
    );
    if (!picked) throw new CliError(`nothing picked — the folder of "${name}" no longer exists`, `cd <an existing folder> && pai new --name ${JSON.stringify(name)}`);
    return picked;
  }
  throw new CliError(
    `the folder of "${name}" no longer exists (${r.ancestor} is the deepest folder that still exists)`,
    `cd <an existing folder> && pai new --name ${JSON.stringify(name)}`
  );
}

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
  /** The paths the session record carries, for resolving a folder that moved. */
  stored: { clcDirectory?: string; registryRootPath?: string; decodedPath: string; encodedDir: string };
  /** Can the provider it last ran on be used right now? */
  health: Health;
  /** The session already carries this name (set with /Name), so starting it must not send /Name. */
  named: boolean;
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
  const { rows } = await collectView({ ...opts, fast: true, waitMs: LISTING_WAIT_MS });
  return rows;
}

/** How long a printed listing waits for live status and usage before showing what it has. */
const LISTING_WAIT_MS = 400;

export interface SessionView {
  rows: SessionRow[];
  workers: WorkersConfig | null;
  /**
   * Fast views only: fetch what the first paint skipped (live sessions, fresh
   * budget readings) and return the rows rebuilt with it. Resolves to the
   * same rows when there is nothing to add.
   */
  refresh(): Promise<SessionRow[]>;
}

export async function collectView(opts: {
  project?: string;
  all?: boolean;
  workers?: boolean;
  limit?: number;
  offline?: boolean;
  /** Build rows from the disk-cached budget and no live lookup; `refresh` fills those in. */
  fast?: boolean;
  /** With `fast`: wait this long for the refresh before returning the first-paint rows (listings that print once). */
  waitMs?: number;
  /** Beyond the newest `limit`, keep every session the operator named, so a filter finds it whatever its age. */
  includeNamed?: boolean;
}): Promise<SessionView> {
  let workers: WorkersConfig | null = null;
  try {
    workers = readWorkersSection().workers;
  } catch {
    /* provider column falls back to what the model name says */
  }
  const limit = opts.limit ?? (opts.all ? 1000 : 25);
  const scanLimit = opts.includeNamed ? 100000 : opts.limit ?? (opts.all ? 1000 : opts.workers ? 25 : 150);
  const deferred = opts.fast && !opts.offline;
  const [scanned, live0] = await Promise.all([
    scanSessions({ limit: scanLimit, filter: opts.all ? "all" : "named", workers: opts.workers }),
    opts.offline || deferred ? Promise.resolve([]) : fetchLiveSessions().catch(() => []),
  ]);
  const needle = opts.project?.toLowerCase();
  const picked = scanned
    .filter((s) => !needle || projectOf(s).toLowerCase().includes(needle) || s.decodedPath.toLowerCase().includes(needle))
    .sort((a, b) => b.mtime - a.mtime)
    .filter((s, i) => i < limit || (opts.includeNamed && !!s.persistentName));

  const build = async (live: Awaited<ReturnType<typeof fetchLiveSessions>>, budget: Record<string, BudgetReading | undefined>): Promise<SessionRow[]> => {
    const liveIds = new Set(live.filter((l) => l.kind === "claude").map((l) => l.sessionId));
    // one resolution per session: a stale folder is relocated before the row
    // shows its project name, so the list names the folder that exists
    const resolutions = await Promise.all(picked.map((s) => resolveFolder(s)));
    return picked.map((s, i) => {
      const origin = originOf(s, workers);
      const dir = resolutions[i]?.dir ?? sessionDir(s);
      const project = dir ? basename(dir) || dir : projectOf(s);
      return {
        id: s.shortId,
        uuid: s.uuid,
        name: s.friendlyName ?? s.aiTitle ?? project,
        project,
        provider: origin?.provider ?? "—",
        model: origin?.model ?? "—",
        lastActive: `${fmtAge(s.mtime)}${fmtAge(s.mtime) === "now" ? "" : " ago"}`,
        lastActiveMs: s.mtime,
        status: liveIds.has(s.uuid) ? "live" : s.sessionStatus,
        message: oneLine(s.lastUserPrompt),
        dir,
        stored: {
          clcDirectory: s.clcDirectory,
          registryRootPath: s.registryRootPath,
          decodedPath: s.decodedPath,
          encodedDir: s.encodedDir,
        },
        named: !!s.persistentName && s.persistentName === (s.friendlyName ?? s.aiTitle ?? project),
        health: origin && workers ? providerHealth(origin.provider, workers, budget) : ({ state: "ok", reason: "ok" } as Health),
      };
    });
  };

  const budget0 = deferred ? readBudgetSnapshot() : workers && !opts.offline ? await readBudget(workers) : {};
  const rows = await build(live0, budget0);
  const refresh = async (): Promise<SessionRow[]> => {
    if (!deferred) return rows;
    const [live, budget] = await Promise.all([
      fetchLiveSessions().catch(() => []),
      workers ? readBudget(workers) : Promise.resolve({}),
    ]);
    if (Object.keys(budget).length) saveBudgetSnapshot(budget);
    return build(live, Object.keys(budget).length ? budget : budget0);
  };
  if (deferred && opts.waitMs) {
    const settled = await Promise.race([
      refresh().catch(() => null),
      new Promise<null>((res) => setTimeout(() => res(null), opts.waitMs).unref()),
    ]);
    if (settled) return { rows: settled, workers, refresh: async () => settled };
  }
  return { rows, workers, refresh };
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
    const cwd = await openableDir(
      name,
      session,
      sessionDir(session),
      { isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true, st, input: process.stdin, output: process.stdout },
      out
    );

    const origin = originOf(session, workers);
    const choice = planOpen({
      workers,
      origin,
      flagProvider: ctx.opts.provider as string | undefined,
      flagModel: ctx.opts.model as string | undefined,
      name,
    });
    if (!ctx.opts.provider && !ctx.opts.model) applyProfileChat(choice, name, workers);
    const provider = getProviderOrNative(workers, choice.provider)!;
    const model = ctx.opts.model ? (ctx.opts.model as string) : chatModel(provider, choice.model);

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
          `pai open "${name}" --provider ${launchableProviderNames(workers).find((n) => n !== choice.provider) ?? ANTHROPIC_NATIVE}`
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

/** The session's profile chat model replaces the default choice when no flag named one (and its provider is configured). */
export function applyProfileChat(choice: { provider: string; model?: string }, name: string, workers: WorkersConfig): void {
  const chat = getProfile(name)?.chat;
  if (!chat || !getProviderOrNative(workers, chat.provider)) return;
  choice.provider = chat.provider;
  choice.model = chat.model;
}

/** A profile's model alias ("opus") passes through on the native login; otherwise the provider's own table decides. */
function chatModel(provider: Parameters<typeof modelFor>[0] & { native?: boolean }, wanted: string | undefined): string | undefined {
  return provider.native && wanted === nativeOrchestratorModel() ? wanted : modelFor(provider, wanted);
}

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

/** Start a session in DIR on the active provider (no --with): the old `pai new`, now for any folder. */
async function startNewIn(o: { dir?: string; name?: string; provider?: string; model?: string; dryRun: boolean }): Promise<number> {
  const st = style();
  const workers = loadWorkers();
  const cwd = await prepareDir(o.dir, { dryRun: o.dryRun, out });
  const name = o.name ?? (basename(cwd) || "session");
  const choice = chooseProvider({ flagProvider: o.provider, flagModel: o.model, origin: null, active: workers.active });
  if (!o.provider && !o.model) applyProfileChat(choice, name, workers);
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
  if (o.dryRun) {
    out(dryRunText(harness));
    return 0;
  }
  return execHarness(harness, workers);
}

export const runNewDefault = (o: { dir?: string; dryRun: boolean }) => startNewIn(o);

const newCommand: CommandDef = {
  name: "new",
  summary: "Start a new session in a new or existing folder",
  description:
    "Creates DIR when it is missing (default: the current folder), registers it as a project and starts Claude Code there. " +
    "With --with the setup decides who orchestrates and which provider the workers run on, and nothing is asked. " +
    "Without it the session runs on the active provider (see `pai providers`; --provider overrides). " +
    "`pai ./dir` or `pai ~/dir` does the same as `pai new`.",
  args: [{ name: "DIR", summary: "Folder to start in; created if missing (default: the current folder)" }],
  options: [
    { name: "with", type: "string", value: "SETUP", summary: 'Start with this setup, no questions (see: pai setups), e.g. "anthropic + flashnext-iq3 workers"' },
    { ...OPT.provider, summary: "Provider to start on (default: the active provider)" },
    { ...OPT.model },
    { name: "name", type: "string", value: "NAME", summary: "Session name (default: the folder name)" },
    { ...OPT.dryRun },
  ],
  examples: [
    'pai new ~/code/app --with "anthropic + flashnext-iq3 workers"',
    'pai new ~/code/app --with "anthropic only" --name app',
    "pai new",
    "pai new --provider glm",
    "pai new ~/code/spike --provider kimi --model k3 --dry-run",
  ],
  seeAlso: ["pai setups", "pai open", "pai providers"],
  async run(ctx) {
    const dir = ctx.args.DIR as string | undefined;
    const name = ctx.opts.name as string | undefined;
    const withSetup = ctx.opts.with as string | undefined;
    if (withSetup) {
      const { runNewWith } = await import("./root.js");
      return runNewWith({ dir, with: withSetup, name, dryRun: ctx.dryRun });
    }
    return startNewIn({ dir, name, provider: ctx.opts.provider as string | undefined, model: ctx.opts.model as string | undefined, dryRun: ctx.dryRun });
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
// profile
// ---------------------------------------------------------------------------

/**
 * `pai session profile [show|set --workers <provider>|clear --workers]` — the CLI
 * side of the per-session model profile, the same implementation the MCP tools
 * use (daemon-mcp/tools/session-profile.ts), so it works when the MCP server is
 * down. A workers pin set here is explicit; a launch-written one is implicit and
 * never routes (session-profile.ts).
 */
const profileCommand: CommandDef = {
  name: "profile",
  summary: "Show or change this session's model profile (chat, workers)",
  description:
    "`pai session profile` shows the profile and where the next worker spawn runs. " +
    "`set escalate on|off [--until HH:MM]` switches the stall rule that moves this session's workers to the cloud (default on; off holds until the time). `set --workers <provider> [--model <m>]` pins where this session's workers run (an explicit choice; beats global routing). " +
    "`clear --workers` removes the pin so spawns follow global routing again. " +
    "`repair` clears the workers pin launches wrote implicitly (the setup's provider stored as a standing pin), but only for this folder's named session; other sessions are listed and left alone. " +
    "`--name` takes another session; default: this session. Same store and resolver as the MCP session_profile tools.",
  args: [
    { name: "VERB", summary: "show (default), set, clear or repair" },
    { name: "SETTING", summary: "With set: escalate" },
    { name: "VALUE", summary: "With set escalate: on or off" },
  ],
  options: [
    { name: "workers", type: "string", value: "PROVIDER", optionalValue: true, summary: "With set: the worker provider (with --model: default, fast or a model id); with clear: bare --workers clears the pin" },
    { ...OPT.model, summary: "Worker model for --workers: default, fast or a model id" },
    { name: "name", type: "string", value: "SESSION", summary: "Session name (default: this session)" },
    { name: "until", type: "string", value: "HH:MM", summary: "With set escalate off: local time (next occurrence) when the switch expires by itself" },
  ],
  examples: [
    "pai session profile",
    "pai session profile set --name job-search escalate off --until 07:00",
    "pai session profile set --workers kimi --model fast",
    "pai session profile clear --workers",
    "pai session profile show --name job-search",
    "pai session profile repair",
  ],
  seeAlso: ["pai worker route", "pai setups"],
  async run(ctx) {
    const verb = (ctx.args.VERB as string | undefined) ?? "show";
    const name = ctx.opts.name as string | undefined;
    const { sessionProfileText, sessionProfileSet, realSessionProfileDeps } = await import("../../daemon-mcp/tools/session-profile.js");
    const deps = await realSessionProfileDeps();
    if (verb === "show") {
      out(await sessionProfileText({ name }, deps));
      return;
    }
    const workers = typeof ctx.opts.workers === "string" ? ctx.opts.workers : undefined;
    if (verb === "set" && ctx.args.SETTING === "escalate") {
      const value = ctx.args.VALUE as string | undefined;
      if (value !== "on" && value !== "off") throw new CliError("escalate takes on or off", "pai session profile set escalate off --until 07:00");
      const until = ctx.opts.until as string | undefined;
      const r = await sessionProfileSet({ name, escalate: value, ...(until ? { until } : {}) }, deps);
      if (r.isError) throw new CliError(r.content[0].text, "pai session profile");
      return void out(r.content[0].text);
    }
    if (verb === "set") {
      if (!workers) throw new CliError("set needs --workers <provider>", "pai session profile set --workers kimi --model fast");
      const model = ctx.opts.model as string | undefined;
      const r = await sessionProfileSet({ name, workers: { provider: workers, ...(model ? { model } : {}) } }, deps);
      if (r.isError) throw new CliError(r.content[0].text, "pai session profile");
      return void out(r.content[0].text);
    }
    if (verb === "clear") {
      // `--workers` alone (no value) reads as true: that is the clear form
      if (workers !== "workers" && ctx.opts.workers !== true) throw new CliError("clear needs --workers", "pai session profile clear --workers");
      const r = await sessionProfileSet({ name, workers: null }, deps);
      if (r.isError) throw new CliError(r.content[0].text, "pai session profile");
      return void out(r.content[0].text);
    }
    if (verb === "repair") {
      const { repairSessionProfile, repairReport } = await import("../../workers/profile-implicit-pin.js");
      const { readProfiles } = await import("../../workers/session-profile-store.js");
      const cleared = await repairSessionProfile(process.cwd(), name, deps.path);
      return void out(repairReport(cleared, readProfiles(deps.path)));
    }
    throw new CliError(`unknown verb "${verb}" (expected show, set, clear or repair)`, "pai session profile");
  },
};

// ---------------------------------------------------------------------------
// local
// ---------------------------------------------------------------------------

/**
 * `pai session --local` — an interactive main session that talks only to the
 * running local model, through the PAI router: work continues when the cloud
 * subscription is exhausted. The route, the compact window and the timeouts are
 * exactly what a local worker gets (buildRunEnv); on top of it the session
 * variant of the slim profile keeps the guard hooks, drops the heavy context
 * injectors and limits MCP to aibroker + pai, so the main context fits the
 * local window. The requests carry x-pai-interactive=1 (+ a high hint), which
 * makes the router's scheduler serve them before queued worker requests on the
 * same engine — never preempting one in flight. --print-cmd shows the env and
 * the command instead of starting claude (for tests and for the operator).
 */

/** The plan behind `pai session --local`: everything the exec needs, resolved. Pure enough to test. */
export interface LocalSessionPlan {
  providerName: string;
  /** How the running local model was picked (resolveLocalProvider's why). */
  why: string;
  model: string;
  env: NodeJS.ProcessEnv;
  argv: string[];
  /** The files the slim session profile wrote (shown by --print-cmd). */
  settingsFile?: string;
  mcpFile?: string;
  /** MCP servers loaded, and those of them deferred behind tool search. */
  mcpLoaded: string[];
  mcpDeferred: string[];
  /** Estimated tool-definition tokens in the first request. */
  mcpStartupTokens: number;
  contextTokens: number;
  /** The conversation this launch continues (undefined when it starts fresh). */
  resumeUuid?: string;
  /** What that conversation was about, for --print-cmd ("last active … · last: …"). */
  resumeContext?: string;
}

/** "128k" / "256k" / "200000" -> tokens; below Claude Code's 100k minimum is refused. */
export function parseContextTokens(v: string | number): number {
  const m = /^(\d+(?:\.\d+)?)\s*(k)?$/i.exec(String(v).trim());
  const n = m ? Math.round(Number(m[1]) * (m[2] ? 1024 : 1)) : NaN;
  if (!Number.isFinite(n)) throw new CliError(`--context needs a number or 128k/256k, got "${v}"`, "pai local --context 256k");
  if (n < MIN_COMPACT_WINDOW) {
    throw new CliError(`--context ${v} is below ${MIN_COMPACT_WINDOW}: Claude Code treats anything lower as the 100k minimum`, "pai local --context 128k");
  }
  return n;
}

/** The session section of the main config: context cap and default MCP set. */
export function readSessionLocalConfig(path: string = paiConfigFilePath()): { contextTokens: number; mcp: string[] | "all" | "lean" } {
  let sec: Record<string, unknown> = {};
  try {
    sec = ((effectiveMainConfig(path).session ?? {}) as Record<string, unknown>) ?? {};
  } catch {
    /* unreadable config: shipped defaults below */
  }
  const t = sec.localContextTokens;
  const contextTokens = typeof t === "number" && Number.isFinite(t) ? Math.max(MIN_COMPACT_WINDOW, Math.round(t)) : 262144;
  return { contextTokens, mcp: parseMcpSpec(sec.localMcp) };
}

/** "all" | "lean" | "a,b,c" | ["a","b"] -> the canonical form; unset = all. */
export function parseMcpSpec(v: unknown): string[] | "all" | "lean" {
  if (Array.isArray(v)) {
    const l = v.map(String).map((x) => x.trim()).filter(Boolean);
    return l.length === 1 && (l[0] === "all" || l[0] === "lean") ? (l[0] as "all" | "lean") : l.length ? l : "all";
  }
  if (typeof v !== "string" || !v.trim()) return "all";
  return parseMcpSpec(v.split(","));
}

/** Rough start-up cost: ~350 tokens per always-loaded tool (assume ~20 per server), ~40 per deferred server for the tool-search listing. */
export function estimateMcpTokens(always: number, deferred: number): number {
  return always * 20 * 350 + deferred * 40;
}

/**
 * The conversation `pai local` continues: the most recent transcript of this
 * folder that claude could resume. Reads the folder's own transcript dir —
 * top level plus the `sessions/` subdir PAI's stop hook archives into — and
 * takes the newest by mtime. scanSessions could sort this too, but it freezes
 * CLAUDE_PROJECTS_DIR at module load, which no test (or CLAUDE_CONFIG_DIR
 * change) could move; this reads the env at call time like every other path.
 * Undefined when the folder never had a conversation (the caller starts fresh,
 * honestly).
 */
export function latestFolderSession(cwd: string): ScannedSession | undefined {
  const dir = join(claudeProjectsDir(), encodedProjectDir(cwd));
  const found = new Map<string, number>();
  const add = (d: string) => {
    let files: string[];
    try {
      files = readdirSync(d);
    } catch {
      return; // no dir for this folder — it never held a session
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const uuid = f.slice(0, -6);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) continue;
      let m = 0;
      try {
        m = statSync(join(d, f)).mtimeMs;
      } catch {
        continue;
      }
      found.set(uuid, Math.max(found.get(uuid) ?? 0, m));
    }
  };
  add(dir);
  // a cleanly stopped session lives ONLY under sessions/ until probeResume's
  // restoreTopLevel links it back — which resolveLocalResume does before answering
  add(join(dir, "sessions"));
  let best: ScannedSession | undefined;
  for (const [uuid, mtime] of found) {
    if (!best || mtime > best.mtime) {
      best = { uuid, shortId: uuid.slice(0, 8), encodedDir: basename(dir), decodedPath: cwd, topLevelPath: join(dir, `${uuid}.jsonl`), topLevelSystemLines: 0, topLevelSize: 0, resumable: true, sessionStatus: "resumable", userLines: 0, lastUserPrompt: "", msgCount: 0, mtime } as ScannedSession;
    }
  }
  return best;
}

/**
 * The resume decision of a local launch, shared by the plan and --print-cmd so
 * neither can drift: an explicit uuid (`pai NAME --local`) wins; `--new` starts
 * fresh; otherwise continue this folder's most recent conversation — exactly
 * what plain `pai NAME` continues, on the local engine. A candidate whose
 * transcript turns out unresumable degrades to fresh rather than erroring: a
 * local session must still start.
 */
export async function resolveLocalResume(o: {
  cwd: string;
  resumeUuid?: string;
  forceFresh?: boolean;
  probe?: (uuid: string, cwd: string) => { ok: boolean };
}): Promise<string | undefined> {
  if (o.resumeUuid) return o.resumeUuid;
  if (o.forceFresh) return undefined;
  const candidate = latestFolderSession(o.cwd);
  if (!candidate) return undefined;
  const probe = (o.probe ?? probeResume)(candidate.uuid, o.cwd);
  return probe.ok ? candidate.uuid : undefined;
}

/** Resolve provider+model and build the env/argv; throws NoLocalServerError when nothing local runs. */
export async function planLocalSession(o: {
  workers: WorkersConfig;
  logDir: string;
  /** `--local <name>`: a specific running local model. */
  name?: string;
  /** `--model <id>`: overrides the provider's default model. */
  model?: string;
  /** Extra claude args after `--`. */
  rest?: string[];
  sessionName?: string;
  /** Port-probe seam (tests inject; default httpModelsCheck, as every --local path uses). */
  check?: import("../../cli/lib/setups.js").PortCheck;
  /** Router-route seam (tests inject; default the real loopback router URL). */
  route?: () => string;
  /** ~/.claude.json seam (tests inject; default the real one). */
  claudeJson?: string;
  /** MCP set: "all" (default), "lean" (aibroker+pai) or a server list. */
  mcp?: string[] | "all" | "lean";
  /** Autocompact window in tokens (default session.localContextTokens). */
  contextTokens?: number;
  /** Skip --dangerously-skip-permissions (default: the session skips permission prompts). */
  askPermissions?: boolean;
  /** The folder to continue (default process.cwd()). */
  cwd?: string;
  /** `--new`: start a fresh conversation instead of continuing this folder's last. */
  forceFresh?: boolean;
  /** The conversation to continue, named by the caller (`pai NAME --local`). */
  resumeUuid?: string;
  /** Resume-resolution seam (tests inject; default the real folder scan + probe). */
  resume?: () => Promise<string | undefined>;
}): Promise<LocalSessionPlan> {
  const res = await resolveLocalProvider(o.workers, o.logDir, { ...(o.name !== undefined ? { name: o.name } : {}), ...(o.check ? { check: o.check } : {}) });
  const provider = getProviderOrNative(o.workers, res.name)!;
  if (o.model && !Object.values(provider.models).includes(o.model)) {
    throw new CliError(
      `model "${o.model}" is not configured for local provider "${res.name}". Configured: ${Object.values(provider.models).join(", ")}`,
      "pai session --local   (the running model's default)"
    );
  }
  const model = o.model ?? provider.models.default;
  // the exact env a local worker runs with, interactive edition: router route,
  // tier model pins, compact window (workers.localContextTokens), local
  // timeouts — and never an ANTHROPIC_API_KEY (nativeLaunchEnv strips it)
  const env = buildRunEnv(provider, false, undefined, res.name, true);
  if (o.route) {
    // the route seam replaces only the URL; the header line buildRunEnv keyed
    // the scheduling headers to is re-set first so they still attach
    const url = o.route();
    env.ANTHROPIC_BASE_URL = url;
    env.ANTHROPIC_CUSTOM_HEADERS = `x-pai-provider: ${res.name}`;
  }
  delete env.PAI_WORKER;
  delete env.PAI_WORKER_ID;
  delete env.PAI_POOL_SLOT;
  addSessionSchedulingHeaders(env, o.sessionName);
  // --settings travels as a file (a token never rides in argv); print-cmd shows the file it wrote
  const contextTokens = Math.max(MIN_COMPACT_WINDOW, o.contextTokens ?? readSessionLocalConfig().contextTokens);
  const window = localCompactWindow(provider, contextTokens) ?? contextTokens;
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(window);
  // tool definitions are deferred behind tool search; only aibroker + pai stay always-loaded
  env.ENABLE_TOOL_SEARCH = "true";
  const spec = o.mcp ?? "all";
  const mcpOpt = spec === "lean" ? SESSION_MCP_SERVERS : spec;
  const claudeJson = o.claudeJson ?? claudeJsonPath();
  const load = resolveSessionMcp(claudeJson, { mcp: mcpOpt });
  if (Array.isArray(spec)) {
    const unknown = spec.filter((n) => !(n in readMcpServers(claudeJson)));
    if (unknown.length) throw new CliError(`unknown MCP server(s): ${unknown.join(", ")}. Available: ${Object.keys(readMcpServers(claudeJson)).join(", ")}`, "pai local --mcp lean");
  }
  // --settings travels as a file (a token never rides in argv); print-cmd shows the file it wrote
  const args = sessionSlimArgs(o.logDir, "session-local", env, pinnedSettings(env, true), undefined, claudeJson, provider, { mcp: mcpOpt, compactCap: contextTokens });
  // continue this folder's last conversation unless --new or rest already carries a resume/continue
  const cwd = o.cwd ?? process.cwd();
  const wantsResume = (o.rest ?? []).some((a) => a === "--resume" || a === "--continue");
  const resumeUuid = wantsResume || o.forceFresh
    ? undefined
    : await (o.resume ?? (() => resolveLocalResume({ cwd, resumeUuid: o.resumeUuid })))();
  const argv = [
    "claude",
    "--model",
    model,
    ...args,
    "--append-system-prompt",
    SESSION_CODE_GRAPH_LINE,
    ...(o.askPermissions ? [] : ["--dangerously-skip-permissions"]),
    ...(resumeUuid ? ["--resume", resumeUuid] : []),
    ...(o.rest ?? []),
  ];
  const settingsIdx = args.indexOf("--settings");
  const mcpIdx = args.indexOf("--mcp-config");
  return {
    providerName: res.name,
    why: res.why,
    model,
    env,
    argv,
    ...(settingsIdx >= 0 ? { settingsFile: args[settingsIdx + 1] } : {}),
    ...(mcpIdx >= 0 ? { mcpFile: args[mcpIdx + 1] } : {}),
    mcpLoaded: load.loaded,
    mcpDeferred: load.deferred,
    mcpStartupTokens: estimateMcpTokens(load.loaded.length - load.deferred.length, load.deferred.length),
    contextTokens: window,
    ...(resumeUuid
      ? {
          resumeUuid,
          resumeContext: transcriptResumeContext(join(claudeProjectsDir(), encodedProjectDir(cwd), `${resumeUuid}.jsonl`)) ?? undefined,
        }
      : {}),
  };
}

/** The --print-cmd text: env lines the launcher would set, then the exec line. */
export function localSessionPrintText(p: LocalSessionPlan): string {
  const env = p.env;
  const lines = [
    `local model: ${p.providerName} (${p.why}) · model ${p.model}`,
    `ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}`,
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "(unset)"}`,
    `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY ?? "(not set)"}`,
    `ANTHROPIC_CUSTOM_HEADERS=${(env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n").join(" | ")}`,
  ];
  if (p.settingsFile) {
    try {
      const s = JSON.parse(readFileSync(p.settingsFile, "utf8")) as { mcpServers?: Record<string, unknown> };
      lines.push(`mcpServers=${Object.keys(s.mcpServers ?? {}).join(", ")}`);
      const always = p.mcpLoaded.filter((n) => !p.mcpDeferred.includes(n));
      lines.push(`mcp loaded (always): ${always.join(", ") || "(none)"}`);
      lines.push(`mcp deferred (tool search): ${p.mcpDeferred.join(", ") || "(none)"}`);
      lines.push(`ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH ?? "(unset)"}`);
      lines.push(`estimated start-up tool-definition tokens: ~${p.mcpStartupTokens}`);
    } catch {
      /* unreadable settings file: the line above already named it */
    }
  }
  // the user setting source is loaded (skills/commands/agents resolve); what
  // must stay out is neutralised by --settings (guard hooks only) and
  // --strict-mcp-config. The dirs shown are the ones that exist.
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const found = (d: string) => { try { return readdirSync(join(home, d)).length > 0; } catch { return false; } };
  const dirs = (["skills", "commands", "agents"] as const).filter(found);
  lines.push(`user skills/commands/agents: ${dirs.length ? dirs.join(", ") : "(none found)"} from ${home}`);
  lines.push(
    p.resumeUuid
      ? `continues ${p.resumeUuid}${p.resumeContext ? ` (${p.resumeContext})` : ""} — this folder's last conversation (--new starts fresh)`
      : "fresh conversation (no previous one to continue, or --new)"
  );
  lines.push(p.argv.map((a) => (/[\s"'$`\\{}]/.test(a) ? JSON.stringify(a) : a)).join(" "));
  return lines.join("\n");
}

const LOCAL_FLAGS = [
  { ...OPT.model, summary: "Model id on the local provider (default: its default model)" },
  { name: "mcp", type: "string" as const, value: "LIST", summary: "MCP servers to load: a,b,c | lean (aibroker+pai) | all (default, config session.localMcp); all but aibroker and pai are deferred behind tool search" },
  { name: "context", type: "string" as const, value: "N", summary: "Context cap (autocompact window): a number, 128k or 256k (default config session.localContextTokens, 262144; minimum 100000)" },
  { name: "new", type: "boolean" as const, default: false, summary: "Start a fresh conversation (default: continue this folder's last conversation)" },
  { name: "ask-permissions", type: "boolean" as const, default: false, summary: "Keep claude's permission prompts (default: --dangerously-skip-permissions)" },
  { name: "print-cmd", type: "boolean" as const, default: false, summary: "Print the env, loaded/deferred MCP servers and command instead of starting claude" },
];

/** Resolve the local-session flags against the session config. */
function localFlagValues(opts: Record<string, unknown>): { mcp: string[] | "all" | "lean"; contextTokens: number; askPermissions: boolean } {
  const cfg = readSessionLocalConfig();
  return {
    mcp: typeof opts.mcp === "string" ? parseMcpSpec(opts.mcp) : cfg.mcp,
    contextTokens: opts.context !== undefined && opts.context !== true ? parseContextTokens(opts.context as string | number) : cfg.contextTokens,
    askPermissions: opts["ask-permissions"] === true,
  };
}

/** Plan and (unless --print-cmd) start a local session; `resumeUuid`/`sessionName`/`cwd` carry `pai NAME --local`. */
export async function runLocalSession(o: {
  opts: Record<string, unknown>;
  rest?: string[];
  name?: string;
  sessionName?: string;
  resumeUuid?: string;
  cwd?: string;
}): Promise<number> {
  const workers = loadWorkers();
  const logDir = workersLogDir(workers);
  const cwd = o.cwd ?? process.cwd();
  const sessionName = o.sessionName ?? ((process.env[SESSION_NAME_ENV] ?? basename(cwd)) || undefined);
  const named = o.sessionName ? ["--name", o.sessionName] : [];
  // the conversation to continue: `pai NAME --local` names one; otherwise the
  // folder's last one, unless --new. planLocalSession probes it and puts
  // --resume in argv, where --print-cmd shows it too.
  const forceFresh = o.opts.new === true;
  if (forceFresh && o.resumeUuid) {
    throw new CliError(`--new cannot be combined with ${o.sessionName ?? "this session"} — the named session is the one to continue`, "pai local --new   (a fresh conversation in this folder)");
  }
  let plan: LocalSessionPlan;
  try {
    plan = await planLocalSession({
      workers,
      logDir,
      name: o.name,
      model: o.opts.model as string | undefined,
      rest: [...named, ...(o.rest ?? [])],
      sessionName,
      check: probeLocal,
      cwd,
      resumeUuid: o.resumeUuid,
      forceFresh,
      ...localFlagValues(o.opts),
    });
  } catch (e) {
    if (e instanceof WorkersConfigError) throw new CliError(e.message, "pai worker local   (shows the running local models)");
    throw e;
  }
  if (o.sessionName) plan.env[SESSION_NAME_ENV] = o.sessionName;
  if (o.opts["print-cmd"]) {
    out(localSessionPrintText(plan));
    return 0;
  }
  const r = spawnSync("claude", plan.argv.slice(1), { stdio: "inherit", env: plan.env, cwd });
  if (r.error) throw new CliError(`could not start claude: ${r.error.message}`, "pai local --print-cmd   (shows the command)");
  return r.status ?? 0;
}

const LOCAL_DESCRIPTION =
  "Opens Claude Code in the current folder talking only to the local model, so work continues when the cloud subscription is exhausted. " +
  "The route goes through the PAI router; requests carry x-pai-interactive=1 and are served before queued worker requests on the same engine (never preempting one in flight). " +
  "The session runs a slim profile: guard hooks kept, heavy context injectors off. It loads your whole MCP server set (--mcp lean = aibroker + pai only) with tool definitions deferred behind tool search, so they do not fill the context; only aibroker and pai stay always-loaded. " +
  "The autocompact window is session.localContextTokens (default 262144, --context to override; never below 100000). Permission prompts are off (--dangerously-skip-permissions) unless --ask-permissions. " +
  "--local <name> picks a specific running local model; --model overrides its default; everything after `--` goes to claude verbatim. No ANTHROPIC_API_KEY is ever passed.";

const localCommand: CommandDef = {
  name: "local",
  summary: "Start an interactive session on the running local model (through the router)",
  description: LOCAL_DESCRIPTION,
  options: [
    { name: "local", type: "string", value: "NAME", optionalValue: true, summary: "A specific running local model (default: the one --local resolves)" },
    ...LOCAL_FLAGS,
  ],
  examples: ["pai session --local", "pai session --local --model qwen3-coder", "pai session --local --mcp lean --context 128k", "pai session --local --print-cmd", "pai session --local -- --continue"],
  seeAlso: ["pai worker local", "pai router", "pai launch"],
  passthrough: true,
  run: (ctx) => runLocalSession({ opts: ctx.opts, rest: ctx.rest, name: typeof ctx.opts.local === "string" ? ctx.opts.local : undefined }),
};

/** `pai local [NAME] [flags] [-- args]` = `pai session --local`. */
export const localTop: CommandDef = {
  name: "local",
  summary: "Start a session on the running local model (= pai session --local)",
  description: LOCAL_DESCRIPTION,
  args: [{ name: "NAME", summary: "A specific running local model (default: the one that resolves)" }],
  options: LOCAL_FLAGS,
  examples: ["pai local", "pai local --mcp lean --context 128k", "pai local --print-cmd", "pai local -- --continue"],
  seeAlso: ["pai session --local", "pai worker local", "pai NAME --local"],
  aliasOf: "session --local",
  daily: true,
  passthrough: true,
  run: (ctx) => runLocalSession({ opts: ctx.opts, rest: ctx.rest, name: ctx.args.NAME as string | undefined }),
};

// ---------------------------------------------------------------------------
// Exports: the group and its daily shortcuts
// ---------------------------------------------------------------------------

export const sessionCommand: CommandDef = {
  name: "session",
  summary: "Work with sessions: list, open, new, rename, profile, local",
  description:
    "Everything about sessions lives under `pai session`; the daily verbs also exist as short top-level commands. " +
    "`pai session --local` starts a lean interactive session on the running local model (see pai session local).",
  examples: ["pai session list", "pai session open my-session", "pai session new --provider glm", "pai session profile", "pai session --local"],
  seeAlso: ["pai ls", "pai open", "pai new"],
  // the group accepts --local's own flags and forwards them: `pai session --local --print-cmd`
  // reads as `pai session local --print-cmd`, and --local <name> keeps its value form
  options: [
    { name: "local", type: "string", optionalValue: true, summary: "Start a lean interactive session on the running local model (same as `pai session local`; an optional name picks one running model)" },
    ...LOCAL_FLAGS.map((f) => ({ ...f, summary: `With --local: ${f.summary}` })),
  ],
  passthrough: true,
  async run(ctx) {
    if (ctx.opts.local === true || typeof ctx.opts.local === "string") return localCommand.run!(ctx);
    throw new CliError("nothing given — pai session takes a subcommand", "pai session --local   or   pai help session");
  },
  subcommands: [listCommand, openCommand, newCommand, renameCommand, profileCommand, localCommand],
};

export const lsCommand: CommandDef = { ...listCommand, name: "ls", aliasOf: "session list", daily: true };
export const openTop: CommandDef = { ...openCommand, aliasOf: "session open" };
export const newTop: CommandDef = { ...newCommand, aliasOf: "session new", daily: true };
export const renameTop: CommandDef = { ...renameCommand, aliasOf: "session rename" };
