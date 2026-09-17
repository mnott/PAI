/**
 * worker_model — the MCP tool behind model selection.
 *
 * Extracted from index.ts (which starts its transport on import, so its
 * inline handlers cannot be imported by tests): this module holds only the
 * handler, index.ts registers it. The mutations themselves live in
 * src/workers/providers.ts, shared with the `pai worker model` CLI.
 */

import { readWorkersSection } from "../../workers/config.js";
import {
  describeModels,
  resolveProviderName,
  setProviderModel,
  type ModelSlot,
} from "../../workers/providers.js";

export interface WorkerModelArgs {
  action?: "get" | "set";
  provider?: string;
  slot?: ModelSlot;
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
 * provider when no provider is given. set: write a provider's default or
 * fast model id and report the change.
 */
export function workerModel(args: WorkerModelArgs, configPath?: string): WorkerToolResult {
  try {
    const action = args.action ?? "get";
    if (action !== "get" && action !== "set") {
      return error(new Error(`unknown action "${String(action)}" (expected: get, set)`));
    }
    const slot = args.slot ?? "default";
    const { workers } = readWorkersSection(configPath);
    if (action === "get") {
      if (args.provider) {
        const name = resolveProviderName(workers, args.provider);
        const p = workers.providers[name];
        return p
          ? text(`${name}  default ${p.models.default}  fast ${p.models.fast ?? "(none)"}`)
          : error(new Error(`no provider named "${args.provider}"`));
      }
      return text(describeModels(workers).join("\n"));
    }
    if (!args.model || !args.model.trim()) {
      return error(new Error("set needs a non-empty model id"));
    }
    const name = resolveProviderName(workers, args.provider);
    const fresh = setProviderModel(name, slot, args.model, configPath);
    const p = fresh.providers[name];
    return text(
      `${name} ${slot} model: ${slot === "fast" ? (p?.models.fast ?? "?") : (p?.models.default ?? "?")}`
    );
  } catch (e) {
    return error(e);
  }
}
