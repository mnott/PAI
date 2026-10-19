/**
 * local-answer.ts — the daemon's cached local-model answer as one line, for
 * hooks. Reads <logDir>/local-status.json only; a hook never probes a port.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { localStatusLine, readLocalStatus } from "../../../workers/local-status.js";

export const UNKNOWN_ANSWER = "unknown (the daemon is not reporting; run `pai worker local`)";

export function cachedLocalAnswer(): string {
  try {
    const st = readLocalStatus(workersLogDir(readWorkersSection().workers));
    return st ? localStatusLine(st) : UNKNOWN_ANSWER;
  } catch {
    return UNKNOWN_ANSWER;
  }
}
