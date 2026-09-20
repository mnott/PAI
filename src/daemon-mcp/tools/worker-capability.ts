/**
 * worker_capability — the MCP tool behind cross-provider capability
 * preference (the config behind `pai worker capability`).
 *
 * Extracted like worker-model.ts: index.ts starts its transport on import,
 * so its inline handlers cannot be imported by tests. The mutations
 * themselves live in src/workers/providers.ts, shared with the CLI.
 */

import { readWorkersSection } from "../../workers/config.js";
import {
  describeCapabilities,
  setCapabilityPreference,
  unsetCapabilityPreference,
} from "../../workers/providers.js";
import type { WorkerToolResult } from "./worker-model.js";

export interface WorkerCapabilityArgs {
  action?: "list" | "set" | "unset";
  /** Capability name, e.g. "image". Required for set/unset. */
  capability?: string;
  /** Preference list, first usable one wins. Required for set. */
  providers?: string[];
}

const text = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }] });
const error = (e: unknown): WorkerToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/**
 * list (default): every capability preference and what it resolves to right
 * now. set: which provider(s) serve a capability, first usable one wins.
 * unset: remove a preference.
 */
export function workerCapability(args: WorkerCapabilityArgs, configPath?: string): WorkerToolResult {
  try {
    const action = args.action ?? "list";
    if (action === "list") {
      const { workers } = readWorkersSection(configPath);
      return text(describeCapabilities(workers).join("\n"));
    }
    if (!args.capability) return error(new Error(`capability is required for action "${action}"`));
    if (action === "unset") {
      unsetCapabilityPreference(args.capability, configPath);
      return text(`removed the capability preference for "${args.capability}"`);
    }
    if (action !== "set") return error(new Error(`unknown action "${String(action)}" (expected: list, set, unset)`));
    if (!args.providers || !args.providers.length) return error(new Error("set needs a non-empty providers list"));
    const workers = setCapabilityPreference(args.capability, args.providers, configPath);
    const line = describeCapabilities(workers).find((l) => l.startsWith(`${args.capability}:`));
    return text(line ?? `${args.capability}: [${workers.capabilities[args.capability]?.join(", ")}]`);
  } catch (e) {
    return error(e);
  }
}
