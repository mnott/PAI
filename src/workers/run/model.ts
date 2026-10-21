/**
 * run/model.ts — model/class resolution and the orchestrator step-down, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import {
  classModelCapability,
  isModelCapability,
  nativeAnthropicModels,
  resolveModelCapability,
  type WorkerProvider,
} from "../config.js";
import { detectCurrentModel } from "../launch.js";
import { ensureNoMcpConfig } from "../paths.js";
import { type ModelStepDown } from "./types.js";

/**
 * ag2 unless the caller passed --report json or PAI_WORKER_REPORT=json is
 * set in the environment; an explicit flag always wins over the env default.
 */
export function resolveReportFormat(
  flag: "json" | "ag2" | undefined,
  env: NodeJS.ProcessEnv = process.env
): "json" | "ag2" {
  if (flag) return flag;
  return env.PAI_WORKER_REPORT === "json" ? "json" : "ag2";
}

/** The strict empty MCP config for headless workers, written on demand. */
export { ensureNoMcpConfig } from "../paths.js";

/** CLI aliases the built-in provider hands to `--model` (the shipped
 *  defaults file's `providers.anthropic.models` values): a bare name like
 *  "sonnet", not a concrete id, so the init event's resolved id is always the
 *  more useful thing to display. */
export const NATIVE_MODEL_ALIASES = new Set(Object.values(nativeAnthropicModels()));

/**
 * The model a run goes out on: an explicit `--model` wins; else the routing
 * list entry's alias ("glm/fast") names the capability; else the capability
 * the class implies (image → image model, every other class → default),
 * resolved against the provider's model table. The built-in
 * anthropic provider resolves through the same table as any other, so a
 * worker never inherits the orchestrator session's model.
 */
export function resolveRunModel(
  target: { provider: WorkerProvider; modelAlias: string | null },
  className?: string,
  modelFlag?: string
): string {
  if (modelFlag) return modelFlag;
  const alias = target.modelAlias;
  let capability = alias && isModelCapability(alias) ? alias : classModelCapability(className);
  // nothing named a model (no flag, no class role): the provider's worker_model decides
  if (!alias && capability === "default" && target.provider.workerModel === "fast") capability = "fast";
  return resolveModelCapability(target.provider, capability);
}

/**
 * The `--model` part of the claude argv. Skipped when the caller already
 * pinned one in the claude args (it must not be clobbered) or when nothing
 * resolved — `--model ""` would break the spawn.
 */
export function modelArgs(model: string, callerPinned: boolean): string[] {
  return !callerPinned && model ? ["--model", model] : [];
}

/**
 * Two model ids name the same model when their canonical forms do: a
 * bracketed suffix is a context-window variant, not another model
 * ("glm-5.3[1m]" IS "glm-5.3", announced with a 1M window — the same
 * collision the init event's adoptInitModel sees).
 */
export function canonicalModelId(id: string): string {
  return id.trim().replace(/\[[^\]]*\]$/, "");
}

/**
 * The model step-down: a worker never runs on the orchestrator's own model —
 * enforced here, not remembered (config.ts states the principle). Until
 * 2026-10-17 it was only enforced where a model id is named explicitly: with
 * no --model, the class map's default tier resolved glm's default model —
 * glm-5.3[1m], the very model the orchestrating session itself ran — and
 * nothing detected the equality. Mechanical now: when the resolved id equals
 * the orchestrating session's (detected from the environment exactly the way
 * `pai launch --list --current` does it, launch.ts's detectCurrentModel), the
 * same provider's fast model replaces it. An explicit operator --model always
 * wins, including "use your own model" — the runner's own flag and a --model
 * pinned in the claude args both count as explicit. A provider without a
 * distinct fast model keeps the resolved model with a warning; a run is never
 * refused over this. An undetectable orchestrator model changes nothing.
 */
export function stepDownOrchestratorModel(opts: {
  resolved: string;
  providerName: string;
  provider: Pick<WorkerProvider, "models">;
  /** Explicit --model (the runner's own flag): the operator's choice wins. */
  modelFlag?: string;
  /** The caller pinned --model in the claude args: also explicit. */
  callerPinned?: boolean;
  env?: NodeJS.ProcessEnv;
}): ModelStepDown {
  if (opts.modelFlag || opts.callerPinned) return { model: opts.resolved, notice: null };
  const orchestrator = detectCurrentModel(opts.env ?? process.env);
  if (!orchestrator) return { model: opts.resolved, notice: null };
  if (canonicalModelId(opts.resolved) !== canonicalModelId(orchestrator)) {
    return { model: opts.resolved, notice: null };
  }
  const fast = opts.provider.models.fast;
  if (!fast || canonicalModelId(fast) === canonicalModelId(opts.resolved)) {
    return {
      model: opts.resolved,
      notice:
        `pai: worker model == orchestrator model — provider "${opts.providerName}" has no distinct ` +
        `fast model, keeping ${opts.resolved} (workers never inherit the orchestrator's model)`,
    };
  }
  return {
    model: fast,
    notice:
      `pai: worker model == orchestrator model — stepped down to ${fast} ` +
      `(workers never inherit the orchestrator's model); pass --model to override`,
  };
}

/**
 * Whether the run's assembled cmd gets a forced --model. Headless workers
 * always take the resolved class/provider model — that table exists so
 * spawned subagents stay cheap. An interactive launch (`pai worker run` with
 * no -p) IS the chat pane, not a subagent: with no --model of the caller's
 * own it gets none here either, so Claude Code's own settings.json model
 * applies, exactly as launching `claude` by hand would (2026-09-20: an
 * interactive supervisor came up on the class model instead of the
 * settings.json [1m] variant, then needed a manual /model switch that
 * rebuilt the whole cache). A caller's own --model, headless or not, is
 * already in the passthrough args and must not be duplicated here.
 */
export function modelFlagArgs(headless: boolean, model: string, callerPinned: boolean): string[] {
  return headless ? modelArgs(model, callerPinned) : [];
}

/** The class a run routes by: its own, else `orchestrate` for --orchestrate (the t1 tier), else none (the default tier). */
export const routeClassOf = (opts: { className?: string; orchestrate?: boolean }): string | undefined => opts.className ?? (opts.orchestrate ? "orchestrate" : undefined);
