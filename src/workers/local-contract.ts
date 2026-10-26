/**
 * local-contract.ts — the short contract prepended to every LOCAL worker's
 * task (never a cloud worker's). Local models loop on piecewise reads and
 * repeated failing commands; this keeps them on the cheap path. The project's
 * fast checks come from `.pai/checks.yaml`:
 *
 *   fast: <cmd>             type-check / lint, seconds
 *   test_one: <cmd with {class}>   run one test class
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import type { WorkerProvider } from "./config.js";
import { isBenchmarkLabel } from "../daemon/battery-guard.js";
import { projectConfigFile } from "./preamble.js";
import { isLoopbackProvider } from "./run-env.js";

export const CHECKS_REL = ".pai/checks.yaml";

export interface Checks {
  fast?: string;
  testOne?: string;
}

/** Missing or malformed file: no checks (the contract then names none). */
export function loadChecks(cwd: string): Checks {
  const path = projectConfigFile(cwd, CHECKS_REL);
  if (!existsSync(path)) return {};
  try {
    const raw = yamlParse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return { fast: s(raw?.fast), testOne: s(raw?.test_one) };
  } catch {
    return {};
  }
}

export function localContract(checks: Checks): string {
  const fast = checks.fast ? `\`${checks.fast}\`` : "the project's fast type-check";
  const one = checks.testOne ? ` (\`${checks.testOne}\`)` : "";
  return [
    "Local worker rules:",
    `1. Type-check first with ${fast} before any full build.`,
    `2. Run only the test class you touched${one}, never the full suite.`,
    "3. Read each file whole with the Read tool, not in pieces.",
    "4. Stop after the first red test and report it; do not keep fixing.",
    "5. Never repeat a failing command unchanged; change something or report.",
    "6. A command that succeeded is done: never run it again unchanged. After the commit, write the report.",
    "7. No new committed test files: prove the change with the command you ran and its output; throwaway checks go under .pai-scratch/.",
  ].join("\n");
}

/** The task with the local contract in front. */
export function withLocalContract(prompt: string, cwd: string): string {
  return `${localContract(loadChecks(cwd))}\n\n${prompt}`;
}

/** The task for a worker on `provider`: the contract in front on a local (loopback) provider, unchanged on any cloud one or a benchmark run (every model gets the identical task). */
export function taskForProvider(prompt: string, provider: WorkerProvider, cwd: string, label?: string): string {
  if (isBenchmarkLabel(label)) return prompt;
  const local = !provider.native && provider.engine !== "image" && isLoopbackProvider(provider);
  return local ? withLocalContract(prompt, cwd) : prompt;
}
