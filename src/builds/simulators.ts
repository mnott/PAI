/**
 * simulators.ts — keep idle simulators from burning CPU after a test job.
 *
 * A test-kind job records the booted simulators when it starts; when it ends
 * (normal, killed, caller died) the ones it added are shut down. `simctl` is
 * injected so tests never touch a real simulator.
 */

import { spawnSync } from "node:child_process";

/** Run `xcrun simctl <args>` and return stdout; throws when it fails. */
export type Simctl = (args: string[]) => string;

export const realSimctl: Simctl = (args) => {
  const r = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr ?? `simctl exited ${r.status}`);
  return r.stdout;
};

/** UDIDs of the simulators booted right now (empty when simctl is unavailable). */
export function bootedSimulators(simctl: Simctl = realSimctl): string[] {
  try {
    const j = JSON.parse(simctl(["list", "devices", "booted", "-j"])) as { devices?: Record<string, Array<{ udid?: string; state?: string }>> };
    return Object.values(j.devices ?? {})
      .flat()
      .filter((d) => d.udid && (d.state ?? "Booted") === "Booted")
      .map((d) => d.udid as string);
  } catch {
    return [];
  }
}

/** Shut down every simulator booted now that was not in `before`. Returns the UDIDs shut down. */
export function shutdownAdded(before: string[], simctl: Simctl = realSimctl): string[] {
  const done: string[] = [];
  for (const udid of bootedSimulators(simctl)) {
    if (before.includes(udid)) continue;
    try {
      simctl(["shutdown", udid]);
      done.push(udid);
    } catch {
      /* already down */
    }
  }
  return done;
}
