/**
 * escalation.ts — one escalation path, one tier up.
 *
 * Tiers come from workers.yaml `tiers:` (route-lists.ts TierDef): t0 the
 * interactive session, t1 orchestrator, t2 worker. A run escalates when (a)
 * its context passes escalate.contextFraction of the model's window or the
 * engine rejects the prompt as too long, (b) a tool it needs is missing (tool
 * call refused / MCP server absent / report says `needs-tool: <name>`), or
 * (c) it failed `escalate.failures` times on the same task (loop-guard stop,
 * invalid report, failed checks), or (d) the loop guard stopped it after it
 * left committed or salvaged work: that escalates at once, without waiting for
 * a second failure (trigger `loop-stop`, off by removing it from the list); the
 * same holds for a run stopped by its time limit (--max-minutes / --deadline;
 * trigger `deadline`). t2 -> t1 re-runs the task on the tier above
 * with a handoff summary prepended and the salvage merge instruction first —
 * the ended run's commits stay on its branch and the escalated run merges
 * them ("Continue, do not restart: first git merge <branch>"); t1 -> t0
 * messages the owning session (never PAILot) and ends the run "~". A run kept
 * for review (it committed) is not escalated. At most one escalation per tier
 * per task, so nothing ping-pongs. Every threshold is config
 * (workers.escalate), never a code constant.
 */
import { appendLedger } from "./ledger.js";
import type { TierDef } from "./route-lists.js";

export type TriggerKind = "context" | "missing-tool" | "repeated-failure" | "loop-stop" | "deadline";
export type { TierDef };

export type Tier = string;

export interface EscalateConfig {
  enabled: boolean;
  /** Fraction (0..1] of the model's context window that triggers escalation. */
  contextFraction: number;
  /** Failed attempts of one task that escalate it. */
  failures: number;
  /** Which triggers are on. */
  triggers: TriggerKind[];
  /** The cloud target of a plan/queue escalation and of `pai worker help`: tier label, provider name, model alias. */
  cloud: CloudTarget;
}

export interface CloudTarget {
  tier: string;
  provider: string;
  model: string;
}

const ALL_TRIGGERS: TriggerKind[] = ["context", "missing-tool", "repeated-failure", "loop-stop", "deadline"];

/** Fallbacks of the escalate block when workers.yaml omits a key; the shipped defaults file carries the policy values. */
export const DEFAULT_ESCALATE: EscalateConfig = { enabled: true, contextFraction: 0.7, failures: 2, triggers: ALL_TRIGGERS, cloud: { tier: "sonnet", provider: "anthropic", model: "sonnet" } };

/** Failed local attempts that escalate a task (the route classifier's rule, now this one). */
export const ESCALATE_FAILURES = DEFAULT_ESCALATE.failures;

/** Tier id of a class: the tier listing it, else the default tier; null when no tiers are configured. */
export function tierOf(tiers: TierDef[], className: string | undefined | null): Tier | null {
  if (!tiers.length) return null;
  const hit = className ? tiers.find((t) => t.classes?.includes(className)) : undefined;
  return (hit ?? tiers.find((t) => t.default))?.id ?? null;
}

/** The tier above `id` in config order, or null at the top. */
export function tierAbove(tiers: TierDef[], id: Tier): TierDef | null {
  const i = tiers.findIndex((t) => t.id === id);
  return i > 0 ? tiers[i - 1] : null;
}

export interface Trigger {
  kind: TriggerKind;
  /** Short reason, e.g. "context 74%". */
  reason: string;
}

export interface TriggerInput {
  contextTokens?: number | null;
  contextWindow?: number | null;
  /** Escalate config; defaults apply to what it omits. */
  cfg?: EscalateConfig;
  /** Engine / result text of the run's end. */
  resultText?: string;
  /** Raw text of failed tool results. */
  toolErrors?: string[];
  /** Free text of the worker's report (notes / why). */
  reportText?: string;
  /** Failed attempts of this task so far, this one included. */
  failures?: number;
  loopStopped?: boolean;
  /** The run was stopped by its time limit (--max-minutes / --deadline). */
  timedOut?: boolean;
  /** Commit lines the run left on its branch (salvage commits included). */
  commits?: string[];
  /** Uncommitted edits were salvaged into a commit on exit. */
  salvaged?: boolean;
  reportValid?: boolean;
  checksFailed?: boolean;
}

const TOO_LONG = /prompt is too long|context[_ ]length|maximum context|context window (?:exceeded|limit)|exceeds the (?:model'?s )?(?:max|context)/i;
const TOOL_MISSING = /no such tool available|tool not found|not allowed to use|tool .{0,40}is not allowed|mcp server .{0,60}(?:not found|not connected|unavailable|failed)|permission to use .{0,40}has been denied/i;
const NEEDS_TOOL = /needs-tool:\s*([^\s;,]+)/i;

export function contextPercentOf(tokens: number | null | undefined, window: number | null | undefined): number | null {
  if (!tokens || !window) return null;
  return Math.round((tokens / window) * 100);
}

/** First trigger that applies, in order: context, missing tool, loop stop or time limit with saved work, repeated failure; null when none. */
export function detectTrigger(i: TriggerInput): Trigger | null {
  const cfg = i.cfg ?? DEFAULT_ESCALATE;
  const frac = cfg.contextFraction;
  const on = (k: TriggerKind) => cfg.triggers.includes(k);
  const pct = contextPercentOf(i.contextTokens, i.contextWindow);
  if (on("context") && i.contextTokens && i.contextWindow && i.contextTokens > frac * i.contextWindow) {
    return { kind: "context", reason: `context ${pct}%` };
  }
  if (on("context") && i.resultText && TOO_LONG.test(i.resultText)) return { kind: "context", reason: "prompt too long" };
  const needs = on("missing-tool") ? i.reportText?.match(NEEDS_TOOL)?.[1] : undefined;
  if (needs) return { kind: "missing-tool", reason: `missing tool ${needs}` };
  for (const e of on("missing-tool") ? (i.toolErrors ?? []) : []) {
    if (TOOL_MISSING.test(e)) return { kind: "missing-tool", reason: `missing tool: ${e.replace(/\s+/g, " ").slice(0, 80)}` };
  }
  if (on("loop-stop") && i.loopStopped) {
    return { kind: "loop-stop", reason: (i.commits?.length ?? 0) > 0 || i.salvaged ? "loop-guard stop with saved work" : "loop-guard stop" };
  }
  if (on("deadline") && i.timedOut) {
    return { kind: "deadline", reason: (i.commits?.length ?? 0) > 0 || i.salvaged ? "time limit reached with saved work" : "time limit reached" };
  }
  if (on("repeated-failure") && (i.failures ?? 0) >= cfg.failures) {
    const what = i.loopStopped ? "loop-guard stop" : i.timedOut ? "time limit" : i.reportValid === false ? "invalid report" : i.checksFailed ? "failed checks" : "failed run";
    return { kind: "repeated-failure", reason: `${what}, ${i.failures} failures` };
  }
  return null;
}

export interface EscalationState {
  /** Tiers this task already escalated out of. */
  from: Tier[];
}

export type EscalationAction =
  | { action: "none" }
  | { action: "rerun"; from: Tier; to: TierDef }
  | { action: "session"; from: Tier; to: TierDef };

/** What to do with a trigger: re-run one tier up, tell the session, or nothing (disabled / already escalated out of this tier / no tier above). */
export function decideEscalation(
  tiers: TierDef[],
  tier: Tier | null,
  trigger: Trigger | null,
  state: EscalationState,
  cfg: EscalateConfig = DEFAULT_ESCALATE
): EscalationAction {
  if (!cfg.enabled || !trigger || !tier) return { action: "none" };
  const to = tierAbove(tiers, tier);
  if (!to || state.from.includes(tier)) return { action: "none" };
  return to.session || !to.models.length ? { action: "session", from: tier, to } : { action: "rerun", from: tier, to };
}

export interface SummaryInput {
  id: string;
  label: string;
  from: Tier;
  to: Tier;
  trigger: Trigger;
  done?: string;
  commits: string[];
  branch?: string;
}

/** The salvage merge line of an escalated re-run's spec (the manual escalations' wording). */
export function salvageMergeLine(branch: string): string {
  return `Continue, do not restart: first git merge ${branch} — the work already done is on that branch.`;
}

/** Handoff summary: what was done, the commits, why it escalated. */
export function escalationSummary(s: SummaryInput): string {
  return [
    `[escalated ${s.from}→${s.to}: ${s.trigger.reason}] Task "${s.label}" was started by run ${s.id} and handed up.`,
    s.branch && s.commits.length ? salvageMergeLine(s.branch) : "Continue from where the run stopped; do not restart from scratch.",
    `Done so far: ${s.done?.trim() || "(no report)"}`,
    s.commits.length ? `Commits kept${s.branch ? ` on ${s.branch}` : ""}:\n${s.commits.map((c) => `- ${c}`).join("\n")}` : "Commits: none.",
    `Why: ${s.trigger.reason} (${s.trigger.kind}). Continue from the committed work; do not restart from scratch.`,
  ].join("\n");
}

export function withSummary(summary: string, spec: string): string {
  return `${summary}\n\n---\n\n${spec}`;
}

/** Pane status line / ps mark: "escalated t2→t1: context 74%". */
export function escalatedLine(from: Tier, to: Tier, reason: string): string {
  return `escalated ${from}→${to}: ${reason}`;
}

/** Session message of a t1 -> t0 escalation. */
export function sessionNote(summary: string, label: string): string {
  return `[pai escalation] ${label}\n${summary}`;
}

/** WORKER-ESCALATE ledger line: from/to tier+model and the reason. */
export function ledgerEscalate(
  ledger: string,
  e: { id: string; from: Tier; to: Tier; fromModel?: string; toModel?: string; reason: string; toId?: string }
): void {
  appendLedger(ledger, "WORKER-ESCALATE", {
    id: e.id,
    from: `${e.from}${e.fromModel ? `/${e.fromModel}` : ""}`,
    to: `${e.to}${e.toModel ? `/${e.toModel}` : ""}`,
    reason: e.reason,
    ...(e.toId ? { toId: e.toId } : {}),
  });
}

type Bad = (path: string, msg: string) => never;

/** Parse workers.escalate; throws via `bad` on a wrong type. */
export function parseEscalate(v: unknown, bad: Bad): EscalateConfig {
  const out = { ...DEFAULT_ESCALATE, cloud: { ...DEFAULT_ESCALATE.cloud } };
  if (v === undefined) return out;
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(".escalate", "must be an object");
  const t = v as Record<string, unknown>;
  if (t.enabled !== undefined) {
    if (typeof t.enabled !== "boolean") bad(".escalate.enabled", "must be true or false");
    out.enabled = t.enabled as boolean;
  }
  if (t.contextFraction !== undefined) {
    const f = t.contextFraction;
    if (typeof f !== "number" || !(f > 0 && f <= 1)) bad(".escalate.contextFraction", "must be a number above 0 and at most 1");
    out.contextFraction = f as number;
  }
  if (t.failures !== undefined) {
    const f = t.failures;
    if (typeof f !== "number" || !Number.isInteger(f) || f < 1) bad(".escalate.failures", "must be a positive integer");
    out.failures = f as number;
  }
  if (t.triggers !== undefined) {
    if (!Array.isArray(t.triggers) || t.triggers.some((x) => !ALL_TRIGGERS.includes(x as TriggerKind))) {
      bad(".escalate.triggers", `must be a list of: ${ALL_TRIGGERS.join(", ")}`);
    }
    out.triggers = t.triggers as TriggerKind[];
  }
  if (t.cloud !== undefined) {
    if (typeof t.cloud !== "object" || t.cloud === null || Array.isArray(t.cloud)) bad(".escalate.cloud", "must be an object");
    const c = t.cloud as Record<string, unknown>;
    for (const k of ["tier", "provider", "model"] as const) {
      if (c[k] === undefined) continue;
      if (typeof c[k] !== "string" || !(c[k] as string).trim()) bad(`.escalate.cloud.${k}`, "must be a non-empty string");
      out.cloud[k] = (c[k] as string).trim();
    }
  }
  return out;
}

export interface PlanInput extends TriggerInput {
  tiers: TierDef[];
  cfg: EscalateConfig;
  className?: string;
  state: EscalationState;
  id: string;
  label: string;
  done?: string;
  commits: string[];
  branch?: string;
  /** A failure the caller already classified (fall-through reason); names a repeated failure. */
  failureWhy?: string;
  /** The run is kept for review (it committed): escalation must not re-run it. */
  keptForReview?: boolean;
}

export interface EscalationPlan {
  action: EscalationAction;
  trigger: Trigger;
  summary: string;
  line: string;
}

/** The whole decision for one ended run: trigger, action, summary, status line; null when it stays where it is. */
export function planEscalation(i: PlanInput): EscalationPlan | null {
  // a run kept for review (it committed, its report was invalid) stays: no
  // re-run upstairs either — the commits are the result to review
  // — except a run stopped by its time limit: it is kept for review only because
  // it committed, and that is exactly the saved work the deadline trigger hands up
  const tier = tierOf(i.tiers, i.className);
  const base = detectTrigger({ ...i, failures: i.failures });
  if (i.keptForReview && base?.kind !== "deadline" && base?.kind !== "loop-stop") return null;
  const trigger = (base?.kind === "repeated-failure" || base?.kind === "loop-stop" || base?.kind === "deadline") && i.failureWhy ? { ...base, reason: `${i.failureWhy}` } : base;
  const action = decideEscalation(i.tiers, tier, trigger, i.state, i.cfg);
  if (action.action === "none" || !trigger || !tier) return null;
  const summary = escalationSummary({ id: i.id, label: i.label, from: action.from, to: action.to.id, trigger, done: i.done, commits: i.commits, branch: i.branch });
  return { action, trigger, summary, line: escalatedLine(action.from, action.to.id, trigger.reason) };
}
