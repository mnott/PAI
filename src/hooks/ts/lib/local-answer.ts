/**
 * local-answer.ts — the daemon's cached local-model answer as one line, for
 * hooks. Reads <logDir>/local-status.json only; a hook never probes a port.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { localStatusLine, readLocalStatusWhy } from "../../../workers/local-status.js";

export const UNKNOWN_ANSWER = "unknown (the daemon is not reporting; run `pai worker local`)";

const unknownBecause = (why: string): string => `unknown — ${why} (the daemon is not reporting; run \`pai worker local\`)`;

export function cachedLocalAnswer(): string {
  try {
    const { status: st, reason } = readLocalStatusWhy(workersLogDir(readWorkersSection().workers));
    if (!st) return unknownBecause(reason);
    // only a fresh probe may say "none"; a hook never probes
    return st.running.length ? localStatusLine(st) : unknownBecause("daemon's last probe found none running");
  } catch {
    return UNKNOWN_ANSWER;
  }
}
