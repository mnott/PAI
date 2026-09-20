/**
 * advisor-budget.ts
 *
 * Deciding how much of the weekly Anthropic budget is gone, and whether that
 * answer is current enough to act on.
 *
 * The statusline writes `~/.claude/pai/advisor-mode.json` on every render of an
 * Anthropic session; the whisper hook reads it and injects an instruction about
 * how much work to do. That makes this the one number in PAI that changes the
 * assistant's behaviour rather than merely describing it, which is why it is
 * worth its own module with its own tests.
 */

export interface AdvisorConfig {
  weeklyBudgetPercent?: number;  // 0-100, used (not remaining)
  asOf?: number;                 // epoch seconds the percentage was read
  mode?: "normal" | "conservative" | "strict" | "critical" | "auto";
  forceModel?: string;           // override: always use this model for subagents
}

export type AdvisorMode = "normal" | "conservative" | "strict" | "critical" | "auto";

const VALID_MODES: readonly string[] = ["normal", "conservative", "strict", "critical", "auto"];

/**
 * How old a budget reading may be before it stops being obeyed.
 *
 * A live machine rewrites the file many times a minute, so it never comes near
 * this. Exceeding it means nothing has reported a budget for hours — which is
 * exactly what a broken usage source looks like.
 *
 * That failure has happened: the OAuth token the statusline read went away, its
 * usage cache froze, and "weekly budget at 97%" was injected into every session
 * for a day and a half after the real figure had reset to 2% — telling every
 * assistant to downgrade models and skip verification on a budget that was
 * almost untouched. A budget guard has to fail towards doing the work, not
 * towards refusing it.
 */
export const ADVISOR_MAX_AGE_SECONDS = 6 * 60 * 60;

/**
 * The budget percentage, but only while it can be shown to be current.
 *
 * A reading with no `asOf` comes from a writer that predates the timestamp, and
 * there is no way to tell a fresh one from one that stopped being updated — so
 * it counts as unknown rather than as true.
 */
export function freshBudgetPercent(
  config: AdvisorConfig,
  nowSeconds: number,
): number | undefined {
  const pct = config.weeklyBudgetPercent;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return undefined;
  if (typeof config.asOf !== "number" || !Number.isFinite(config.asOf)) return undefined;
  if (nowSeconds - config.asOf > ADVISOR_MAX_AGE_SECONDS) return undefined;
  return pct;
}

/**
 * Normalise whatever is in the file to a mode.
 *
 * `??` only substitutes on null/undefined, so a config written as {"mode": ""}
 * — which is what an older statusline produced when there was no manual
 * override — left mode as the empty string, matching no branch downstream and
 * silently disabling the advisor whatever the budget said. Anything that is not
 * a recognised mode is "auto".
 */
export function normaliseMode(mode: unknown): AdvisorMode {
  return typeof mode === "string" && VALID_MODES.includes(mode)
    ? (mode as AdvisorMode)
    : "auto";
}

/**
 * The mode to act on: the manual one if set, else derived from a current
 * budget reading, else undefined — meaning say nothing at all.
 */
export function resolveAdvisorMode(
  config: AdvisorConfig,
  nowSeconds: number,
): { mode: Exclude<AdvisorMode, "auto"> | undefined; percent: number | undefined } {
  const percent = freshBudgetPercent(config, nowSeconds);
  const configured = normaliseMode(config.mode);
  if (configured !== "auto") return { mode: configured, percent };
  if (percent === undefined) return { mode: undefined, percent: undefined };
  if (percent < 60) return { mode: "normal", percent };
  if (percent < 80) return { mode: "conservative", percent };
  if (percent < 92) return { mode: "strict", percent };
  return { mode: "critical", percent };
}
