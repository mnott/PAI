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
    reportValid: st.reportValid,
    failureWhy: failureWhy ?? undefined,
    keptForReview,
  });
  if (!plan) return null;
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
        ...relaunchOptions(a.opts, {}),
        providerFlag: o.providerFlag,
        modelFlag: o.modelFlag,
        label: o.label,
        claudeArgs: a.opts.claudeArgs.map((x) => (!swapped && x === p0 ? ((swapped = true), o.prompt) : x)),
        _escalatedFrom: o.escalatedFrom,
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

/** Re-run a failed local run once on the cloud, as a fresh run (never another pool spare of the local key). */
export function rerunOnCloud(a: ExecuteArgs, wid: string, why: string, st: WorkerStatus): Promise<number> {
  const { logDir } = a;
  appendLedger(ledgerPath(logDir), "WORKER-FALLTHROUGH", { id: wid, reason: why });
  process.stderr.write(`pai worker: ${wid} on ${a.target.providerName} ended badly (${why}) — re-running on the cloud\n`);
  return (a.runner ?? runWorker)({
    providerFlag: ANTHROPIC_NATIVE,
    label: `${a.label} (fall-through)`,
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
    _route: { policy: a.route!.policy, reason: `fall-through (${why})`, local: false },
    _fallThroughOf: wid,
    onWorkerStart: (id2) => {
      st.fallThroughTo = id2;
      saveStatus(logDir, st);
      a.onWorkerStart?.(id2);
    },
  });
}
