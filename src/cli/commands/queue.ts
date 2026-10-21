/**
 * `pai queue`: a local queue for small incremental changes. Behaviour lives in
 * src/workers/queue*.ts; this file declares names, flags and help.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pai } from "../../workers/plan-deps.js";
import { QueueReporter } from "../../workers/run-events.js";
import { finishDetached, reportOriginWithHost, runMessenger, startDetached } from "../../workers/run-report-wiring.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";
import { escalationCloud, getProviderOrNative, readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";
import { effectiveCap } from "../../workers/capacity.js";
import { isLocalProvider } from "../../workers/config.js";
import { localProviderForDelegation } from "../../workers/local-provider.js";
import { again, loadSettings, queueStatePath, QueueStore, renderList, renderReview, move, type QueueItem, type QueueSettings } from "../../workers/queue.js";
import { acceptItems, runQueue } from "../../workers/queue-runner.js";
import { branchDiff, realQueueDeps } from "../../workers/queue-deps.js";

const out = (s: string) => process.stdout.write(s + "\n");

async function repoOf(project: unknown): Promise<string> {
  if (typeof project === "string" && project) {
    if (existsSync(project)) return resolve(project);
    const { getProject } = await import("../impl/project/helpers.js");
    const row = await getProject(project);
    if (!row) throw new CliError(`no project ${project}`, "pai projects list");
    return row.root_path;
  }
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new CliError("not inside a git checkout", "cd into the project or pass --project <slug>");
  }
}

async function open(ctx: RunContext): Promise<{ repo: string; store: QueueStore; settings: QueueSettings }> {
  const repo = await repoOf(ctx.opts.project);
  return { repo, store: new QueueStore(queueStatePath(repo)), settings: loadSettings(repo) };
}

/**
 * The settings' provider, else the active provider when local, else the first
 * local one. A settings provider of `local` (or none found) stays the value
 * `local`: the run resolves it to the server that answers (queue run's
 * --local path / the plan runner's resolvePlanProvider), never a guess.
 */
function namedCap(name: string): number {
  const p = getProviderOrNative(readWorkersSection().workers, name);
  return effectiveCap(p?.maxConcurrent, true, p?.conversationSlots);
}

function providerOf(settings: QueueSettings): { name: string; cap: number } {
  try {
    const w = readWorkersSection().workers;
    const local = (n: string) => {
      const p = getProviderOrNative(w, n);
      return p && isLocalProvider(p.baseUrl) ? p : undefined;
    };
    const found = w.active && w.active !== "auto" && local(w.active) ? w.active : Object.keys(w.providers).find((n) => local(n));
    const name = settings.provider ?? found ?? "local";
    const p = name === "local" ? undefined : getProviderOrNative(w, name);
    return { name, cap: effectiveCap(p?.maxConcurrent, p ? isLocalProvider(p.baseUrl) : true, p?.conversationSlots) };
  } catch {
    return { name: settings.provider ?? "local", cap: 3 };
  }
}

const projectOpt = { name: "project", type: "string" as const, value: "SLUG", summary: "Project slug or folder (default: the git checkout of the current directory)" };
const ids = (ctx: RunContext): string[] => [ctx.args.ID].flat().map(String);
const idsArg = [{ name: "ID", summary: "Queue item id(s), e.g. q3", required: true, variadic: true }];

const addCmd: CommandDef = {
  name: "add",
  summary: "Queue one small change, described in a sentence",
  description: "Stores the sentence (plus optional files and an image) as a pending item of the project. The worker spec is composed at run time: your sentence, the files, the project's queue rules and a fixed footer (relative paths, git add then commit, keep it small, report with R).",
  args: [{ name: "TEXT", summary: "One sentence: the symptom or the element", required: true }],
  options: [
    { name: "files", type: "string", value: "A,B", summary: "Files the change probably touches (items sharing a file never run together)" },
    { name: "image", type: "string", value: "PATH", summary: "Screenshot or mock-up the worker should look at" },
    projectOpt,
  ],
  examples: ['pai queue add "the save button tooltip says Sav"', 'pai queue add "move the export button next to Share" --files src/Toolbar.tsx'],
  seeAlso: ["pai queue run", "pai queue review"],
  run: async (ctx) => {
    const { repo, store } = await open(ctx);
    const files = typeof ctx.opts.files === "string" ? ctx.opts.files.split(",").map((f) => f.trim()).filter(Boolean) : [];
    const image = typeof ctx.opts.image === "string" ? resolve(ctx.opts.image) : undefined;
    if (image && !existsSync(image)) throw new CliError(`no such image: ${image}`);
    const it = store.add(String(ctx.args.TEXT), repo, { files, image });
    out(`${it.id} queued (${repo})`);
    return 0;
  },
};

const runCmd: CommandDef = {
  name: "run",
  summary: "Drain the pending items on the local provider; nothing is merged",
  description: "Runs each pending item as a worker in its own worktree branch, up to N at once. A finished item becomes ready (diff stat, gate result in the worktree, proof output, worker report), too-big when it exceeds max_files/max_lines, or after one local retry with the failure tail needs-decision. Merging is `pai queue accept`. The gate runs only if .pai/queue.yaml names one; no test suite otherwise. With --escalate sonnet, only items marked cloud (two failed `again` rounds) run, on one Sonnet worker each.",
  options: [
    projectOpt,
    { name: "local", type: "boolean", summary: "Run on the local model server PAI resolves (the one that answers); never pick a local provider by name" },
    { name: "provider", type: "string", value: "NAME", summary: "Provider name (the detached runner passes what it resolved; the value local is resolved at run start)" },
    { name: "parallel", type: "number", value: "N", summary: "Items running at once (default: max_parallel of queue.yaml, else the provider's maxConcurrent)" },
    { name: "escalate", type: "string", value: "TIER", summary: "Run the cloud items on TIER (only workers.escalate.cloud.tier)" },
    { name: "model", type: "string", value: "MODEL", summary: "Model the items' workers get: default, fast or a model id (default: the provider's worker_model)" },
    { name: "now", type: "boolean", summary: "The items' workers go ahead of the runs waiting for a slot on the provider" },
    { name: "no-pool", type: "boolean", summary: "The items' workers start fresh, never using the worker pool" },
    { name: "detach", type: "boolean", summary: "Hand the run to a detached process that outlives this session and reports ready / needs-decision items back to it" },
  ],
  examples: ["pai queue run", "pai queue run --detach", "pai queue run --parallel 2", "pai queue run --escalate sonnet"],
  seeAlso: ["pai queue review", "pai queue accept", "pai plan run"],
  run: async (ctx) => {
    const esc = ctx.opts.escalate;
    const cloudTier = escalationCloud().tier;
    if (esc !== undefined && esc !== cloudTier) throw new CliError(`--escalate takes ${cloudTier}, not ${String(esc)}`, `pai queue run --escalate ${cloudTier}`);
    const { repo, store, settings } = await open(ctx);
    // --local: PAI resolves the running local server itself (local-provider.ts);
    // --provider names one (the detached runner passes what it already resolved)
    const named = typeof ctx.opts.provider === "string" ? ctx.opts.provider : undefined;
    const prov =
      ctx.opts.local === true
        ? await localProviderForDelegation()
        : named
          ? { name: named, cap: namedCap(named) }
          : providerOf(settings);
    const parallel = typeof ctx.opts.parallel === "number" ? Math.max(1, Math.floor(ctx.opts.parallel)) : (settings.maxParallel ?? prov.cap);
    const logDir = workersLogDir(readWorkersSection().workers);
    const origin = await reportOriginWithHost();
    if (ctx.opts.detach === true) {
      const rec = startDetached(logDir, { kind: "queue", label: basename(repo), positional: [], opts: ctx.opts, cwd: repo, origin });
      out(`detached: ${rec.id} (pid ${rec.pid}); output in ${rec.output}; ${origin ? "events go to the starting session" : "no originating session found, events are not delivered"}`);
      return 0;
    }
    const reporter = origin ? new QueueReporter(basename(repo), runMessenger(logDir), origin) : null;
    const onEvent = reporter ? (k: "ready" | "needs-decision", it: QueueItem) => (k === "ready" ? reporter.onReady(it) : reporter.onNeedsDecision(it)) : undefined;
    const s = await runQueue(store, settings, { provider: prov.name, parallel, escalate: esc === cloudTier, ...(typeof ctx.opts.model === "string" ? { model: ctx.opts.model } : {}), ...(ctx.opts.now === true ? { priority: "front" as const } : {}), ...(ctx.opts["no-pool"] === true ? { noPool: true } : {}), onEvent }, realQueueDeps(logDir, repo));
    await reporter?.finish();
    finishDetached(logDir);
    out(`ready: ${s.ready.join(", ") || "none"}; too-big: ${s.tooBig.join(", ") || "none"}; needs-decision: ${s.needsDecision.join(", ") || "none"}`);
    if (s.spawnRefusal) out(`spawn refused, scheduling stopped: ${s.spawnRefusal}`);
    return s.needsDecision.length ? 1 : 0;
  },
};

const reviewCmd: CommandDef = {
  name: "review",
  summary: "One compact list of ready items: sentence, diff stat, gate, proof",
  description: "Lists the ready items of the project. Judge them, then `pai queue accept`, `reject` or `again`.",
  options: [projectOpt],
  examples: ["pai queue review"],
  seeAlso: ["pai queue accept", "pai queue reject", "pai queue again"],
  run: async (ctx) => {
    out(renderReview((await open(ctx)).store.list()));
    return 0;
  },
};

const listCmd: CommandDef = {
  name: "list",
  summary: "Every item of the project with its state",
  description: "States: pending, running, ready, too-big, needs-decision, cloud, accepted, rejected.",
  options: [projectOpt],
  examples: ["pai queue list"],
  seeAlso: ["pai queue review"],
  run: async (ctx) => {
    out(renderList((await open(ctx)).store.list()));
    return 0;
  },
};

const acceptCmd: CommandDef = {
  name: "accept",
  summary: "Merge ready items with the project's gate, then run its install command",
  description: "For each id: `pai worker merge --verify GATE` (a failing gate reverts the merge and the item stays ready), then the install command of .pai/queue.yaml.",
  args: idsArg,
  options: [projectOpt],
  examples: ["pai queue accept q3 q4"],
  seeAlso: ["pai queue review"],
  run: async (ctx) => {
    const { repo, store, settings } = await open(ctx);
    const logDir = workersLogDir(readWorkersSection().workers);
    const res = await acceptItems(store, settings, ids(ctx), realQueueDeps(logDir, repo));
    for (const r of res) out(`${r.id}: ${r.ok ? "ok" : "FAILED"} ${r.note}`);
    return res.every((r) => r.ok) ? 0 : 1;
  },
};

const rejectCmd: CommandDef = {
  name: "reject",
  summary: "Drop items; their branches stay for `pai worker gc`",
  description: "Marks the items rejected.",
  args: idsArg,
  options: [projectOpt, { name: "why", type: "string", value: "TEXT", summary: "Reason, kept on the item" }],
  examples: ['pai queue reject q2 --why "wrong button"'],
  seeAlso: ["pai queue list"],
  run: async (ctx) => {
    const { store } = await open(ctx);
    let bad = 0;
    for (const id of ids(ctx)) {
      try {
        move(store, id, "rejected", { why: typeof ctx.opts.why === "string" ? ctx.opts.why : undefined });
        out(`${id}: rejected`);
      } catch (e) {
        bad++;
        out(`${id}: ${(e as Error).message}`);
      }
    }
    return bad ? 1 : 0;
  },
};

const againCmd: CommandDef = {
  name: "again",
  summary: "Re-queue an item with what is still wrong",
  description: "Re-queues the item with the previous attempt's diff and your note appended to the spec. After two such rounds the item is marked cloud and is taken by `pai queue run --escalate sonnet`.",
  args: [{ name: "ID", summary: "Queue item id", required: true }, { name: "NOTE", summary: "What is still wrong", required: true }],
  options: [projectOpt],
  examples: ['pai queue again q3 "still not: the tooltip is clipped on the left"'],
  seeAlso: ["pai queue run"],
  run: async (ctx) => {
    const { repo, store } = await open(ctx);
    const id = String(ctx.args.ID);
    const it = store.get(id);
    if (!it) throw new CliError(`no queue item ${id}`, "pai queue list");
    const diff = it.worker ? await branchDiff(repo, it.worker).catch(() => undefined) : undefined;
    const n = again(store, id, String(ctx.args.NOTE), diff || undefined);
    out(`${id}: ${n.state === "cloud" ? "marked for the cloud (pai queue run --escalate sonnet)" : "queued again"}`);
    return 0;
  },
};

export const queueCommand: CommandDef = {
  name: "queue",
  summary: "Queue small changes, run them on a local worker, review in a batch",
  description: "A local queue for one-sentence changes: add them, drain them in worktree branches, review the ready ones together, accept (merge with the gate) or send back with a note. See docs/queue.md.",
  examples: ['pai queue add "tooltip says Sav"', "pai queue run", "pai queue review", "pai queue accept q1"],
  subcommands: [addCmd, runCmd, reviewCmd, listCmd, acceptCmd, rejectCmd, againCmd],
};
