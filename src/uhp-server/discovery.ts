/**
 * discovery.ts — GET /v1/uhp. The body holds nothing principal-specific.
 * The conformance class is computed from the capabilities (architecture.md §2):
 * extended needs files in and out and session listing.
 */

import { UHP_DEFAULT_VERSION, UHP_VERSIONS } from "./errors.js";

export const CAPABILITY_KEYS = [
  "streaming", "sessions", "cancellation", "files_input", "files_output", "session_listing",
  "harness_management", "harness_retirement", "session_sharing", "idempotency", "plugins",
  "environments", "memories", "input_history",
] as const;
export type Capabilities = Record<(typeof CAPABILITY_KEYS)[number], boolean>;

/** What this server implements; flipped by the modules that land (session listing, files). */
export const SERVER_CAPABILITIES: Capabilities = {
  streaming: true,
  sessions: true,
  cancellation: true,
  files_input: false,
  files_output: false,
  session_listing: false,
  harness_management: false,
  harness_retirement: false,
  session_sharing: false,
  idempotency: true,
  plugins: false,
  environments: false,
  memories: false,
  input_history: false,
};

export function conformanceClass(c: Capabilities): "core" | "extended" | "full" {
  const extended = c.files_input && c.files_output && c.session_listing;
  if (extended && c.harness_management && c.session_sharing) return "full";
  return extended ? "extended" : "core";
}

export function discoveryBody(version: string, caps: Capabilities = SERVER_CAPABILITIES): Record<string, unknown> {
  return {
    object: "uhp.discovery",
    protocol: "uhp",
    versions: [...UHP_VERSIONS],
    default_version: UHP_DEFAULT_VERSION,
    conformance_class: conformanceClass(caps),
    capabilities: { ...caps },
    implementation: { name: "PAI", version },
  };
}
