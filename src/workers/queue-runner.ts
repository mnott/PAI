/**
 * queue-runner.ts — drains the pending items of a queue. One worker branch per
 * item, never merged here: an item ends "ready" (diff, gate, proof, report),
 * "too-big", or "needs-decision" after one local retry. Accept merges.
 * Everything touching workers, git, shells or the clock goes through QueueDeps.
 */

import { withRunLock, queueLockPath, type LockDeps } from "./run-lock.js";
import { filesOverlap } from "./plan.js";
import { tail, type MergeOutcome, type StartRequest, type WorkerOutcome } from "./plan-runner.js";
import { classifySize, composeQueueSpec, move, type DiffInfo, type QueueItem, type QueueSettings, type QueueStore } from "./queue.js";

export interface QueueDeps {
  startWorker(req: Pick<StartRequest, "label" | "provider" | "tier" | "spec"> & { attempt: number; itemId: string }): Promise<WorkerOutcome>;
  /** Size and stat of worker/<id> against the checkout; commits = non-empty commits on it. */
  inspect(repo: string, workerId: string): Promise<DiffInfo & { commits: number }>;
  /** Run a shell command (gate, proof, install) in `cwd`. */
  sh(cmd: string, cwd: string): Promise<{ ok: boolean; output: string }>;
  merge(repo: string, workerId: string, gate: string): Promise<MergeOutcome>;
  /** The provider a queue value names: `local` becomes the running local server, any other name is returned unchanged. */
  resolveLocal(provider: string): Promise<string>;
  /** Stop the workers this runner has started (SIGTERM/SIGINT path). */
  stopActive?(): Promise<void>;
}

export interface QueueRunOptions {
  provider: string;
  parallel: number;
  /** Take "cloud" items and run them on Sonnet instead of the pending ones. */
  escalate?: boolean;
  /** Called after an item reached ready or needs-decision (the stored item). */
  onEvent?: (kind: "ready" | "needs-decision", item: QueueItem) => void;
  /** Lock/signal hooks, replaced by tests. */
  lockDeps?: LockDeps;
}

export interface QueueRunSummary {
  ready: string[];
  tooBig: string[];
  needsDecision: string[];
  spawnRefusal?: string;
}

const LOCAL_ATTEMPTS = 2;

/** Last non-empty stdout line of the proof command: the path (or value) it produced. */
export const proofValue = (out: string): string => out.trim().split("\n").pop()?.trim() ?? "";

export function runQueue(store: QueueStore, settings: QueueSettings, opts: QueueRunOptions, deps: QueueDeps): Promise<QueueRunSummary> {
  const running = new Set<string>();
  let aborted = false;
  const guarded: QueueDeps = {
    ...deps,
    startWorker: (req) => (aborted ? new Promise<WorkerOutcome>(() => undefined) : deps.startWorker(req).then((o) => (aborted ? new Promise<WorkerOutcome>(() => undefined) : o))),
  };
  // interrupted items go back to pending so the next run restarts them
  const onSignal = async (): Promise<void> => {
    aborted = true;
    await deps.stopActive?.();
    for (const id of running) if (store.get(id)?.state === "running") move(store, id, "pending");
  };
  return withRunLock(queueLockPath(store.path), "the queue", () => runQueueLocked(store, settings, opts, guarded, running), { ...opts.lockDeps, onSignal });
}

async function runQueueLocked(store: QueueStore, settings: QueueSettings, opts: QueueRunOptions, deps: QueueDeps, active: Set<string>): Promise<QueueRunSummary> {
  const summary: QueueRunSummary = { ready: [], tooBig: [], needsDecision: [] };
  const take = opts.escalate ? "cloud" : "pending";
  const queue = store.list().filter((i) => i.state === take);
  const running = new Map<string, { item: QueueItem; done: Promise<void> }>();
  const refusals = new Map<string, number>();
  let halted = false;

  const attemptItem = async (item: QueueItem): Promise<void> => {
    move(store, item.id, "running");
    active.add(item.id);
    // `local` as the queue's provider means resolveLocalProvider() at run
    // start — the loopback server that answers, never a provider picked by name.
    const localName = await deps.resolveLocal(opts.provider);
    const ladder: Array<{ tier: "local" | "sonnet"; provider: string }> = opts.escalate
      ? [{ tier: "sonnet", provider: "anthropic" }]
      : Array.from({ length: LOCAL_ATTEMPTS }, () => ({ tier: "local" as const, provider: localName }));
    let failure: string | undefined;
    for (let i = 0; i < ladder.length; i++) {
      const { tier, provider } = ladder[i];
      const out = await deps.startWorker({ itemId: item.id, label: `queue: ${item.id}`, spec: composeQueueSpec(item, settings, failure), provider, tier, attempt: i + 1 });
      if (!out.ok && out.spawnRefused) {
        failure = out.failure || "worker spawn refused";
        const n = (refusals.get(failure) ?? 0) + 1;
        refusals.set(failure, n);
        if (n >= 2) halted = true;
        break;
      }
      if (!out.ok && out.fatal) {
        failure = out.failure || "the worker could not be isolated";
        break;
      }
      if (!out.ok) {
        failure = out.failure || "the worker ended without a valid passing report";
        continue;
      }
      const d = await deps.inspect(item.repo, out.id);
      if (!d.commits) {
        failure = `no-commit: the worker branch has no commit. Git add the files you changed, then commit on the current branch and edit files only by relative path inside your worktree.`;
        continue;
      }
      const diff: DiffInfo = { files: d.files, lines: d.lines, stat: d.stat };
      const big = classifySize(diff, settings);
      if (big) {
        move(store, item.id, "too-big", { worker: out.id, diff, why: big, report: out.report });
        summary.tooBig.push(item.id);
        return;
      }
      let gate: { ok: boolean; output: string } | undefined;
      if (settings.gate && out.worktreeDir) {
        gate = await deps.sh(settings.gate, out.worktreeDir);
        gate = { ok: gate.ok, output: tail(gate.output, 20) };
        if (!gate.ok) {
          failure = `gate failed (${settings.gate}):\n${gate.output}`;
          continue;
        }
      }
      let proof: string | undefined;
      if (settings.proof && out.worktreeDir) {
        const p = await deps.sh(settings.proof, out.worktreeDir);
        proof = p.ok ? proofValue(p.output) : `proof failed: ${tail(p.output, 3)}`;
      }
      move(store, item.id, "ready", { worker: out.id, diff, gate, proof, report: out.report, why: undefined });
      summary.ready.push(item.id);
      opts.onEvent?.("ready", store.get(item.id) ?? item);
      return;
    }
    move(store, item.id, "needs-decision", { why: tail(failure ?? "", 10) });
    summary.needsDecision.push(item.id);
    opts.onEvent?.("needs-decision", store.get(item.id) ?? item);
  };

  for (;;) {
    const busy = [...running.values()].map((r) => r.item);
    for (const it of halted ? [] : queue) {
      if (running.size >= opts.parallel) break;
      if (running.has(it.id) || store.get(it.id)?.state !== take) continue;
      if (busy.some((b) => it.files.length && b.files.length && filesOverlap(b.files, it.files))) continue;
      busy.push(it);
      const done = attemptItem(it).finally(() => {
        running.delete(it.id);
        active.delete(it.id);
      });
      running.set(it.id, { item: it, done });
    }
    if (running.size === 0) break;
    await Promise.race([...running.values()].map((r) => r.done));
  }
  if (halted) summary.spawnRefusal = [...refusals.keys()].pop();
  return summary;
}

/** Merge ready items with the gate, then run the install command. A failed merge leaves the item ready. */
export async function acceptItems(
  store: QueueStore,
  settings: QueueSettings,
  ids: string[],
  deps: Pick<QueueDeps, "merge" | "sh">,
): Promise<Array<{ id: string; ok: boolean; note: string }>> {
  const results: Array<{ id: string; ok: boolean; note: string }> = [];
  for (const id of ids) {
    const it = store.get(id);
    if (!it || it.state !== "ready" || !it.worker) {
      results.push({ id, ok: false, note: it ? `${id} is ${it.state}, not ready` : `no queue item ${id}` });
      continue;
    }
    const m = await deps.merge(it.repo, it.worker, settings.gate ?? "");
    if (!m.ok) {
      const note = tail(m.output, 10);
      store.update(id, { why: note });
      results.push({ id, ok: false, note });
      continue;
    }
    move(store, id, "accepted", { why: undefined });
    let note = "merged";
    if (settings.install) {
      const r = await deps.sh(settings.install, it.repo);
      note = r.ok ? "merged, installed" : `merged, install failed: ${tail(r.output, 5)}`;
    }
    results.push({ id, ok: true, note });
  }
  return results;
}
