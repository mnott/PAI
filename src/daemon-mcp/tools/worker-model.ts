/**
 * worker_model — the MCP tool behind model selection.
 *
 * Extracted from index.ts (which starts its transport on import, so its
 * inline handlers cannot be imported by tests): this module holds only the
 * handler, index.ts registers it. The mutations themselves live in
 * src/workers/providers.ts, shared with the `pai worker model` CLI.
 */

import { readWorkersSection, type ModelCapability } from "../../workers/config.js";
import {
  describeModels,
  modelPrefsText,
  resolveProviderName,
  setProviderModel,
} from "../../workers/providers.js";

export interface WorkerModelArgs {
  action?: "get" | "set";
  provider?: string;
  /** Which model capability to set (default, fast, image, …). */
  capability?: ModelCapability;
  /** Deprecated pre-capability spelling of `capability` (default | fast). */
  slot?: string;
  model?: string;
}

export type WorkerToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const text = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }] });
const error = (e: unknown): WorkerToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/**
 * get: the model ids of one provider (default: the active one), or of every
 * provider when no provider is given. set: write a provider's model id for a
 * capability and report the change.
 */
export function workerModel(args: WorkerModelArgs, configPath?: string): WorkerToolResult {
  try {
    const action = args.action ?? "get";
    if (action !== "get" && action !== "set") {
      return error(new Error(`unknown action "${String(action)}" (expected: get, set)`));
    }
    if (args.capability !== undefined && args.slot !== undefined && args.capability !== args.slot) {
      return error(new Error(`capability "${args.capability}" and slot "${args.slot}" disagree — pass one`));
    }
    const capability = args.capability ?? (args.slot as ModelCapability | undefined) ?? "default";
    const { workers } = readWorkersSection(configPath);
    if (action === "get") {
      if (args.provider) {
        const name = resolveProviderName(workers, args.provider);
        const p = workers.providers[name];
        return p
          ? text(`${name}  ${modelPrefsText(p)}`)
          : error(new Error(`no provider named "${args.provider}"`));
      }
      return text(describeModels(workers).join("\n"));
    }
    if (!args.model || !args.model.trim()) {
      return error(new Error("set needs a non-empty model id"));
    }
    const name = resolveProviderName(workers, args.provider);
    const fresh = setProviderModel(name, capability, args.model, configPath);
    const p = fresh.providers[name];
    return text(`${name} ${capability} model: ${p?.models[capability] ?? "?"}`);
  } catch (e) {
    return error(e);
  }
}
