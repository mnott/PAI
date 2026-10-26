/**
 * evaluate.ts — the one in-process decision API for guard decisions.
 *
 * evaluate(event, ctx) decides; it does not know where the event came from. The Claude Code hooks, the worker
 * runner and (later) the model-API proxy map their input into a GuardEvent and act on the Decision. State, rules
 * and the firing sink arrive through the context, so the function runs without a hook process.
 *
 * Lives in src/guard/ rather than src/antipatterns/: it decides across categories (shell, tool-loop, final-text),
 * while src/antipatterns/ holds the lifecycle governance of single patterns.
 */

import { dispositionOf } from "../hooks/ts/lib/antipattern-lifecycle.js";
import { recordFiring, type FiringInput } from "../hooks/ts/lib/antipattern-log.js";
import { ruleLifecycle } from "../hooks/ts/lib/rules/load.js";
import { evaluateRules } from "../hooks/ts/lib/rules/eval.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";
import { stepLoopGuard, type EchoConfig, type LoopState, type LoopStep } from "../hooks/ts/lib/loop-guard.js";
import { unparsedCallDecision } from "../workers/run/unparsed-call.js";
import { decidePreGates, decideWorkerGate, scannedCommand, type GateSet } from "./gates.js";

export type GuardEvent =
  | { kind: "tool_call"; tool: string; input: unknown; cwd: string; workerId?: string; model?: string; provider?: string; sessionId?: string; source?: "hook" | "proxy" }
  | { kind: "final_text"; text: string; cwd?: string; workerId?: string; model?: string; provider?: string; sessionId?: string; source?: "hook" | "proxy" };

export interface Decision {
  action: "allow" | "deny" | "note" | "stop" | "continue";
  patternId?: string;
  message?: string;
  /** "monitor": the pattern matched but acts only as a record; `action` is then what it would have done (allow when nothing else decided). */
  mode?: "enforce" | "monitor";
  /** Shell rule hit: how the rule grades it (block and confirm both deny) and what it matched, for the adapter's security log. */
  rule?: { severity: Rule["severity"]; category: string; pattern?: string; timedOut?: boolean };
  /** Loop guard: the full step, whose next state the caller persists. */
  loop?: LoopStep;
  /** Final text: the tool name of the unparsed call, and the pattern version. */
  unparsed?: { name: string; version: number };
  /** Command gate hit: the category and matched invocation for the adapter's security log. */
  guard?: { category: string; pattern?: string };
  /** Allow that rewrites the call's input (clamped timeout, hang-probe, repaired edit). */
  updatedInput?: Record<string, unknown>;
}

export interface GuardContext {
  env: NodeJS.ProcessEnv;
  /** Shell rules to test a Bash command against; absent: the shell layer is skipped. */
  shellRules?: Rule[];
  /** Loop-guard state access; absent: the loop layer is skipped. */
  loop?: { state: LoopState; fingerprint?: string | null; now?: number; echo?: EchoConfig; /** Record FAIL ledger entries (workers.failLedger / PAI_FAIL_LEDGER). */ failLedger?: boolean };
  /** Pure command gates (plutil, worker git, Bash chain, worker guard); absent: skipped. */
  gates?: GateSet;
  /** Firing sink; defaults to the antipattern log. */
  record?: (f: FiringInput) => unknown;
}

const ALLOW: Decision = { action: "allow" };

/**
 * First block hit, else first confirm hit, else first warn hit. A rule in monitor mode (or retired, or excepted for
 * this command) is recorded and skipped: the next rule decides. Every acting hit is recorded in the firing log.
 */
function decideShell(command: string, ev: Extract<GuardEvent, { kind: "tool_call" }>, ctx: GuardContext): Decision {
  const record = ctx.record ?? recordFiring;
  let pool = ctx.shellRules ?? [];
  let monitored: Decision | null = null;
  while (pool.length) {
    const hit = evaluateRules(pool, "Bash", command);
    if (!hit) break;
    const lc = ruleLifecycle(hit.rule);
    const mode = dispositionOf(lc, command, ctx.env);
    const action = hit.rule.severity === "warn" ? "note" : "deny";
    if (mode !== "off") {
      record({ id: hit.rule.id, version: lc.version, category: "shell", action, mode, input: command, cwd: ev.cwd, sessionId: ev.sessionId, source: ev.source, model: ev.model, provider: ev.provider });
    }
    const rule = { severity: hit.rule.severity, category: hit.rule.category ?? hit.rule.id, pattern: hit.rule.match, timedOut: hit.timedOut };
    if (mode !== "enforce") {
      if (mode === "monitor") monitored ??= { action, patternId: hit.rule.id, mode: "monitor", rule };
      pool = pool.filter((r) => r !== hit.rule);
      continue;
    }
    return { action, patternId: hit.rule.id, mode: "enforce", rule };
  }
  return monitored ? { ...monitored, action: "allow" } : ALLOW;
}

function decideLoop(ev: Extract<GuardEvent, { kind: "tool_call" }>, ctx: GuardContext): Decision {
  const l = ctx.loop!;
  const command = (ev.input as { command?: unknown } | undefined)?.command;
  const input = ev.tool === "Bash" ? (typeof command === "string" ? command : undefined) : ((ev.input ?? {}) as Record<string, unknown>);
  const r = stepLoopGuard(l.state, ev.tool, input, l.fingerprint, l.now ?? Date.now(), ev.cwd, l.echo, l.failLedger, ev.source);
  if (r.monitored) return { action: "allow", patternId: r.id, mode: "monitor", loop: r };
  if (r.deny) return { action: r.stop ? "stop" : "deny", patternId: r.id, message: r.reason, mode: "enforce", loop: r };
  if (r.note) return { action: "note", patternId: r.id, message: r.note, mode: "enforce", loop: r };
  return { action: "allow", loop: r };
}

/** The decision for one event. Never throws on a missing layer: a layer the context does not supply does not decide. */
export function evaluate(event: GuardEvent, ctx: GuardContext): Decision {
  if (event.kind === "final_text") {
    const u = unparsedCallDecision(event.text);
    if (!u) return ALLOW;
    const record = ctx.record ?? recordFiring;
    record({ id: "unparsed-tool-call", version: u.version, category: "final-text", action: "continue", mode: u.mode, input: event.text, cwd: event.cwd, env: ctx.env, source: event.source, model: event.model, provider: event.provider });
    return { action: u.mode === "enforce" ? "continue" : "allow", patternId: "unparsed-tool-call", mode: u.mode, unparsed: { name: u.name, version: u.version } };
  }
  const call = { tool: event.tool, input: event.input, cwd: event.cwd, env: ctx.env };
  const pre = ctx.gates ? decidePreGates(call, ctx.gates) : null;
  if (pre?.action === "deny") return pre;
  const d = decideLayers(event, ctx);
  if (d.action !== "allow") return d;
  const worker = ctx.gates ? decideWorkerGate(call, ctx.gates) : null;
  if (worker?.action === "deny") return worker;
  const updatedInput = worker?.updatedInput ?? pre?.updatedInput;
  return { ...d, ...(updatedInput && { updatedInput }), ...(worker?.message && { message: worker.message }) };
}

/** Shell rules, then the loop guard. */
function decideLayers(event: Extract<GuardEvent, { kind: "tool_call" }>, ctx: GuardContext): Decision {
  if (ctx.shellRules && event.tool === "Bash") {
    const command = typeof event.input === "string" ? event.input : (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && command) {
      const d = decideShell(scannedCommand(command)!, event, ctx);
      if (d.mode === "enforce" || !ctx.loop) return d;
    }
  }
  return ctx.loop ? decideLoop(event, ctx) : ALLOW;
}
