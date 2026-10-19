/**
 * The daily path: `pai` (picker), `pai NAME` (launch screen), `pai --with SETUP`.
 * Everything here is a small function over an injected terminal, so the
 * screens are testable with a fake TTY.
 */

import { basename } from "node:path";
import { isLoopbackProvider } from "../../workers/run-env.js";
import { cooldownRemaining, type RoutingState } from "../../workers/routing.js";
import { SESSION_WORKER_PROVIDER_ENV } from "../../workers/session-provider.js";
import { SESSION_NAME_ENV, getProfile, updateProfile, type SessionProfile } from "../../workers/session-profile-store.js";
import { looksLikePath, prepareDir, type Register } from "../lib/new-dir.js";
import { readWorkersSection, ANTHROPIC_NATIVE, getProviderOrNative, type WorkersConfig } from "../../workers/config.js";
import { launchableProviderNames, LaunchError } from "../../workers/launch.js";
import { resolveLocalProvider } from "../../workers/local-provider.js";
import { workersLogDir } from "../../workers/paths.js";
import { CliError, OPT, type CommandDef } from "../define.js";
import { colorEnabled, makeStyle, renderTable, suggest, type Style } from "../help.js";
import { buildHarness, dryRunText, execHarness, type Harness } from "../lib/harness.js";
import { providerHealth, readBudget, type Health } from "../lib/health.js";
import { probeResume } from "../lib/launch.js";
import { readOneKey, runPicker, type TtyIn, type TtyOut } from "../lib/picker.js";
import { assertAvailable, modelFor } from "../lib/provider-choice.js";
import { allSetups, downLocalProviders, findSetup, httpModelsCheck, loadSaved, orchestratorLabel, shortModel, workersLabel, type PortCheck, type Setup } from "../lib/setups.js";
import { collectView, type SessionRow } from "./session.js";
import { writeFileSync } from "node:fs";

export const CANCELLED = 130;

export interface Term {
  input: TtyIn;
  output: TtyOut;
  isTTY: boolean;
  st: Style;
}

export function systemTerm(): Term {
  return {
    input: process.stdin as unknown as TtyIn,
    output: process.stdout,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    st: makeStyle(colorEnabled()),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Exact name (newest first) wins; then id prefix; then substring of name or project. */
export function matchRows(rows: SessionRow[], query: string): SessionRow[] {
  const q = query.toLowerCase().trim();
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  if (exact.length) return [exact[0]];
  const byId = rows.filter((r) => r.uuid.startsWith(q));
  if (byId.length === 1) return byId;
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.project.toLowerCase().includes(q));
}

const healthText = (st: Style, h: Health) => (h.state === "ok" ? st.green(h.reason === "ok" ? "ok" : h.reason) : h.state === "limit" ? st.red(h.reason) : st.yellow(h.reason));

export function lastOnLabel(st: Style, r: SessionRow): string {
  if (r.provider === "—") return st.dim("unknown");
  const t = `${shortModel(r.model)} (${r.provider})`;
  return r.health.state === "ok" ? t : r.health.state === "limit" ? st.red(t) : st.yellow(t);
}

export function pickerOpts(rows: SessionRow[], st: Style, initialFilter?: string) {
  return {
    headers: ["Name", "Project", "Last active", "Last used on", "Last message"],
    items: rows,
    cells: (r: SessionRow) => [
      st.bold(truncate(r.name, 30)),
      truncate(r.project, 20),
      ago(r.lastActiveMs),
      lastOnLabel(st, r),
      st.dim(truncate(r.message || "—", 40)),
    ],
    searchText: (r: SessionRow) => `${r.name} ${r.project} ${r.provider} ${r.model} ${r.message} ${r.id}`,
    initialFilter,
    footer: "↑↓ move · type to filter · Enter open · Esc quit",
    detail: (r: SessionRow) => (r.health.state === "ok" ? "" : healthText(st, r.health)),
    empty: "no session matches — Backspace to widen, or Esc and run: pai new",
  };
}

/** The picker as plain text (not a TTY): same columns, no cursor. */
export function plainTable(rows: SessionRow[], st: Style): string {
  const o = pickerOpts(rows, st);
  return renderTable(o.headers, rows.map(o.cells), st);
}

/** Setup that reproduces how a session last ran, workers as configured now. */
export function lastSetup(row: SessionRow | null, cfg: Pick<WorkersConfig, "active">, profile: SessionProfile | null = row ? getProfile(row.name) : null): Setup {
  const workers = profile?.workers?.provider ?? (cfg.active && cfg.active !== "auto" ? cfg.active : ANTHROPIC_NATIVE);
  // the session's own default chat model (its profile) wins over whatever it last ran on
  const orch = profile?.chat ? { provider: profile.chat.provider, model: profile.chat.model } : row && row.provider !== "—" ? { provider: row.provider, model: row.model } : { provider: workers };
  return { name: "Last time", orchestrator: orch, workers, kind: "last" };
}

/** The launch screen's rows, top to bottom; `sel` indexes them. */
export type LaunchChoice = "continue" | "setup" | "fresh";
const LAUNCH_CHOICES: LaunchChoice[] = ["continue", "setup", "fresh"];

/** Pure: one keypress on the launch screen -> the marker moves, or a choice is made. */
export function launchKey(sel: number, str: string | undefined, key: { name?: string }): { sel: number; choice?: LaunchChoice } | null {
  if (key.name === "up" || str === "k") return { sel: Math.max(0, sel - 1) };
  if (key.name === "down" || str === "j") return { sel: Math.min(LAUNCH_CHOICES.length - 1, sel + 1) };
  if (key.name === "return" || key.name === "enter") return { sel, choice: LAUNCH_CHOICES[sel] };
  if (str === "s") return { sel: 1, choice: "setup" };
  if (str === "n") return { sel: 2, choice: "fresh" };
  return null;
}

export function launchScreen(row: SessionRow, last: Setup, cfg: Parameters<typeof workersLabel>[0], st: Style, sel = 0): string[] {
  const mark = (i: number) => (i === sel ? st.cyan(">") : " ");
  const state = row.health.state;
  const ran = `${lastOnLabel(st, row)} with workers on ${workersLabel(cfg, last.workers).replace(/ \(.*\)$/, "")}`;
  return [
    `${st.dim("Session      ")} "${row.name}"   ${st.dim("last active " + ago(row.lastActiveMs))}`,
    `${st.dim("Last message ")} "${truncate(row.message || "—", 60)}"`,
    `${st.dim("Last ran on  ")} ${ran}${state === "ok" ? "" : "  " + healthText(st, row.health)}`,
    `${mark(0)} ${st.bold("Enter")}  Continue exactly like last time`,
    `${mark(1)} ${st.bold("s")}      Choose a different setup`,
    `${mark(2)} ${st.bold("n")}      Start fresh (same name, new conversation)`,
  ];
}

export function setupsTable(
  setups: Setup[],
  cfg: Parameters<typeof workersLabel>[0] & Pick<WorkersConfig, "routing">,
  budget: Parameters<typeof providerHealth>[2],
  st: Style,
  routing?: RoutingState,
  down: ReadonlySet<string> = new Set()
) {
  const health = (name: string): Health => {
    const h = providerHealth(name, cfg, budget);
    const left = routing && h.state === "ok" ? cooldownRemaining(routing, name) : 0;
    return left > 0 ? { state: "limit", reason: `${name}: cooling down, ${Math.ceil(left / 60_000)}m left` } : h;
  };
  const status = (s: Setup): Health => {
    if (s.kind === "last" && down.has(s.workers)) return { state: "limit", reason: "down" };
    const a = health(s.orchestrator.provider);
    return a.state !== "ok" ? a : health(s.workers);
  };
  return {
    headers: ["#", "Setup", "Orchestrator", "Workers", "Status"],
    items: setups,
    cells: (s: Setup) => [
      st.dim(String(setups.indexOf(s) + 1)),
      st.bold(s.name),
      orchestratorLabel(cfg, s.orchestrator),
      s.local ? `${s.workers} (local)` : workersLabel(cfg, s.workers),
      healthText(st, status(s)),
    ],
    searchText: (s: Setup) => `${s.name} ${s.orchestrator.provider} ${s.workers}`,
    footer: "↑↓ move · type to filter · Enter choose · Esc back out",
    detail: (s: Setup) => (status(s).state === "ok" ? "" : "Not available right now — choosing it starts it anyway."),
    status,
  };
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

function loadWorkers(): WorkersConfig {
  try {
    return readWorkersSection().workers;
  } catch (e) {
    throw new CliError(`cannot read the provider configuration: ${e instanceof Error ? e.message : String(e)}`, "pai providers");
  }
}

interface StartArgs {
  workers: WorkersConfig;
  setup: Setup;
  name: string;
  cwd: string;
  /** Session to continue; undefined = fresh conversation. */
  resume?: SessionRow;
  dryRun: boolean;
  term: Term;
}

export async function startSession(a: StartArgs): Promise<number> {
  const { workers, setup, name, cwd, resume, dryRun, term } = a;
  const st = term.st;
  const out = (s: string) => term.output.write(s + "\n");
  const available = launchableProviderNames(workers);
  const retry = (alt: string) => `pai ${JSON.stringify(name)} --with ${JSON.stringify(`${alt} only`)}`;
  assertAvailable(setup.orchestrator.provider, available, retry);
  assertAvailable(setup.workers, available, retry);

  if (resume) {
    const probe = probeResume(resume.uuid, cwd);
    if (!probe.ok) {
      throw new CliError(
        `"${name}" has no conversation history to continue (${probe.reason ?? "unknown reason"})`,
        `pai ${JSON.stringify(name)}   then press n to start fresh under the same name`
      );
    }
  }
  const provider = getProviderOrNative(workers, setup.orchestrator.provider)!;
  let harness: Harness;
  try {
    harness = await buildHarness(workers, {
      provider: setup.orchestrator.provider,
      // the native "opus" alias is not in the worker model table (sonnet/haiku), so it passes through
      model: provider.native && setup.orchestrator.model === "opus" ? "opus" : modelFor(provider, setup.orchestrator.model),
      cwd,
      resume: resume?.uuid,
      name,
      named: !!resume?.named,
    });
  } catch (e) {
    if (e instanceof LaunchError || (e as Error).name === "WorkersConfigError") {
      throw new CliError((e as Error).message, "pai providers");
    }
    throw e;
  }
  const orch = `${shortModel(harness.model)} (${harness.provider})`;
  out(`Starting "${name}": orchestrator ${st.bold(orch)}, workers ${st.bold(workersLabel(workers, setup.workers))}`);
  if (resume && resume.provider !== "—" && (resume.provider !== harness.provider || shortModel(resume.model) !== shortModel(harness.model))) {
    out(`Conversation history carries over to ${shortModel(harness.model)}.`);
  }
  // the setup's workers apply to this session only; the global provider and class map are never written
  harness.env[SESSION_WORKER_PROVIDER_ENV] = setup.workers;
  harness.env[SESSION_NAME_ENV] = name;
  out(`Workers run on ${setup.workers} for this session only.`);
  if (dryRun) {
    out(dryRunText(harness));
    return 0;
  }
  // the choice becomes this session's profile (its default from now on); the global config is never written
  const prev = getProfile(name);
  updateProfile(name, {
    chat: { provider: setup.orchestrator.provider, ...(setup.orchestrator.model ? { model: setup.orchestrator.model } : {}) },
    workers: { provider: setup.workers, ...(prev?.workers?.provider === setup.workers && prev.workers.model ? { model: prev.workers.model } : {}) },
  });
  return execHarness(harness, workers);
}

/** What the setup list needs about local servers: the ones not answering, and the one local workers run on. */
export async function localState(workers: WorkersConfig, check: PortCheck = httpModelsCheck): Promise<{ down: Set<string>; resolved?: string }> {
  const down = await downLocalProviders(workers, check);
  try {
    return { down, resolved: (await resolveLocalProvider(workers, workersLogDir(workers), { check })).name };
  } catch {
    return { down };
  }
}

/** Setup lookup for `--with`: a setup on a local provider that is not running gets a clear error. */
export async function resolveSetup(workers: WorkersConfig, last: Setup | null, query: string, down?: ReadonlySet<string>): Promise<Setup> {
  const ls = down ? { down, resolved: undefined } : await localState(workers);
  const d = ls.down;
  const saved = loadSaved();
  const setup = findSetup(allSetups(workers, last, saved, d, ls.resolved), query);
  if (setup) return setup;
  const hidden = findSetup(allSetups(workers, last, saved), query);
  if (hidden && d.has(hidden.workers)) {
    throw new CliError(`local provider ${hidden.workers} is not running; start it with pai worker local`, "pai setups");
  }
  throw unknownSetup(query, allSetups(workers, last, saved, d, ls.resolved));
}

async function chooseSetup(term: Term, workers: WorkersConfig, last: Setup, budget: Parameters<typeof providerHealth>[2]): Promise<Setup | null> {
  const { down, resolved } = await localState(workers);
  const setups = allSetups(workers, last, loadSaved(), down, resolved);
  const o = setupsTable(setups, workers, budget, term.st, undefined, down);
  return runPicker({ ...o, title: "Choose a setup" }, term.st, term.input, term.output);
}

async function openRow(row: SessionRow, workers: WorkersConfig, withName: string | undefined, dryRun: boolean, term: Term): Promise<number> {
  const st = term.st;
  const out = (s: string) => term.output.write(s + "\n");
  const budget = await readBudget(workers);
  const last = lastSetup(row, workers);
  const cwd = row.dir;
  if (!cwd) {
    throw new CliError(`the folder of "${row.name}" no longer exists`, `cd <an existing folder> && pai new --name ${JSON.stringify(row.name)}`);
  }
  const go = (setup: Setup, fresh: boolean) => startSession({ workers, setup, name: row.name, cwd, resume: fresh ? undefined : row, dryRun, term });

  if (withName) {
    return go(await resolveSetup(workers, last, withName), false);
  }
  if (!term.isTTY) {
    if (dryRun) return go(last, false);
    throw new CliError(`"${row.name}" needs a terminal to choose how to start`, `pai ${JSON.stringify(row.name)} --with "Last time"`);
  }
  let sel = 0;
  let drawn = 0; // lines of the screen still on display, erased when the marker moves
  for (;;) {
    const lines = launchScreen(row, last, workers, st, sel);
    if (drawn) term.output.write(`\u001b[${drawn}A\r\u001b[J`);
    for (const l of lines) out(l);
    drawn = lines.length;
    const k = await readOneKey(term.input);
    if (!k) {
      out("");
      return CANCELLED;
    }
    const r = launchKey(sel, k.str, k.key);
    if (r && !r.choice) {
      sel = r.sel;
      continue;
    }
    out("");
    drawn = 0;
    if (r?.choice === "continue") {
      if (row.health.state !== "ok") {
        out(`${healthText(st, row.health)}. Press ${st.bold("s")} to choose a setup deliberately.`);
        continue;
      }
      return go(last, false);
    }
    if (r?.choice === "fresh") return go(last, true);
    if (r?.choice === "setup") {
      const chosen = await chooseSetup(term, workers, last, budget);
      return chosen ? go(chosen, false) : CANCELLED;
    }
    out(st.dim("Press Enter, s or n, or move with Up/Down (Esc to quit)."));
  }
}

function unknownSetup(q: string, setups: Setup[]): CliError {
  const near = suggest(q, setups.map((s) => s.name));
  return new CliError(
    `no setup called "${q}"${near ? ` — did you mean "${near}"?` : ""}. Known: ${setups.map((s) => s.name).join(", ")}`,
    "pai setups"
  );
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function finishCd(cdDir: string, term: Pick<Term, "output">, env: NodeJS.ProcessEnv = process.env): number {
  if (env.PAI_PICK_OUT) {
    writeFileSync(env.PAI_PICK_OUT, cdDir);
  } else {
    term.output.write(cdDir + "\n");
  }
  return 0;
}

/** `pai new DIR --with SETUP`: create + register the folder, then start exactly like `pai NAME --with`. */
export async function runNewWith(
  args: { dir?: string; with: string; name?: string; dryRun: boolean },
  term: Term = systemTerm(),
  register?: Register
): Promise<number> {
  const workers = loadWorkers();
  const setup = await resolveSetup(workers, lastSetup(null, workers), args.with);
  const cwd = await prepareDir(args.dir, { dryRun: args.dryRun, out: (s) => term.output.write(s + "\n"), register });
  return startSession({ workers, setup, name: args.name ?? (basename(cwd) || "session"), cwd, dryRun: args.dryRun, term });
}

export async function runRoot(
  args: { name?: string; with?: string; dryRun: boolean },
  term: Term = systemTerm()
): Promise<number> {
  const st = term.st;
  const out = (s: string) => term.output.write(s + "\n");
  if (args.name && looksLikePath(args.name)) {
    if (args.with) return runNewWith({ dir: args.name, with: args.with, dryRun: args.dryRun }, term);
    return (await import("./session.js")).runNewDefault({ dir: args.name, dryRun: args.dryRun });
  }
  const workers = loadWorkers();

  if (!args.name && args.with) {
    const setup = await resolveSetup(workers, lastSetup(null, workers), args.with);
    return startSession({ workers, setup, name: basename(process.cwd()) || "session", cwd: process.cwd(), dryRun: args.dryRun, term });
  }

  const { rows } = await collectView(args.name ? { limit: 500 } : {});
  if (rows.length === 0) {
    out("No sessions yet.");
    out(st.dim("Start one in this folder with: pai new"));
    return 0;
  }

  let picked: SessionRow | undefined;
  let cdDir: string | undefined;
  if (!args.name) {
    if (!term.isTTY) {
      out(plainTable(rows, st));
      out("");
      out(st.dim("Open one: pai <name>   ·   more commands: pai more"));
      return 0;
    }
    picked = (await runPicker({ ...pickerOpts(rows, st), onCd: (row) => cdDir = row.dir }, st, term.input, term.output)) ?? undefined;
    if (!picked) return cdDir !== undefined ? finishCd(cdDir, term) : CANCELLED;
  } else {
    const matches = matchRows(rows, args.name);
    if (matches.length === 0) {
      const near = suggest(args.name, rows.map((r) => r.name));
      const cmd = suggest(args.name, ["ls", "open", "new", "rename", "setups", "providers", "help", "doc", "more"]);
      throw new CliError(
        `no session called "${args.name}"${near ? ` — closest name: "${near}"` : ""}${cmd ? ` (or did you mean the command "${cmd}"?)` : ""}`,
        near ? `pai ${JSON.stringify(near)}` : "pai   (shows every session)",
        2
      );
    }
    if (matches.length === 1) picked = matches[0];
    else if (!term.isTTY) {
      out(plainTable(matches, st));
      throw new CliError(`${matches.length} sessions match "${args.name}"`, `pai "<a longer part of the name>"`);
    } else {
      picked = (await runPicker({ ...pickerOpts(matches, st, undefined), onCd: (row) => cdDir = row.dir }, st, term.input, term.output)) ?? undefined;
      if (!picked) return cdDir !== undefined ? finishCd(cdDir, term) : CANCELLED;
    }
  }

  return openRow(picked, workers, args.with, args.dryRun, term);
}

export const rootCommand: CommandDef = {
  name: "pai",
  summary: "Open a session by name; shows how it will start",
  description:
    "`pai` shows your sessions, newest first; type to filter, Enter opens one.\n" +
    "`pai NAME` opens a session by name (an exact name wins; part of a name or an id also works).\n" +
    "`pai ./dir`, `pai ~/dir` or the name of an existing folder starts a new session there, like `pai new`.",
  args: [{ name: "NAME", summary: "Session name, part of it, or its id (a folder path starts a new session there)" }],
  options: [
    { name: "with", type: "string", value: "SETUP", summary: "Scripting: start with this setup, no questions (see: pai setups)" },
    { ...OPT.dryRun },
  ],
  examples: ["pai", 'pai "20 - Webseiten"', 'pai webseiten --with "glm only"', 'pai --with "anthropic only"'],
  seeAlso: ["pai setups", "pai ls", "pai more"],
  run: (ctx) => runRoot({ name: ctx.args.NAME as string | undefined, with: ctx.opts.with as string | undefined, dryRun: ctx.dryRun }),
};
