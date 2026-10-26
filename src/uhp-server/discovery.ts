/** `GET /v1/uhp`: the one unauthenticated endpoint. */

import { UHP_DEFAULT_VERSION, UHP_VERSIONS } from "./errors.js";

export const CAPABILITY_KEYS = [
  "streaming",
  "sessions",
  "cancellation",
  "files_input",
  "files_output",
  "session_listing",
  "session_sharing",
  "harness_management",
  "harness_retirement",
  "environments",
  "plugins",
  "memories",
  "input_history",
  "idempotency",
] as const;

export type Capabilities = Record<(typeof CAPABILITY_KEYS)[number], boolean>;

const CLASS_NEEDS: Record<"extended" | "core", (keyof Capabilities)[]> = {
  core: ["streaming", "sessions", "cancellation"],
  extended: ["streaming", "sessions", "cancellation", "files_input", "files_output", "session_listing"],
};

/** The capabilities the mounted routes provide; A1 mounts discovery, harnesses and models only. */
export function enabledCapabilities(routes: ReadonlySet<string>): Capabilities {
  const caps = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false])) as Capabilities;
  for (const k of routes) if (k in caps) caps[k as keyof Capabilities] = true;
  return caps;
}

/** Highest class whose required capabilities are all on; full needs harness_management too. */
export function conformanceClass(caps: Capabilities): "core" | "extended" | "full" {
  const has = (ks: (keyof Capabilities)[]) => ks.every((k) => caps[k]);
  if (has(CLASS_NEEDS.extended) && caps.harness_management) return "full";
  if (has(CLASS_NEEDS.extended)) return "extended";
  return "core";
}

export function discoveryDoc(routes: ReadonlySet<string>, implVersion: string) {
  const capabilities = enabledCapabilities(routes);
  return {
    object: "uhp.discovery",
    protocol: "uhp",
    versions: [...UHP_VERSIONS],
    default_version: UHP_DEFAULT_VERSION,
    conformance_class: conformanceClass(capabilities),
    capabilities,
    implementation: { name: "pai", version: implVersion },
  };
}
