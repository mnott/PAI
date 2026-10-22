/**
 * doctor.ts — `pai build doctor`: check the project's registered doors.
 * A door must exist, be executable, and call `pai build lock` itself; the
 * guard trusts doors, so a door without the lock is a hole in the queue.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBuildsConfig } from "../hooks/ts/lib/build-gate.js";
import { auditHooks, observedHookEvents, defaultCaptureDir, DEFAULT_SINCE_HOURS, OBSERVABLE_EVENTS } from "../audit/hooks.js";

export interface DoorFinding {
  door: string;
  ok: boolean;
  problem?: string;
}

export interface HookEventFinding {
  event: string;
  configured: boolean;
  observed: boolean;
  lastSeen?: string;
}

export function doctor(cwd: string): { root: string | null; findings: DoorFinding[] } {
  const cfg = loadBuildsConfig(cwd);
  if (!cfg) return { root: null, findings: [] };
  const findings = cfg.doors.map((door): DoorFinding => {
    const f = resolve(cfg.root, door);
    if (!existsSync(f)) return { door, ok: false, problem: "file does not exist" };
    const text = readFileSync(f, "utf8");
    if (!/pai\s+build\s+(lock|run)\b/.test(text)) return { door, ok: false, problem: "never calls `pai build lock -- <command>`: it bypasses the queue" };
    return { door, ok: true };
  });
  return { root: cfg.root, findings };
}

/**
 * One line per hook event: whether it is configured in settings.json and
 * whether a capture proves it actually ran in the last `sinceHours`. A hook
 * that is configured but never observed is the classic silent-failure case.
 */
export async function hookEventFindings(
  cwd: string,
  opts: { sinceHours?: number; captureDir?: string; now?: number } = {}
): Promise<HookEventFinding[]> {
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
  const now = opts.now ?? Date.now();
  const report = auditHooks(cwd, { sinceHours, captureDir: opts.captureDir, now });
  const observed = await observedHookEvents(opts.captureDir ?? defaultCaptureDir(), now - sinceHours * 3_600_000);

  const configuredEvents = new Set(report.readings.map((r) => r.event));
  const findings: HookEventFinding[] = [];
  for (const event of OBSERVABLE_EVENTS) {
    const seen = observed.get(event);
    findings.push({
      event,
      configured: configuredEvents.has(event),
      observed: !!seen,
      lastSeen: seen?.last,
    });
  }
  return findings;
}
