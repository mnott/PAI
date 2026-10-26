/**
 * run/escalate.ts — one-tier-up escalation and the local-to-cloud re-run, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { readToolErrors, harnessToolErrorTexts } from "../tool-errors.js";
import { parseRunnerArgs } from "../args.js";
import { ANTHROPIC_NATIVE, getProviderOrNative } from "../config.js";
import { isLoopbackProvider } from "../run-env.js";
import { appendLedger } from "../ledger.js";
import { ledgerPath } from "../paths.js";
import { type WorkerStatus, saveStatus, UNLABELED } from "../status.js";
import { planEscalation } from "../escalation.js";
import { runEscalation } from "../escalate-run.js";
import { localFailures } from "../route-classifier.js";
import { type WorkerReport } from "../report.js";
import { type ExecuteArgs } from "./types.js";
import { relaunchOptions } from "./finalise.js";
import { runWorker } from "./worker-ref.js";

/**
 * Escalation one tier up (escalation.ts) for a run that just ended: context over the
 * configured fraction, a missing tool, or repeated failure. Resolves to the exit code
 * of the re-run (t2 -> t1, whose spec starts with the salvage merge of the ended
 * run's branch), or null when the run stays (no tiers configured, no trigger, kept
 * for review, already escalated out of this tier); a t1 -> t0 escalation messages the
 * owning session (never PAILot) and turns the report into r=~ "escalated to session"
 * in place.
 */
export async function tryEscalate(
  a: ExecuteArgs,
  wid: string,
  st: WorkerStatus,
  report: WorkerReport | null,
  resultText: string | undefined,
  commits: string[],
  failureWhy: string | null,
  keptForReview = false
): Promise<number | null> {
  const { logDir, config } = a;
  if (!a.parsed.headless || !config.tiers?.length) return null;
  const label = a.label ?? st.label ?? UNLABELED;
  const failed = st.state === "failed" || !!failureWhy;
  const plan = planEscalation({
    tiers: config.tiers,
    cfg: config.escalate,
    className: a.className,
    state: { from: a.escalatedFrom ?? [] },
    id: wid,
    label,
    done: report?.notes ?? resultText,
    commits,
    branch: st.branch ?? undefined,
    contextTokens: st.contextTokens,
    contextWindow: st.contextWindow,
    resultText,
    reportText: [report?.notes, report?.why].filter(Boolean).join("\n"),
    toolErrors: harnessToolErrorTexts(readToolErrors(logDir).filter((r) => r.worker === wid)),
    failures: failed ? localFailures(ledgerPath(logDir), label, (p) => { const c = getProviderOrNative(config, p); return !!c && isLoopbackProvider(c); }) + (st.rc === 0 ? 1 : 0) : 0,
    loopStopped: st.loopStopped,
    timedOut: st.timedOut,
    reportValid: st.reportValid,
    failureWhy: failureWhy ?? undefined,
    keptForReview,
  });
  if (!plan) return null;
  // Budget rule (docs/concepts/escalation.md): an absolute --deadline that has passed starts nothing;
  // --max-minutes hands the re-run what is left of the original budget, none when it is spent.
  const limit = a.limit ?? null;
  const now = Date.now();
  if (limit?.absolute && limit.deadlineAt <= now) {
    process.stderr.write(`pai worker: ${wid} escalation not started — the --deadline has passed\n`);
    appendLedger(ledgerPath(logDir), "WORKER-ESCALATE-SKIPPED", { id: wid, reason: "deadline passed" });
    return null;
  }
  const remaining = limit && !limit.absolute ? Math.ceil((limit.deadlineAt - now) / 60_000) : undefined;
  if (remaining !== undefined && remaining <= 0) {
    process.stderr.write(`pai worker: ${wid} escalation not started — the --max-minutes budget is spent\n`);
    appendLedger(ledgerPath(logDir), "WORKER-ESCALATE-SKIPPED", { id: wid, reason: "budget spent" });
    return null;
  }
  const out = await runEscalation(plan, a.escalatedFrom ?? [], {
    ledger: ledgerPath(logDir),
    id: wid,
    label,
    spec: a.parsed.prompt ?? "",
    fromModel: st.model,
    markEscalated: (line) => {
      st.escalated = line;
      st.last = line;
      saveStatus(logDir, st);
    },
    rerun: (o) => {
      const p0 = parseRunnerArgs(a.opts.claudeArgs).prompt;
      let swapped = false;
      return (a.runner ?? runWorker)({
        // the target tier's own route: a --local run must not drag the local server into the cloud tier
        ...relaunchOptions(a.opts, {
          localFlag: undefined,
          localName: undefined,
          ...(remaining !== undefined ? { maxMinutes: remaining, deadline: undefined } : {}),
        }),
        providerFlag: o.providerFlag,
        modelFlag: o.modelFlag,
        label: o.label,
        claudeArgs: a.opts.claudeArgs.map((x) => (!swapped && x === p0 ? ((swapped = true), o.prompt) : x)),
        _escalatedFrom: o.escalatedFrom,
        _priorIds: [...(a.priorIds ?? []), wid],
        _route: undefined,
        onWorkerStart: (id2) => {
          st.escalatedTo = id2;
          saveStatus(logDir, st);
          o.onStarted(id2);
          a.onWorkerStart?.(id2);
        },
      });
    },
    notifySession: async (text) => {
      const target = st.session?.id || st.session?.name || st.sessionKey;
      if (!target) return;
      const { sendToSession } = await import("../../cli/lib/aibroker-client.js");
      await sendToSession(target, text, undefined, { noReply: true });
    },
  });
  if (out.kind === "rerun") return out.rc;
  if (report) Object.assign(report, out.report);
  st.claimsContinue = true;
  saveStatus(logDir, st);
  return null;
}

/** Whether the run ended on a loopback provider: the provider that ran, the route only when the provider is unknown. */
export function ranLocal(a: ExecuteArgs, st: WorkerStatus): boolean {
  const p = a.config?.providers ? getProviderOrNative(a.config, st.provider) : undefined;
  return p ? isLoopbackProvider(p) : !!a.route?.local;
}

/** Where a restart goes: the fall-through's cloud, or any provider (reroute, supervision escalation). */
export interface RerunTarget {
  provider: string;
  model?: string;
}

export const CLOUD: RerunTarget = { provider: ANTHROPIC_NATIVE };

/** The run a restart repeats: an ExecuteArgs, or what a status keeps of one (reroute.ts builds it for a run in another process). */
export type RerunSource = Pick<ExecuteArgs, "logDir" | "cwd" | "claudeArgs" | "label"> &
  Partial<Pick<ExecuteArgs, "opts" | "mcpFlag" | "specPath" | "parent" | "stage" | "quiet" | "worktreeFlag" | "className" | "route" | "priorIds" | "runner" | "onWorkerStart">> & {
    target?: { providerName: string };
  };

/**
 * Start the same task again on `to` as a fresh run (never another pool spare of the local key) and link the two runs:
 * the ledger line, the new run's _fallThroughOf/_priorIds and `st.fallThroughTo`. The one restart path of the
 * local-to-cloud fall-through (`to` = the cloud) and of reroute / the supervision escalation (any provider).
 */
export function rerunOn(a: RerunSource, wid: string, why: string, st: WorkerStatus, to: RerunTarget = CLOUD): Promise<number> {
  const { logDir } = a;
  const where = to === CLOUD ? "the cloud" : to.provider;
  appendLedger(ledgerPath(logDir), "WORKER-FALLTHROUGH", { id: wid, reason: why, ...(to === CLOUD ? {} : { to: to.provider }) });
  process.stderr.write(`pai worker: ${wid} on ${a.target?.providerName ?? st.provider} ended badly (${why}) — re-running on ${where}\n`);
  return (a.runner ?? runWorker)({
    providerFlag: to.provider,
    ...(to.model ? { modelFlag: to.model } : {}),
    label: `${a.label} (${to === CLOUD ? "fall-through" : "rerouted"})`,
    noPool: a.opts?.noPool,
    mcpFlag: a.mcpFlag,
    cwd: a.cwd,
    specPath: a.specPath,
    parent: a.parent,
    stage: a.stage,
    claudeArgs: a.claudeArgs,
    quiet: a.quiet,
    worktreeFlag: a.worktreeFlag,
    className: a.className,
    _route: { policy: a.route?.policy ?? "auto", reason: `${to === CLOUD ? "fall-through" : "rerouted"} (${why})`, local: false },
    _fallThroughOf: wid,
    ...(st.term ? { _hostTerm: st.term } : {}),
    _priorIds: [...(a.priorIds ?? []), wid],
    onWorkerStart: (id2) => {
      st.fallThroughTo = id2;
      saveStatus(logDir, st);
      a.onWorkerStart?.(id2);
    },
  });
}
