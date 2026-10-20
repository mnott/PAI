/**
 * escalate-run.ts — carries out an EscalationPlan (escalation.ts) with injected effects.
 *
 * t2 -> t1: ledger ESCALATE, status line, then re-run the task on the first
 * model of the tier above with the handoff summary prepended to the task (the
 * ended run's commits stay on its branch). t1 -> t0: the session gets the
 * summary as a session message (never PAILot) and the run ends "~" with
 * "escalated to session".
 */
import { ledgerEscalate, sessionNote, withSummary, type EscalationPlan, type Tier } from "./escalation.js";
import { parseEntry } from "./route-lists.js";

export interface EscalateRunDeps {
  ledger: string;
  id: string;
  label: string;
  /** The ended run's spec text. */
  spec: string;
  fromModel?: string;
  /** Persist the status line on the ended run ("escalated t2→t1: context 74%"). */
  markEscalated: (line: string, from: Tier) => void;
  /** Start the re-run; resolves to its exit code; resolves its worker id through onStarted. */
  rerun: (o: {
    providerFlag: string;
    modelFlag?: string;
    prompt: string;
    label: string;
    escalatedFrom: Tier[];
    onStarted: (newId: string) => void;
  }) => Promise<number>;
  /** Session message to the owning session (never PAILot). */
  notifySession: (text: string) => Promise<void>;
}

export type EscalateOutcome =
  | { kind: "rerun"; rc: number }
  | { kind: "session"; report: { result: "~"; why: string; notes: string } };

export async function runEscalation(plan: EscalationPlan, escalatedFrom: Tier[], d: EscalateRunDeps): Promise<EscalateOutcome> {
  const { action } = plan;
  if (action.action === "none") throw new Error("runEscalation: nothing to escalate");
  const entry = action.to.models[0];
  const target = entry ? parseEntry(entry) : undefined;
  d.markEscalated(plan.line, action.from);
  if (action.action === "session" || !target) {
    ledgerEscalate(d.ledger, { id: d.id, from: action.from, to: action.to.id, fromModel: d.fromModel, reason: plan.trigger.reason });
    await d.notifySession(sessionNote(plan.summary, d.label));
    return { kind: "session", report: { result: "~", why: "escalated to session", notes: `escalated to session\n${plan.summary}` } };
  }
  let newId: string | undefined;
  const ledgerLine = (toId?: string) =>
    ledgerEscalate(d.ledger, {
      id: d.id,
      from: action.from,
      to: action.to.id,
      fromModel: d.fromModel,
      toModel: target ? entry : undefined,
      reason: plan.trigger.reason,
      toId,
    });
  try {
    const rc = await d.rerun({
      providerFlag: target.provider,
      ...(target.model ? { modelFlag: target.model } : {}),
      prompt: withSummary(plan.summary, d.spec),
      label: `${d.label} (escalated ${action.from}→${action.to.id})`,
      escalatedFrom: [...escalatedFrom, action.from],
      onStarted: (id) => {
        newId = id;
        // the escalated run exists: ledger it with its id before it can end
        ledgerLine(id);
      },
    });
    if (!newId) ledgerLine();
    return { kind: "rerun", rc };
  } catch (e) {
    // the re-run could not start: still ledger the escalation (never silently)
    if (!newId) ledgerLine();
    throw e;
  }
}
