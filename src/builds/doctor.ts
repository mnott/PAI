/**
 * doctor.ts — `pai build doctor`: check the project's registered doors.
 * A door must exist, be executable, and call `pai build lock` itself; the
 * guard trusts doors, so a door without the lock is a hole in the queue.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBuildsConfig } from "../hooks/ts/lib/build-gate.js";

export interface DoorFinding {
  door: string;
  ok: boolean;
  problem?: string;
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
