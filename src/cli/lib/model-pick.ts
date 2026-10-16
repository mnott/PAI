/**
 * model-pick.ts — the "which model?" step of the bare-`pai` picker.
 *
 * After a project is chosen, the operator can pick the provider the session
 * starts on: the built-in anthropic login, any other enabled workers.yaml
 * provider, or a local tier (small/medium/large from local_tiers:). Choice 1
 * is always "default" — no provider override, i.e. exactly what Enter did
 * before this step existed.
 */

import { createInterface } from "node:readline";
import chalk from "chalk";
import { launchableProviderNames } from "../../workers/launch.js";
import type { WorkersConfig } from "../../workers/config.js";
import type { LocalConfig, LocalTier, RunningServer } from "../../workers/local-tiers.js";
import { dim } from "../utils.js";

export interface ModelChoice {
  /** Provider handed to `pai launch --provider`; undefined = today's default. */
  provider?: string;
  /** Local tier name, when this choice is a local model server. */
  tier?: string;
  /** Tier only: its server is running now. */
  up?: boolean;
  label: string;
}

/**
 * Build the choice list. Index 0 is the default (no override). Local tiers'
 * providers are listed once, as tiers, not again as plain providers.
 */
export function buildModelChoices(
  workers: Pick<WorkersConfig, "providers" | "active">,
  local: Pick<LocalConfig, "tiers"> | null,
  running: Pick<RunningServer, "port">[],
): ModelChoice[] {
  const tiers: LocalTier[] = local ? Object.values(local.tiers) : [];
  const tierProviders = new Set(tiers.map((t) => t.provider));
  const active = workers.active && workers.active !== "auto" ? workers.active : "anthropic";

  const choices: ModelChoice[] = [{ label: `default  (today's behaviour: ${active})` }];
  for (const name of launchableProviderNames(workers)) {
    if (tierProviders.has(name)) continue;
    choices.push({ provider: name, label: name });
  }
  for (const t of tiers) {
    const up = running.some((r) => r.port === t.port);
    choices.push({
      provider: t.provider,
      tier: t.tier,
      up,
      label: `local ${t.tier}  ${t.served}  :${t.port}  ${up ? "up" : "down — will be started"}`,
    });
  }
  return choices;
}

/** The screen text for the model step. */
export function modelScreen(choices: ModelChoice[], name: string): string[] {
  const lines = ["", `  ${chalk.bold("Model for")} ${chalk.white(name)}`, ""];
  choices.forEach((c, i) => {
    const mark = c.tier ? (c.up ? chalk.green("●") : chalk.dim("○")) : " ";
    lines.push(`  ${chalk.cyan(String(i + 1).padStart(2))}  ${mark} ${c.label}`);
  });
  lines.push("");
  return lines;
}

/** Answer text → choice. Empty (Enter) = default; unknown = null. */
export function parseModelAnswer(answer: string, choices: ModelChoice[]): ModelChoice | null {
  const t = answer.trim().toLowerCase();
  if (!t) return choices[0];
  if (/^\d+$/.test(t)) return choices[Number(t) - 1] ?? null;
  return (
    choices.find((c) => c.provider === t && !c.tier) ??
    choices.find((c) => c.tier === t || c.tier === t.replace(/^local[ -]?/, "")) ??
    null
  );
}

/** Ask on the terminal; Enter keeps the default. Null = invalid answer. */
export function askModel(choices: ModelChoice[], name: string): Promise<ModelChoice | null> {
  for (const l of modelScreen(choices, name)) console.log(l);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(dim("  Pick a number or name [Enter = default]: "), (a) => {
      rl.close();
      resolve(parseModelAnswer(a, choices));
    }),
  );
}
