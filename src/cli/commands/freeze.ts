/** `pai freeze` / `pai thaw` (and `pai worker freeze --all|--resume`): stop and continue all local development work (workers/freeze.ts). */

import { CliError, type CommandDef, type RunContext } from "../define.js";
import { workersLogDir } from "../../workers/paths.js";
import { readWorkersSection } from "../../workers/config.js";
import { freezeAll, freezeStatusLines, parseDuration, realFreezeDeps, thawAll } from "../../workers/freeze.js";

function logDir(): string {
  try {
    return workersLogDir(readWorkersSection().workers);
  } catch (e) {
    throw new CliError(`cannot read the worker configuration: ${e instanceof Error ? e.message : String(e)}`, "pai config path");
  }
}

function by(): string {
  return process.env.PAI_SESSION_NAME || process.env.USER || "operator";
}

async function freezeRun(ctx: RunContext): Promise<number> {
  if (ctx.opts.resume === true) return thawRun();
  if (ctx.opts.status === true) {
    console.log(freezeStatusLines().join("\n"));
    return 0;
  }
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
    const r = await freezeAll(logDir(), by(), forMs, deps, only);
    console.log(r.lines.join("\n"));
    return 0;
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), "pai freeze --status");
  }
}

async function thawRun(): Promise<number> {
  const r = thawAll(logDir(), realFreezeDeps());
  console.log(r.lines.join("\n"));
  return 0;
}

const WORKERS_ONLY_OPT = { name: "workers-only", type: "boolean", summary: "Leave the local model server running (freeze the worker trees only)" } as const;
const ONLY_OPT = { name: "only", type: "string", value: "IDS", summary: "Freeze only these worker ids (comma list); implies --workers-only — the shared model server keeps running for every other worker (add --models to freeze it too)" } as const;
const MODELS_OPT = { name: "models", type: "boolean", summary: "With --only: also freeze the local model server(s) (off by default; a plain `pai freeze` always takes them)" } as const;
const FOR_OPT = { name: "for", type: "string", value: "DURATION", summary: "Thaw by itself after this long (30m, 2h); the daemon does it, `pai thaw` always works" } as const;

export const freezeCommand: CommandDef = {
  name: "freeze",
  summary: "Stop all running workers and the local model server to free the CPU/GPU now",
  description:
    "SIGSTOP to every running worker's whole process tree (L1s, L2s, local and cloud: their tool calls burn local CPU; children first, an L1 last) and then to the local model server(s) — one entry per server, found by its listening port and named by the model it serves there. Nothing is killed. No new `pai worker run` gets a slot while frozen; deadlines and wait budgets do not count the frozen time and supervision treats the workers as healthy. `pai thaw` continues everything where it was and tells every worker so. `--only <id>` implies `--workers-only`: one worker's freeze never stalls every other worker's shared model server (`--models` takes it anyway). Never touches the daemon, router, AIBroker, interactive sessions or docker. Refused inside a worker.",
  examples: ["pai freeze", "pai freeze --for 30m", "pai freeze --only w-1234", "pai freeze --status", "pai thaw"],
  options: [
    FOR_OPT,
    WORKERS_ONLY_OPT,
    ONLY_OPT,
    MODELS_OPT,
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
    "SIGCONT to every recorded pid (model server first, then the workers, children before their L1), removes the marker and opens the slot gate. Every thawed worker gets a note that the operator paused it and nothing failed. Idempotent; a process that ended meanwhile is skipped and reported.",
  examples: ["pai thaw"],
  seeAlso: ["pai freeze"],
  run: () => thawRun(),
};

/** `pai worker freeze --all|--resume|--status` */
export const workerFreezeCommand: CommandDef = {
  name: "freeze",
  summary: "Alias of `pai freeze` (--all) and `pai thaw` (--resume)",
  description: "`pai worker freeze --all` is `pai freeze`; `--resume` is `pai thaw`; `--status` shows what is frozen.",
  examples: ["pai worker freeze --all", "pai worker freeze --resume"],
  options: [
    { name: "all", type: "boolean", summary: "Freeze every running worker and the local model server" },
    { name: "resume", type: "boolean", summary: "Thaw (same as `pai thaw`)" },
    { name: "status", type: "boolean", summary: "Show what is frozen" },
    FOR_OPT,
    WORKERS_ONLY_OPT,
    ONLY_OPT,
    MODELS_OPT,
  ],
  seeAlso: ["pai freeze", "pai thaw"],
  run: (ctx) => {
    if (ctx.opts.all !== true && ctx.opts.resume !== true && ctx.opts.status !== true) throw new CliError("say --all, --resume or --status", "pai worker freeze --all");
    return freezeRun(ctx);
  },
};
