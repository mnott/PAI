/**
 * UHP harnesses: one per enabled (provider, class) pair of the workers config.
 * `GET /v1/harnesses`, `GET /v1/harnesses/{id}`.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { paiConfigFilePath } from "../daemon/config.js";
import { loadContractAddendum } from "../workers/contract-addendum.js";
import {
  ANTHROPIC_NATIVE,
  WORKER_CLASSES,
  classModelCapability,
  getProviderOrNative,
  resolveModelCapability,
  type ClassTarget,
  type WorkerProvider,
  type WorkersConfig,
} from "../workers/config.js";
import { inScope, type Principal } from "./auth.js";
import { uhpError } from "./errors.js";

export interface UhpHarness {
  id: string;
  object: "harness";
  name: string;
  base: string;
  baseLabel: string;
  defaultModel: string;
  systemPrompt: string;
  mcpServers: never[];
  skills: never[];
  plugins: never[];
  environment: string;
  disabledTools: string[];
  maxStep: number | null;
  timeoutSeconds: number | null;
  createdAt: number;
}

/** A harness plus what the model listing needs (not sent on the wire). */
export interface HarnessEntry {
  harness: UhpHarness;
  provider: string;
  className: string;
  engine: string;
  workerProvider: WorkerProvider;
}

export function harnessId(provider: string, className: string, engine: string): string {
  return "chrn_" + createHash("sha256").update(`${provider}|${className}|${engine}`).digest("hex").slice(0, 32);
}

function pinnedProvider(t: ClassTarget | undefined): string | null {
  if (typeof t === "string") return t.split("/")[0] || null;
  return t?.provider ?? null;
}

function configMtimeMs(): number {
  try {
    return Math.floor(statSync(paiConfigFilePath()).mtimeMs);
  } catch {
    return 0;
  }
}

export function listHarnessEntries(workers: WorkersConfig, createdAt: number = configMtimeMs()): HarnessEntry[] {
  const names = [ANTHROPIC_NATIVE, ...Object.keys(workers.providers).filter((n) => n !== ANTHROPIC_NATIVE)];
  const enabled = names.filter((n) => getProviderOrNative(workers, n)?.enabled);
  const classes = [...new Set<string>([...WORKER_CLASSES, ...Object.keys(workers.classes)])];
  const out = new Map<string, HarnessEntry>();
  for (const className of classes) {
    const pin = pinnedProvider(workers.classes[className]);
    const targets = pin ? enabled.filter((n) => n === pin) : enabled;
    for (const provider of targets) {
      const p = getProviderOrNative(workers, provider)!;
      const engine = p.engine ?? "claude";
      const id = harnessId(provider, className, engine);
      const addendum = loadContractAddendum(provider, p.contract);
      out.set(id, {
        provider,
        className,
        engine,
        workerProvider: p,
        harness: {
          id,
          object: "harness",
          name: `${provider}/${className}`,
          base: engine === "claude" ? "pai-claude" : `pai-${engine}`,
          baseLabel: "PAI worker",
          defaultModel: resolveModelCapability(p, classModelCapability(className)),
          systemPrompt: addendum?.text ?? "",
          mcpServers: [],
          skills: [],
          plugins: [],
          environment: "",
          disabledTools: [],
          maxStep: null,
          timeoutSeconds: workers.defaultMaxMinutes > 0 ? workers.defaultMaxMinutes * 60 : null,
          createdAt,
        },
      });
    }
  }
  return [...out.values()];
}

/** The principal's harnesses; a token's scope hides the rest. */
export function visibleEntries(entries: HarnessEntry[], p: Principal): HarnessEntry[] {
  return entries.filter((e) => inScope(p, e.harness.id));
}

/** One harness by id; outside scope is the same 404 as unknown. */
export function findEntry(entries: HarnessEntry[], p: Principal, id: string): HarnessEntry {
  const hit = visibleEntries(entries, p).find((e) => e.harness.id === id);
  if (!hit) throw uhpError(404, null, "harness_not_found", "No such harness", "harness_id");
  return hit;
}
