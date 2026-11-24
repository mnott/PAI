/** `pai freeze` / `pai thaw` (and `pai worker freeze --all|--resume`): stop and continue all local development work (workers/freeze.ts). */

import { existsSync } from "node:fs";
import { CliError, type CommandDef, type RunContext } from "../define.js";
import { deepFreeze, deepResume, readDeepfreeze, realDeepFreezeDeps, realDeepResumeDeps, realRepoOf } from "../../workers/deepfreeze.js";
import { freezeAll, freezeLogDir, freezePath, freezeStatusLines, parseDuration, realFreezeDeps, thawAll, thawSome } from "../../workers/freeze.js";

/** The log dir to operate on: PAI_FREEZE_LOGDIR in test mode (missing = refuse), the real config otherwise. */
function logDir(): string {
  try {
    return freezeLogDir();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new CliError(m.startsWith("test mode") ? m : `cannot read the worker configuration: ${m}`, "pai config path");
  }
}

const list = (v: unknown): string[] | undefined => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

function by(): string {
  return process.env.PAI_SESSION_NAME || process.env.USER || "operator";
}

/** `pai stop` / `pai freeze --deep`: record, WIP-commit and cleanly stop every worker and the local models; survives a reboot. */
export async function deepStopRun(ctx: RunContext): Promise<number> {
  const id = typeof ctx.args.ID === "string" ? ctx.args.ID : undefined;
  const session = typeof ctx.opts.session === "string" ? ctx.opts.session : undefined;
  const only = id || session ? { ids: id ? [id] : undefined, session } : undefined;
  if (process.env.PAI_WORKER === "1") throw new CliError("a worker cannot stop its siblings", "ask the operator to run `pai stop`");
  try {
    const deps = await realDeepFreezeDeps();
    const r = await deepFreeze(logDir(), by(), deps, { dryRun: ctx.dryRun === true || ctx.opts["dry-run"] === true, repoOf: (s) => realRepoOf(s, deps.git), only });
    console.log(r.lines.join("\n"));
    return 0;
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), "pai resume --drop");
  }
}

/** True when `pai stop` recorded a worker with this id. */
export async function isDeepRecorded(id: string): Promise<boolean> {
  return readDeepfreeze()?.workers.some((w) => w.id === id) ?? false;
}

/** `pai resume` (no NAME) / `pai thaw` after a deep freeze: restore the recorded workers now, or discard the record with --drop. */
export async function deepResumeRun(drop: boolean, only?: { ids?: string[]; session?: string }): Promise<number> {
  const r = await deepResume(logDir(), await realDeepResumeDeps(), { drop, only });
  console.log(r.lines.join("\n"));
  return r.failed.length ? 1 : 0;
}

async function freezeRun(ctx: RunContext): Promise<number> {
  if (ctx.opts.deep === true) return deepStopRun(ctx);
  if (ctx.opts.resume === true) return thawRun(ctx);
  if (ctx.opts.status === true) {
    console.log(freezeStatusLines().join("\n"));
    return 0;
  }
  // a worker is refused by the env var or its process ancestry (`env -u PAI_WORKER` does not clear it); test mode is exempt — see workers/freeze.ts
  if (process.env.PAI_WORKER === "1") throw new CliError("a worker cannot freeze its siblings", "ask the operator to run `pai freeze`");
  let forMs: number | undefined;
  if (typeof ctx.opts.for === "string") {
    try {
      forMs = parseDuration(ctx.opts.for);
    } catch (e) {
      throw new CliError(e instanceof Error ? e.message : String(e), "pai freeze --for 30m");
    }
  }
  try {
    const deps = realFreezeDeps();
    const only = typeof ctx.opts.only === "string" ? ctx.opts.only.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
    // --only never stalls every other worker's shared model server: it implies --workers-only unless --models says otherwise
    if (ctx.opts["workers-only"] === true || (only && ctx.opts.models !== true)) deps.servers = async () => [];
    const exceptIds = list(ctx.opts.except);
    const exceptSession = typeof ctx.opts["except-session"] === "string" ? ctx.opts["except-session"] : undefined;
    const r = await freezeAll(logDir(), by(), forMs, deps, only, exceptIds || exceptSession ? { ids: exceptIds, session: exceptSession } : undefined, ctx.opts.all === true);
    console.log(r.lines.join("\n"));
    return 0;
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), "pai freeze --status");
  }
}

async function thawRun(ctx?: RunContext): Promise<number> {
  // a deep freeze (`pai stop`) leaves a record, not a marker: thaw restores it (or --drop discards it)
  if (readDeepfreeze() && !existsSync(freezePath())) return deepResumeRun(ctx?.opts.drop === true);
  const ids = list(ctx?.opts.only);
  const session = typeof ctx?.opts.session === "string" ? ctx.opts.session : undefined;
  const deps = realFreezeDeps();
  const r = ids || session ? thawSome(logDir(), deps, { ids, session }) : thawAll(logDir(), deps);
  console.log(r.lines.join("\n"));
  return 0;
}

const WORKERS_ONLY_OPT = { name: "workers-only", type: "boolean", summary: "Leave the local model server running (freeze the worker trees only)" } as const;
const ONLY_OPT = { name: "only", type: "string", value: "IDS", summary: "Freeze only these worker ids (comma list); every other worker stays supervised and new runs are not held; implies --workers-only — the shared model server keeps running for every other worker (add --models to freeze it too)" } as const;
const MODELS_OPT = { name: "models", type: "boolean", summary: "With --only: also freeze the local model server(s) (off by default; a plain `pai freeze` always takes them)" } as const;
const EXCEPT_OPT = { name: "except", type: "string", value: "IDS", summary: "Freeze everything except these worker ids (comma list) and their children" } as const;
const EXCEPT_SESSION_OPT = { name: "except-session", type: "string", value: "NAME", summary: "Freeze everything except this session's workers (and their children)" } as const;
const FOR_OPT = { name: "for", type: "string", value: "DURATION", summary: "Thaw by itself after this long (30m, 2h); the daemon does it, `pai thaw` always works" } as const;
const ALL_OPT = { name: "all", type: "boolean", summary: "Freeze every local model server too, including the ones marked light (models.runtimes.<name>.freeze: spare)" } as const;

export const freezeCommand: CommandDef = {
  name: "freeze",
  summary: "Stop all running workers and the local model servers to free the CPU/GPU now (a runtime marked freeze: spare keeps serving)",
  description:
    "Testing freeze safely: prove `pai freeze` without touching the live machine with three env vars together — PAI_FREEZE_FILE pointing at a throwaway marker, PAI_FREEZE_LOGDIR pointing at an isolated log dir (required in test mode: worker discovery reads only that dir, never the real one), and PAI_FREEZE_SERVERS listing exactly the pids its model discovery may stop (`pid[:label]`, comma list; with nothing listed no server is discovered at all). Isolation is all-or-nothing: a marker alone is not isolation — with test mode half-set (no log dir) the command refuses rather than fall back to the real config. A PAI worker cannot freeze even with PAI_WORKER cleared from its env (`env -u PAI_WORKER`): the process ancestry is checked against the running workers' pids too, and only test mode is exempt. SIGSTOP to every running worker's whole process tree (L1s, L2s, local and cloud: their tool calls burn local CPU; children first, an L1 last) and then to the local model servers — one entry per server, found by its listening port and named by the model it serves there. Every server is stopped except a runtime explicitly marked light with `models.runtimes.<name>.freeze: spare` (the shipped apple-fm bridge carries it: on the Neural Engine it costs near nothing idle and stopping it hangs every helper call routed to it — 2026-11-24: 60 s timeouts). Everything else, GPU servers and unconfigured runtimes included, is stopped so a freeze really frees the machine; `--all` stops the spared ones too, and the output lists what was spared. Nothing is killed. No new `pai worker run` gets a slot while frozen; deadlines and wait budgets do not count the frozen time and supervision treats the workers as healthy. `pai thaw` continues everything where it was and tells every worker so. `--only <id>` (and `--except`) is a partial freeze: only those workers stand still, the rest stay supervised and the slot gate stays open; ids that are not running write no marker. `--only <id>` implies `--workers-only`: one worker's freeze never stalls every other worker's shared model server (`--models` takes it anyway). Never touches the daemon, router, AIBroker, interactive sessions or docker. Refused inside a worker. `--except-session NAME` / `--except ID[,ID]` freezes everything except those workers and their children (a model server they run on keeps serving). A run started with `--now` (or inside an urgency window) is not held by a freeze; it takes its cloud route when the local model is frozen, unless --local (then the model server is thawed).",
  examples: ["pai freeze", "pai freeze --for 30m", "pai freeze --all", "pai freeze --only w-1234", "pai freeze --status", "pai freeze --except-session CaseLeaf", "pai thaw", "pai thaw --session CaseLeaf"],
  options: [
    FOR_OPT,
    ALL_OPT,
    WORKERS_ONLY_OPT,
    ONLY_OPT,
    MODELS_OPT,
    EXCEPT_OPT,
    EXCEPT_SESSION_OPT,
    { name: "deep", type: "boolean", summary: "Deep freeze (same as `pai stop`): record, WIP-commit and cleanly stop every worker and the local models so the work survives a reboot" },
    { name: "dry-run", type: "boolean", summary: "With --deep: list what would be preserved, change nothing" },
    { name: "status", type: "boolean", summary: "Show since when, by whom and what is frozen" },
    { name: "resume", type: "boolean", summary: "Same as `pai thaw`" },
  ],
  seeAlso: ["pai thaw", "pai worker ps"],
  run: freezeRun,
};

export const thawCommand: CommandDef = {
  name: "thaw",
  summary: "Continue everything `pai freeze` stopped, exactly where it was",
  description:
    "SIGCONT to every recorded pid (model server first, then the workers, children before their L1), removes the marker and opens the slot gate. Every thawed worker gets a note that the operator paused it and nothing failed. Idempotent; a process that ended meanwhile is skipped and reported. `--session NAME` or `--only ID[,ID]` continues only those workers (a session's children follow their L1), keeps the rest frozen and rewrites the marker (the gate stays while anything is frozen); a frozen model server a thawed local worker uses is thawed too and reported in one line.",
  examples: ["pai thaw", "pai thaw --session CaseLeaf", "pai thaw --only w-1,w-2"],
  options: [
    { name: "session", type: "string", value: "NAME", summary: "Continue only this session's workers (and their children)" },
    { name: "only", type: "string", value: "IDS", summary: "Continue only these worker ids (comma list)" },
    { name: "drop", type: "boolean", summary: "After a deep freeze: discard the record, resume nothing" },
  ],
  seeAlso: ["pai freeze"],
  run: (ctx) => thawRun(ctx),
};

/** `pai worker freeze --all|--resume|--status` */
export const workerFreezeCommand: CommandDef = {
  name: "freeze",
  summary: "Alias of `pai freeze` (--all) and `pai thaw` (--resume)",
  args: [{ name: "ID", summary: "Freeze this one worker (in memory; lost on reboot)" }],
  description: "`pai worker freeze <id>` stops one worker's process tree (`pai worker thaw <id>` continues it); `pai worker freeze --all` is `pai freeze --all` (every worker and every local model server, including runtimes marked freeze: spare); `--resume` is `pai thaw`; `--status` shows what is frozen.",
  examples: ["pai worker freeze --all", "pai worker freeze --resume", "pai worker freeze 20261019-142851-84910"],
  options: [
    { name: "all", type: "boolean", summary: "Freeze every running worker and every local model server (runtimes marked freeze: spare too; a plain `pai freeze` spares them)" },
    { name: "resume", type: "boolean", summary: "Thaw (same as `pai thaw`)" },
    { name: "status", type: "boolean", summary: "Show what is frozen" },
    FOR_OPT,
    WORKERS_ONLY_OPT,
    ONLY_OPT,
    MODELS_OPT,
    EXCEPT_OPT,
    EXCEPT_SESSION_OPT,
  ],
  seeAlso: ["pai freeze", "pai thaw"],
  run: (ctx) => {
    if (ctx.args.ID) {
      ctx.opts.only = ctx.args.ID as string;
      return freezeRun(ctx);
    }
    if (ctx.opts.all !== true && ctx.opts.resume !== true && ctx.opts.status !== true) throw new CliError("say --all, --resume or --status", "pai worker freeze --all");
    // `pai worker freeze --all` already passes opts.all through to freezeRun, which freezes light runtimes too
    return freezeRun(ctx);
  },
};

/** `pai worker thaw <id>`: continue one frozen worker. */
export const workerThawCommand: CommandDef = {
  name: "thaw",
  summary: "Continue one frozen worker",
  description: "Continues the process tree of one worker stopped with `pai worker freeze <id>`; nothing else is touched.",
  args: [{ name: "ID", required: true, summary: "Worker id" }],
  examples: ["pai worker thaw 20261019-142851-84910"],
  seeAlso: ["pai worker freeze", "pai thaw"],
  run: (ctx) => thawRun({ ...ctx, opts: { ...ctx.opts, only: ctx.args.ID as string } } as RunContext),
};

const STOP_DESC =
  "Deep freeze: preserves ALL worker work across a reboot. For every live worker on the machine (all sessions and projects) it writes <PAI home>/state/deepfreeze.json (id, label, session/project, cwd/repo, branch, worktree, spec, class, provider, priority, parent/children, state running|queued), commits uncommitted work in each worktree on the worker's own branch as `wip: deepfreeze <timestamp>` (hooks run; a refused commit leaves the files untouched), stops each worker through the normal teardown and marks it `deepfrozen` (no failure alert, escalation or reroute), then stops the local model servers. After the boot the daemon waits for the router and the autostart models (5 min at most), resumes every recorded worker in its original order and priority (rerouted origins whose continuation finished are skipped), sends one PAILot line and removes the record. `pai resume` does the same at once, `pai resume --drop` discards the record. `--dry-run` lists what would be preserved. Refused inside a worker. Plain `pai freeze`/`pai thaw` stay the in-memory SIGSTOP pause.";

export const stopCommand: CommandDef = {
  name: "stop",
  summary: "Deep freeze: record, WIP-commit and stop all workers and local models; restored after a reboot",
  description: STOP_DESC,
  examples: ["pai stop --dry-run", "pai stop", "pai resume", "pai resume --drop"],
  args: [{ name: "ID", summary: "Stop only this worker (omit for everything)" }],
  options: [{ name: "dry-run", type: "boolean", summary: "List what would be preserved, change nothing" }, { name: "session", type: "string", value: "NAME", summary: "Stop only the workers of this session" }],
  seeAlso: ["pai resume", "pai freeze"],
  run: deepStopRun,
};

export const deepfreezeCommand: CommandDef = {
  name: "deepfreeze",
  summary: "Alias of `pai stop` (= `pai freeze --deep`)",
  description: STOP_DESC,
  examples: ["pai deepfreeze --dry-run"],
  options: [{ name: "dry-run", type: "boolean", summary: "List what would be preserved, change nothing" }],
  seeAlso: ["pai stop", "pai resume"],
  run: deepStopRun,
};
