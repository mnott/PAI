/**
 * pane-policy.ts — the policy values of the pane code (minimum pane size,
 * verify retries, pane-run linger/keep/tail, exec waits, audit graces, title
 * width, status-line tick). They live in the shipped defaults file
 * (src/config/defaults/config.yaml, `panes` section) and are read through the
 * main-config loader (effectiveMainConfig over paiConfigFilePath(), so
 * PAI_CONFIG_FILE and a user config.yaml/json win), resolved at call time.
 */

import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";

type Section = Record<string, unknown>;
const isSection = (v: unknown): v is Section => typeof v === "object" && v !== null && !Array.isArray(v);

function panesSection(): Section {
  try {
    const p = effectiveMainConfig(paiConfigFilePath()).panes;
    return isSection(p) ? p : {};
  } catch {
    // a damaged user config must not break panes: the shipped fallbacks stand alone
    return {};
  }
}

/** A positive number from the config subtree, else the shipped fallback. */
function num(s: Section, key: string, fallback: number): number {
  const v = s[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface PanePolicy {
  minCols: number;
  minRows: number;
  verifyTries: number;
  verifyPollMs: number;
  sessionMapMaxAgeMs: number;
  titleMax: number;
  statusTickMs: number;
  helloWaitMs: number;
  killGraceMs: number;
  connectMs: number;
  lingerSecs: number;
  /** Seconds a pane stays after its process ended, clean or failed (`pai worker replay` shows a failure again). */
  exitLingerSecs: number;
  runPollMs: number;
  runKeepMs: number;
  tailLines: number;
  startGraceMs: number;
  endGraceMs: number;
  launchGraceMs: number;
  /** How long a running worker's vanished pane is retried before the worker is stopped. */
  reopenGraceMs: number;
}

/** The effective pane policy; the numbers here are only the fallback for a key the defaults file lacks. */
export function panePolicy(): PanePolicy {
  const s = panesSection();
  const audit = isSection(s.audit) ? s.audit : {};
  return {
    minCols: num(s, "minCols", 40),
    minRows: num(s, "minRows", 6),
    verifyTries: num(s, "verifyTries", 25),
    verifyPollMs: num(s, "verifyPollMs", 300),
    sessionMapMaxAgeMs: num(s, "sessionMapMaxAgeDays", 7) * 86_400_000,
    titleMax: num(s, "titleMax", 40),
    statusTickMs: num(s, "statusTickMs", 1000),
    helloWaitMs: num(s, "helloWaitSecs", 20) * 1000,
    killGraceMs: num(s, "killGraceSecs", 3) * 1000,
    connectMs: num(s, "connectSecs", 10) * 1000,
    lingerSecs: num(s, "lingerSecs", 5),
    exitLingerSecs: num(s, "exitLingerSecs", 8),
    runPollMs: num(s, "runPollMs", 250),
    runKeepMs: num(s, "runKeepHours", 24) * 3_600_000,
    tailLines: num(s, "tailLines", 40),
    startGraceMs: num(audit, "startGraceSecs", 30) * 1000,
    endGraceMs: num(audit, "endGraceSecs", 60) * 1000,
    launchGraceMs: num(audit, "launchGraceSecs", 15) * 1000,
    reopenGraceMs: num(audit, "reopenGraceSecs", 600) * 1000,
  };
}
