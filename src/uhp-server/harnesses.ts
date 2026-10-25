/**
 * harnesses.ts — PAI's routing projected as UHP harnesses. One harness per
 * (provider, class) pair: the provider fixes engine and model, the class the
 * contract and limits. Ids are stable (hash of provider|class|engine).
 */

import { createHash } from "node:crypto";
import { loadContractAddendum } from "../workers/contract-addendum.js";
import { type ClassTarget, type WorkerProvider, type WorkersConfig } from "../workers/config.js";

export interface PaiHarness {
  id: string;
  provider: string;
  className: string;
  engine: string;
  model: string;
}

export const harnessId = (provider: string, className: string, engine: string): string =>
  "chrn_" + createHash("sha256").update(`${provider}|${className}|${engine}`).digest("hex").slice(0, 32);

/** The provider a class pins, or null when it only constrains auto-routing. */
function pinnedProvider(t: ClassTarget | undefined): string | null {
  if (typeof t === "string") return t.split("/")[0] || null;
  return t?.provider ?? null;
}

const engineOf = (p: WorkerProvider): string => p.engine ?? "claude";

/** Enabled harnesses: pinned classes pair with their provider, free classes with every enabled one. uhp and image providers are not re-served. */
export function listHarnesses(config: WorkersConfig): PaiHarness[] {
  const usable = Object.entries(config.providers).filter(([, p]) => p.enabled && engineOf(p) !== "uhp" && engineOf(p) !== "image");
  const classNames = Object.keys(config.classes).length ? Object.keys(config.classes) : ["implement"];
  const out: PaiHarness[] = [];
  for (const className of classNames) {
    const pin = pinnedProvider(config.classes[className]);
    for (const [name, p] of usable) {
      if (pin && pin !== name) continue;
      const engine = engineOf(p);
      out.push({ id: harnessId(name, className, engine), provider: name, className, engine, model: p.models.default });
    }
  }
  return out;
}

export function harnessObject(h: PaiHarness, config: WorkersConfig, createdAt: number): Record<string, unknown> {
  const p = config.providers[h.provider]!;
  const addendum = loadContractAddendum(h.provider, p.contract);
  return {
    id: h.id,
    object: "harness",
    name: `${h.provider}/${h.className}`,
    base: h.engine === "claude" ? "pai" : `pai-${h.engine}`,
    baseLabel: "PAI worker",
    defaultModel: h.model,
    systemPrompt: addendum?.text ?? "",
    mcpServers: [],
    skills: [],
    plugins: [],
    environment: "",
    disabledTools: [],
    maxStep: null,
    timeoutSeconds: config.defaultMaxMinutes > 0 ? Math.round(config.defaultMaxMinutes * 60) : null,
    createdAt,
  };
}
