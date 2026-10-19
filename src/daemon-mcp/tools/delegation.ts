/**
 * Delegation tools for tier 0: plan_save/run/status/amend and queue_*.
 *
 * Thin wrappers over src/workers/plan*.ts and queue*.ts, called as functions
 * (never through the CLI). Extracted like worker-model.ts so tests can inject
 * every side effect through DelegationDeps; index.ts only registers them.
 * Results are plain sentences: tier 0 relays them to the user as they are.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { getProviderOrNative, readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";
import { resolveCap } from "../../workers/capacity.js";
import { isLocalProvider } from "../../workers/policy.js";
import { dirtyConflicts, loadPlan, PlanError, runLogPath, type Plan } from "../../workers/plan.js";
import { dirtyPaths } from "../../workers/plan-deps.js";
import { planStatus, readRunLog, renderSchedule, resumeState, tail, type RunLogEntry } from "../../workers/plan-runner.js";
import { again, loadSettings, move, queueStatePath, QueueStore, type QueueItem, type QueueSettings } from "../../workers/queue.js";
import { acceptItems } from "../../workers/queue-runner.js";
import { branchDiff, realQueueDeps } from "../../workers/queue-deps.js";
import { reportOrigin, startDetached, type DetachRequest } from "../../workers/run-report-wiring.js";
import type { RunOrigin, RunRecord } from "../../workers/run-events.js";
import type { WorkerToolResult } from "./worker-model.js";

export type { WorkerToolResult };

export interface PlanPartInput {
  id: string;
  spec: string;
  files?: string[];
  proof?: string;
  depends_on?: string[];
  risky?: boolean;
}

export interface PlanUnitInput {
  id: string;
  preamble?: string;
  unit_check?: string;
  parts: PlanPartInput[];
}

export interface PlanInput {
  gate: string;
  provider?: string;
  max_parallel?: number;
  preamble?: string;
  units: PlanUnitInput[];
}

/** Every side effect of the tools; tests replace what they need. */
export interface DelegationDeps {
  /** Project slug or folder -> absolute checkout path. */
  resolveProject(project: string): Promise<string>;
  /** Default local provider name and its parallel cap. */
  provider(settings: QueueSettings): { name: string; cap: number };
  dirtyPaths(repo: string): Promise<string[]>;
  /** Hand a plan/queue run to a detached process (same path as `pai plan|queue run --detach`). */
  detach(req: DetachRequest): RunRecord;
  accept(store: QueueStore, settings: QueueSettings, ids: string[], repo: string): ReturnType<typeof acceptItems>;
  branchDiff(repo: string, workerId: string): Promise<string>;
  /** Calling session: where the run's events are delivered. */
  origin(): RunOrigin | null;
  now(): number;
}

const text = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }] });
const error = (e: unknown): WorkerToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});
const fail = (s: string): WorkerToolResult => error(new Error(s));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function localProvider(settings: QueueSettings): { name: string; cap: number } {
  try {
    const w = readWorkersSection().workers;
    const local = (n: string) => {
      const p = getProviderOrNative(w, n);
      return p && isLocalProvider(p.baseUrl) ? p : undefined;
    };
    const name = settings.provider ?? (w.active && w.active !== "auto" && local(w.active) ? w.active : Object.keys(w.providers).find((n) => local(n))) ?? "local";
    const p = getProviderOrNative(w, name);
    return { name, cap: resolveCap(p?.maxConcurrent, p ? isLocalProvider(p.baseUrl) : true) ?? 3 };
  } catch {
    return { name: settings.provider ?? "local", cap: 3 };
  }
}

export function realDelegationDeps(): DelegationDeps {
  return {
    async resolveProject(project) {
      if (existsSync(project)) return resolve(project);
      const { getProject } = await import("../../cli/impl/project/helpers.js");
      const row = await getProject(project);
      if (!row) throw new Error(`no project "${project}" is registered`);
      return row.root_path;
    },
    provider: localProvider,
    dirtyPaths,
    detach: (req) => startDetached(workersLogDir(readWorkersSection().workers), req),
    accept: (store, settings, ids, repo) => acceptItems(store, settings, ids, realQueueDeps(workersLogDir(readWorkersSection().workers), repo)),
    branchDiff,
    origin: () => reportOrigin(),
    now: Date.now,
  };
}

const planDir = (repo: string, name: string): string => join(repo, ".pai", "plans", name);
const planFile = (repo: string, name: string): string => join(planDir(repo, name), "plan.yaml");

function loadNamedPlan(repo: string, name: string): { path: string; plan: Plan } {
  if (!NAME_RE.test(name)) throw new Error(`plan name "${name}" must be letters, digits, dot, dash or underscore`);
  const path = planFile(repo, name);
  if (!existsSync(path)) throw new Error(`no plan "${name}" in ${repo}; save it first with plan_save`);
  return { path, plan: loadPlan(path) };
}

const problemsText = (e: unknown): string => (e instanceof PlanError ? e.problems.map((p) => `- ${p}`).join("\n") : e instanceof Error ? e.message : String(e));

const parallelOf = (plan: Plan, cap: number, requested?: number): number => requested ?? plan.maxParallel ?? cap;

// ---------------------------------------------------------------------------
// plan_*

/** Write plan.yaml + one spec file per part, validate, describe the schedule. */
export async function planSave(args: { project: string; name: string; plan: PlanInput }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    const { name, plan: input } = args;
    if (!NAME_RE.test(name)) return fail(`plan name "${name}" must be letters, digits, dot, dash or underscore`);
    if (!input || !Array.isArray(input.units) || !input.units.length) return fail("the plan needs at least one unit with parts");
    if (!input.gate?.trim()) return fail("the plan needs a gate: the shell command that must pass on the merged tree");
    const repo = await deps.resolveProject(args.project);
    const dir = planDir(repo, name);
    const specs = join(dir, "specs");
    mkdirSync(specs, { recursive: true });

    const writeSpec = (id: string, body: string): string => {
      if (!NAME_RE.test(id)) throw new Error(`part id "${id}" must be letters, digits, dot, dash or underscore`);
      const rel = join("specs", `${id}.md`);
      writeFileSync(join(dir, rel), body.trim() + "\n", "utf8");
      return rel;
    };
    const writePre = (key: string, body: string): string => {
      const rel = join("specs", `_${key}.md`);
      writeFileSync(join(dir, rel), body.trim() + "\n", "utf8");
      return rel;
    };

    const settings = loadSettings(repo);
    const doc: Record<string, unknown> = {
      job: name,
      repo: "../../..",
      gate: input.gate.trim(),
      provider: input.provider ?? deps.provider(settings).name,
      ...(input.max_parallel ? { max_parallel: input.max_parallel } : {}),
      ...(input.preamble?.trim() ? { preamble: writePre("plan", input.preamble) } : {}),
      units: input.units.map((u) => ({
        id: u.id,
        ...(u.preamble?.trim() ? { preamble: writePre(`unit-${u.id}`, u.preamble) } : {}),
        ...(u.unit_check ? { unit_check: u.unit_check } : {}),
        parts: (u.parts ?? []).map((p) => ({
          id: p.id,
          spec: writeSpec(p.id, p.spec ?? ""),
          ...(p.files?.length ? { files: p.files } : {}),
          ...(p.proof ? { proof: p.proof } : {}),
          ...(p.depends_on?.length ? { depends_on: p.depends_on } : {}),
          ...(p.risky ? { risky: true } : {}),
        })),
      })),
    };
    const path = planFile(repo, name);
    writeFileSync(path, yamlStringify(doc), "utf8");

    let plan: Plan;
    try {
      plan = loadPlan(path);
    } catch (e) {
      return fail(`The plan was written to ${path} but is not valid:\n${problemsText(e)}\nFix these and call plan_save again.`);
    }
    const n = plan.units.flatMap((u) => u.parts).length;
    const par = parallelOf(plan, deps.provider(settings).cap);
    const warn = plan.warnings.length ? `\nWarnings:\n${plan.warnings.map((w) => `- ${w}`).join("\n")}` : "";
    return text(`Plan "${name}" saved and valid: ${plan.units.length} units, ${n} parts, ${par} at a time on ${plan.provider}.\n${renderSchedule(plan, { parallel: par })}${warn}\nStart it with plan_run.`);
  } catch (e) {
    return error(e);
  }
}

/** Start the run in the background and return at once. */
export async function planRun(args: { project: string; name: string; escalate?: boolean }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    const repo = await deps.resolveProject(args.project);
    let loaded: { path: string; plan: Plan };
    try {
      loaded = loadNamedPlan(repo, args.name);
    } catch (e) {
      return fail(problemsText(e));
    }
    const { path, plan } = loaded;
    const clash = dirtyConflicts(plan, await deps.dirtyPaths(plan.repo));
    if (clash.length) return fail(`Not started: ${plan.repo} has uncommitted changes to files the plan touches (${clash.join(", ")}). Commit or stash them first.`);

    const log = runLogPath(path);
    const { merged } = resumeState(readRunLog(log));
    const total = plan.units.flatMap((u) => u.parts).length;
    const par = parallelOf(plan, deps.provider(loadSettings(repo)).cap);
    const origin = deps.origin();
    deps.detach({ kind: "plan", label: plan.job, positional: [path], opts: { parallel: par, ...(args.escalate ? { escalate: "sonnet" } : {}) }, cwd: repo, origin });
    return text(`Plan "${args.name}" started in the background${origin ? "" : " (no calling session found, events are not delivered)"}: ${total - merged.size} of ${total} parts to run, ${par} at a time${merged.size ? ` (${merged.size} already merged are skipped)` : ""}. Check progress with plan_status.`);
  } catch (e) {
    return error(e);
  }
}

const idList = (ids: string[]): string => (ids.length ? `${ids.length} (${ids.join(", ")})` : "none");

function lastNote(log: RunLogEntry[], part: string): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.part === part && e.event === "needs-decision" && e.note) return tail(e.note, 12);
  }
  return "";
}

export async function planStatusText(args: { project: string; name: string }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    const repo = await deps.resolveProject(args.project);
    let loaded: { path: string; plan: Plan };
    try {
      loaded = loadNamedPlan(repo, args.name);
    } catch (e) {
      return fail(problemsText(e));
    }
    const { path, plan } = loaded;
    const log = readRunLog(runLogPath(path));
    const st = planStatus(plan, log, deps.now());
    const secs = Math.round(st.wallMs / 1000);
    const total = plan.units.flatMap((u) => u.parts).length;
    const escalations = log.filter((e) => e.event === "escalate").length;
    const lines = [
      `Plan "${args.name}": ${st.done.length} of ${total} parts done.`,
      `Done: ${idList(st.done)}. Running: ${idList(st.running)}. Waiting: ${idList(st.waiting)}. Needs a decision: ${idList(st.needsDecision)}.`,
      `Wall time ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s, ${escalations} escalations.`,
    ];
    for (const id of st.needsDecision) {
      const note = lastNote(log, id);
      lines.push(`Part ${id} needs a decision${note ? `; the failure ended with:\n${note}` : ""}\nClarify it with plan_amend, then plan_run again.`);
    }
    return text(lines.join("\n"));
  } catch (e) {
    return error(e);
  }
}

/** Append a clarification to a part's spec; the next plan_run retries the part. */
export async function planAmend(args: { project: string; name: string; part: string; spec_append: string }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    if (!args.spec_append?.trim()) return fail("spec_append is empty; say what the worker should know or do differently");
    const repo = await deps.resolveProject(args.project);
    let loaded: { path: string; plan: Plan };
    try {
      loaded = loadNamedPlan(repo, args.name);
    } catch (e) {
      return fail(problemsText(e));
    }
    if (!loaded.plan.units.some((u) => u.parts.some((p) => p.id === args.part))) return fail(`Plan "${args.name}" has no part "${args.part}".`);
    const file = join(dirname(loaded.path), "specs", `${args.part}.md`);
    if (!existsSync(file)) return fail(`Part "${args.part}" has no spec file at ${file}; it was not saved with plan_save.`);
    writeFileSync(file, readFileSync(file, "utf8").trimEnd() + `\n\n## Clarification\n${args.spec_append.trim()}\n`, "utf8");
    return text(`Clarification added to part ${args.part}. Call plan_run to resume; merged parts are skipped.`);
  } catch (e) {
    return error(e);
  }
}

// ---------------------------------------------------------------------------
// queue_*

async function openQueue(project: string, deps: DelegationDeps): Promise<{ repo: string; store: QueueStore; settings: QueueSettings }> {
  const repo = await deps.resolveProject(project);
  return { repo, store: new QueueStore(queueStatePath(repo)), settings: loadSettings(repo) };
}

export async function queueAdd(args: { project: string; sentence: string; files?: string[]; image?: string }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    if (!args.sentence?.trim()) return fail("sentence is empty; describe the change in one sentence");
    const image = args.image ? resolve(args.image) : undefined;
    if (image && !existsSync(image)) return fail(`No such image: ${image}`);
    const { repo, store } = await openQueue(args.project, deps);
    const it = store.add(args.sentence.trim(), repo, { files: (args.files ?? []).map((f) => f.trim()).filter(Boolean), image });
    return text(`Queued as ${it.id}. Call queue_run to start the pending items.`);
  } catch (e) {
    return error(e);
  }
}

export async function queueRun(args: { project: string; escalate?: boolean }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    const { repo, store, settings } = await openQueue(args.project, deps);
    const pending = store.list().filter((i) => i.state === (args.escalate ? "cloud" : "pending"));
    if (!pending.length) return text(args.escalate ? "No items are marked for the cloud." : "Nothing is pending.");
    const prov = deps.provider(settings);
    deps.detach({ kind: "queue", label: basename(repo), positional: [], opts: { parallel: settings.maxParallel ?? prov.cap, ...(args.escalate ? { escalate: "sonnet" } : {}) }, cwd: repo, origin: deps.origin() });
    return text(`Started ${pending.length} item${pending.length === 1 ? "" : "s"} (${pending.map((i) => i.id).join(", ")}) in the background. Call queue_review in a few minutes.`);
  } catch (e) {
    return error(e);
  }
}

const one = (t: string, n = 80): string => {
  const s = t.replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

function describeReady(it: QueueItem): string {
  const stat = it.diff ? `${it.diff.files} files, ${it.diff.lines} lines changed\n${it.diff.stat}` : "no diff recorded";
  const gate = it.gate ? (it.gate.ok ? "gate passed" : `gate FAILED: ${tail(it.gate.output, 5)}`) : "no gate";
  return `${it.id}: ${one(it.text)}\n${stat}\n${gate}; proof: ${it.proof ?? "none"}`;
}

export async function queueReview(args: { project: string }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    const items = (await openQueue(args.project, deps)).store.list();
    const ready = items.filter((i) => i.state === "ready");
    const others = items.filter((i) => ["pending", "running", "too-big", "needs-decision", "cloud"].includes(i.state));
    const parts: string[] = [];
    parts.push(ready.length ? `${ready.length} ready for review:\n\n${ready.map(describeReady).join("\n\n")}` : "Nothing is ready for review.");
    if (others.length) parts.push("Not ready:\n" + others.map((i) => `${i.id}: ${i.state}${i.why ? ` (${one(i.why, 120)})` : ""} - ${one(i.text)}`).join("\n"));
    if (ready.length) parts.push("Decide per item: queue_accept, queue_reject or queue_again.");
    return text(parts.join("\n\n"));
  } catch (e) {
    return error(e);
  }
}

export async function queueAccept(args: { project: string; ids: string[] }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    if (!args.ids?.length) return fail("ids is empty; name the queue items to accept");
    const { repo, store, settings } = await openQueue(args.project, deps);
    const res = await deps.accept(store, settings, args.ids, repo);
    const ok = res.filter((r) => r.ok);
    const bad = res.filter((r) => !r.ok);
    const lines: string[] = [];
    if (ok.length) lines.push(`Merged: ${ok.map((r) => r.id).join(", ")}.`);
    for (const r of bad) lines.push(`${r.id} was not merged: ${r.note}`);
    return bad.length ? { content: [{ type: "text", text: lines.join("\n") }], isError: true } : text(lines.join("\n"));
  } catch (e) {
    return error(e);
  }
}

export async function queueReject(args: { project: string; ids: string[]; why?: string }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    if (!args.ids?.length) return fail("ids is empty; name the queue items to reject");
    const { store } = await openQueue(args.project, deps);
    const done: string[] = [];
    const bad: string[] = [];
    for (const id of args.ids) {
      try {
        move(store, id, "rejected", { why: args.why });
        done.push(id);
      } catch (e) {
        bad.push((e as Error).message);
      }
    }
    const lines = [];
    if (done.length) lines.push(`Rejected: ${done.join(", ")}.`);
    lines.push(...bad);
    return bad.length ? { content: [{ type: "text", text: lines.join("\n") }], isError: true } : text(lines.join("\n"));
  } catch (e) {
    return error(e);
  }
}

export async function queueAgain(args: { project: string; id: string; note: string }, deps: DelegationDeps): Promise<WorkerToolResult> {
  try {
    if (!args.note?.trim()) return fail("note is empty; say what is still wrong");
    const { repo, store } = await openQueue(args.project, deps);
    const it = store.get(args.id);
    if (!it) return fail(`No queue item ${args.id}.`);
    const diff = it.worker ? await deps.branchDiff(repo, it.worker).catch(() => undefined) : undefined;
    const n = again(store, args.id, args.note, diff || undefined);
    return text(n.state === "cloud" ? `${args.id} failed twice locally and is marked for the cloud; call queue_run with escalate to run it on Sonnet.` : `${args.id} is queued again with your note; call queue_run.`);
  } catch (e) {
    return error(e);
  }
}
