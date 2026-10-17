/**
 * Which provider (and model) a session opens on. One pure function, one
 * order, written down:
 *
 *   1. --provider on the command line — always wins, never overridden
 *   2. the provider the session's transcript ran on
 *   3. the active provider from workers.yaml
 *   4. anthropic (plain Claude Code login)
 *
 * Nothing falls back silently: an explicit provider that is not available is
 * an error naming the ones that are (see assertAvailable).
 */

import { ANTHROPIC_NATIVE, type WorkerProvider } from "../../workers/config.js";
import { stripModelVariant } from "../../utils/model-window.js";
import { CliError } from "../define.js";

export type ChoiceSource = "flag" | "session" | "active" | "default";

export interface SessionOrigin {
  provider: string;
  model: string;
}

export interface Choice {
  provider: string;
  /** Undefined = the provider's default model. */
  model?: string;
  source: ChoiceSource;
}

/** Provider a transcript's model belongs to: a configured provider whose model
 *  table names it, else anthropic for a claude-* model, else unknown. */
export function inferOrigin(
  model: string | null | undefined,
  providers: Record<string, Pick<WorkerProvider, "enabled" | "native" | "models">>
): SessionOrigin | null {
  if (!model) return null;
  const base = stripModelVariant(model);
  for (const [name, p] of Object.entries(providers)) {
    if (!p.enabled || p.native) continue;
    if (Object.values(p.models).some((m) => !!m && stripModelVariant(m) === base)) return { provider: name, model };
  }
  return /^claude-/.test(base) ? { provider: ANTHROPIC_NATIVE, model } : null;
}

export function chooseProvider(input: {
  flagProvider?: string;
  flagModel?: string;
  origin: SessionOrigin | null;
  active: string | null;
}): Choice {
  const { flagProvider, flagModel, origin, active } = input;
  if (flagProvider) {
    const same = origin?.provider === flagProvider;
    return { provider: flagProvider, model: flagModel ?? (same ? origin.model : undefined), source: "flag" };
  }
  if (origin) return { provider: origin.provider, model: flagModel ?? origin.model, source: "session" };
  if (active && active !== "auto") return { provider: active, model: flagModel, source: "active" };
  return { provider: ANTHROPIC_NATIVE, model: flagModel, source: "default" };
}

const shortList = (names: string[], max = 8) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} … (${names.length - max} more: pai providers)`;

/** Fail with the reason and the providers that do work. */
export function assertAvailable(
  provider: string,
  available: string[],
  retry: (alternative: string) => string
): void {
  if (available.includes(provider)) return;
  const alt = available.find((n) => n !== provider) ?? ANTHROPIC_NATIVE;
  throw new CliError(
    `provider "${provider}" is not available (not configured or disabled). Available: ${shortList(available)}`,
    retry(alt)
  );
}

/** Keep a session's recorded model only when the target provider offers it. */
export function modelFor(provider: Pick<WorkerProvider, "models">, wanted: string | undefined): string | undefined {
  if (!wanted) return undefined;
  const base = stripModelVariant(wanted);
  return Object.values(provider.models).find((m) => !!m && (m === wanted || stripModelVariant(m) === base)) ?? undefined;
}
