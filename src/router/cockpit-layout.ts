/**
 * cockpit-layout.ts — the policy values of the cockpit layout: tile min/max
 * widths, chart heights, sample/history window lengths, refresh intervals and
 * row limits. The arrangement of cards (rows, spans, drag) is not here: it
 * lives in the windowing registry and the browser's saved state. They live in the shipped defaults file
 * (src/config/defaults/config.yaml, `router.cockpit.layout` section) and are
 * read through the main-config loader (effectiveMainConfig over
 * paiConfigFilePath(), so PAI_CONFIG_FILE and a user config.yaml/json win),
 * resolved at page-build time — never as constants in code. Pure styling
 * (fonts, colours from the theme mapping) stays in the page's CSS.
 */

import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";

/** The `router.cockpit` subtree of the effective main config; {} when unreadable. */
function cockpitSection(): Record<string, unknown> {
  try {
    const r = effectiveMainConfig(paiConfigFilePath()).router;
    const c =
      typeof r === "object" && r !== null && !Array.isArray(r)
        ? (r as Record<string, unknown>).cockpit
        : undefined;
    return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
  } catch {
    // a damaged user config must not blank the page: the shipped defaults stand alone
    return {};
  }
}

/** Keys removed with the windowing cut-over; a user config that still sets one is
 *  ignored, with one log line per process. */
const REMOVED_KEYS = [
  "gridCols", "gridBreakpointPx", "minSectionPx", "providerTileMinPx", "runtimeCardMinPx",
  "tilesWideBreakpointPx", "tilesWideCols", "tilesNarrowCols", "tilesOneColBreakpointPx",
  "bigDonutSizePx", "tokensChartWidthPx", "tokensChartHeightPx", "powerChartWidthPx",
  "powerChartHeightPx", "dailyChartWidthPx", "dailyChartHeightPx", "chartResizeSlackPx",
  "chartResizeDebounceMs", "confirmMs", "foldDefaultKind", "rows", "maxPerRow", "touchPressMs",
  "edgeScrollPx",
];
let removedLogged = false;

/** The `router.cockpit.layout` subtree; {} when absent. */
function layoutSection(): Record<string, unknown> {
  const l = cockpitSection().layout;
  const section = typeof l === "object" && l !== null && !Array.isArray(l) ? (l as Record<string, unknown>) : {};
  if (!removedLogged) {
    const stale = REMOVED_KEYS.filter((k) => k in section);
    if (stale.length) {
      removedLogged = true;
      console.error(`router.cockpit.layout: ignoring removed keys (no effect since the windowing cut-over): ${stale.join(", ")}`);
    }
  }
  return section;
}

/** A positive number from the config subtree, else the shipped fallback. */
function num(section: Record<string, unknown>, key: string, fallback: number): number {
  const v = section[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Like num, but 0 is a real setting (a threshold or hold of 0 turns it off). */
function numZ(section: Record<string, unknown>, key: string, fallback: number): number {
  const v = section[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** A non-empty string from the config subtree, else the shipped fallback. */
function str(section: Record<string, unknown>, key: string, fallback: string): string {
  return typeof section[key] === "string" && section[key] ? (section[key] as string) : fallback;
}

/** A #rrggbb colour string. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A list of #rrggbb colour strings (the model palette), else the fallback. */
function hexColors(section: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = section[key];
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === "string" && HEX_COLOR.test(x));
  return out.length ? out : fallback;
}

/** The shipped values, kept only as the fallback when the defaults file is
 *  missing a key; the file is the source of truth. */
const SHIPPED = {
  gaugeMinWidthPx: 110,
  gaugeMaxWidthPx: 120,
  ringMinWidthPx: 92,
  // model colours, assignment order; the first four are the token-kind colours.
  palette: [
    "#3b6fe0", "#e0703b", "#2e9e5b", "#b04fd0",
    "#d9b31c", "#2bb3c0", "#d64570", "#7a8a99",
    "#8fbf3f", "#a0522d", "#6a5acd", "#1f8a70",
    "#c2c24a", "#4d8bc9", "#c96a9b", "#57a64a",
    "#b38f2d", "#3aa0d6", "#9b59b6", "#d07a35",
    "#4a9e8f", "#8a7f5a", "#c05a5a", "#6f9e3c",
  ],
  sessionTitleMaxWidthPx: 480,
  sparkHeightPx: 32,
  sparkViewMaxPx: 100,
  sparkPlotHeightPx: 30,
  sparkPlotTopPx: 28,
  donutSizePx: 84,
  donutRadiusPx: 48,
  donutStrokePx: 16,
  donutViewBoxPx: 140,
  minLabelGapPx: 48,
  minBarPx: 3,
  sysHistoryLen: 60,
  dailyDays: 14,
  sessionsRows: 20,
  sessionsTopRows: 10,
  sessionNameMaxPct: 35,
  workerRows: 15,
  lowRequestMin: 5,
  // saved model colours older than this (days, by their "@ts" stamp) are pruned
  colorPruneDays: 90,
  pollMs: 5000,
  limitsPollMs: 30000,
  poolPollMs: 15000,
  clockTickMs: 1000,
  stampStaleSecs: 15,
  holdLastGoodSecs: 120,
  jobPollMs: 5000,
  jobFirstDelayMs: 2000,
  jobMaxTries: 120,
  serverCounterStaleSecs: 60,
  // colour thresholds: at/above Bad colours red, at/above Warn amber, below Warn
  // green. gaugeWarnPct/gaugeBadPct are percentages of a limits gauge; hitWarn/
  // hitBad and errorWarn/errorBad are ratios (0..1) of a hit ratio / error rate.
  gaugeWarnPct: 70,
  gaugeBadPct: 90,
  hitWarn: 0.8,
  hitBad: 0.5,
  errorWarn: 0.02,
  errorBad: 0.1,
  // Memory section: title, refresh, embedding coverage colours (ratios 0..1), and how long
  // a started run may take to write its marker before the card stops reading "starting".
  memoryTitle: "Memory",
  memoryPollMs: 5000,
  memoryCoverageWarn: 0.99,
  memoryCoverageBad: 0.5,
  memoryStartGraceSecs: 120,
  memoryStallSecs: 300,
  memoryHistoryLen: 120,
  memoryRingPx: 76,
} as const;

/** The layout policy of the cockpit page, read at page-build time. */
export interface CockpitLayout {
  /** gauge tiles in the cloud/local flex rows. */
  gaugeMinWidthPx: number;
  gaugeMaxWidthPx: number;
  /** cache rings grid. */
  ringMinWidthPx: number;
  /** model colours: palette in assignment order (#rrggbb, readable on both themes). */
  palette: string[];
  /** the sessions table's title column. */
  sessionTitleMaxWidthPx: number;
  /** metric-tile sparkline: height, viewBox width, plot top/height. */
  sparkHeightPx: number;
  sparkViewMaxPx: number;
  sparkPlotHeightPx: number;
  sparkPlotTopPx: number;
  /** cache donut: ring size, radius, stroke, viewBox. */
  donutSizePx: number;
  donutRadiusPx: number;
  donutStrokePx: number;
  donutViewBoxPx: number;
  minLabelGapPx: number;
  minBarPx: number;
  sysHistoryLen: number;
  /** sample/history windows. */
  dailyDays: number;
  /** table row limits. */
  sessionsRows: number;
  sessionsTopRows: number;
  sessionNameMaxPct: number;
  workerRows: number;
  /** models under this many requests are chips, not rings. */
  lowRequestMin: number;
  /** saved model colours (localStorage) older than this many days are pruned. */
  colorPruneDays: number;
  /** refresh intervals. */
  pollMs: number;
  limitsPollMs: number;
  poolPollMs: number;
  clockTickMs: number;
  /** the stamp reads stale past this age. */
  stampStaleSecs: number;
  /** a failed or transient fetch keeps the last good payload on screen this long, then the section shows the error. */
  holdLastGoodSecs: number;
  /** a local switch/off job: first delay, poll interval, max tries. */
  jobPollMs: number;
  jobFirstDelayMs: number;
  jobMaxTries: number;
  /** a server prefix-cache counter older than this is marked. */
  serverCounterStaleSecs: number;
  /** colour thresholds: a limits gauge at/above gaugeBadPct reads red, at/above
   *  gaugeWarnPct amber (percentages). */
  gaugeWarnPct: number;
  gaugeBadPct: number;
  /** a cache hit ratio below hitWarn reads amber, below hitBad red (ratios 0..1). */
  hitWarn: number;
  hitBad: number;
  /** an error rate at/above errorBad reads red, at/above errorWarn amber (ratios 0..1). */
  errorWarn: number;
  errorBad: number;
  /** Memory section: its title, refresh interval (ms), and embedding coverage ratio below which
   *  it reads amber (Warn) / red (Bad); a started run is "starting" for at most the grace (s). */
  memoryTitle: string;
  memoryPollMs: number;
  memoryCoverageWarn: number;
  memoryCoverageBad: number;
  memoryStartGraceSecs: number;
  /** A job with no progress for this long (s) is STALLED; the rate sparkline keeps at most memoryHistoryLen samples. */
  memoryStallSecs: number;
  memoryHistoryLen: number;
  /** Size (px) of the progress ring on a job tile. */
  memoryRingPx: number;
}

/** The shipped probe fallbacks, kept only for when the defaults file is missing a key. */
const SHIPPED_PROBE = {
  timeoutStrikes: 3,
  tcpTimeoutMs: 3000,
  stallLogMs: 1000,
} as const;

/** The local-server probe policy (`router.cockpit.probe`), read where the router builds its limits. */
export interface CockpitProbe {
  /** consecutive probe timeouts after which a local server is shown down. */
  timeoutStrikes: number;
  /** TCP connect timeout of the local-server probe (ms). */
  tcpTimeoutMs: number;
  /** an event-loop stall longer than this is written to the router log (ms). */
  stallLogMs: number;
}

export function cockpitProbeSettings(): CockpitProbe {
  const s = (() => {
    const p = cockpitSection().probe;
    return typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  })();
  return {
    timeoutStrikes: num(s, "timeoutStrikes", SHIPPED_PROBE.timeoutStrikes),
    tcpTimeoutMs: num(s, "tcpTimeoutMs", SHIPPED_PROBE.tcpTimeoutMs),
    stallLogMs: num(s, "stallLogMs", SHIPPED_PROBE.stallLogMs),
  };
}

export function cockpitLayout(): CockpitLayout {
  const s = layoutSection();
  return {
    gaugeMinWidthPx: num(s, "gaugeMinWidthPx", SHIPPED.gaugeMinWidthPx),
    gaugeMaxWidthPx: num(s, "gaugeMaxWidthPx", SHIPPED.gaugeMaxWidthPx),
    ringMinWidthPx: num(s, "ringMinWidthPx", SHIPPED.ringMinWidthPx),
    palette: hexColors(s, "palette", [...SHIPPED.palette]),
    sessionTitleMaxWidthPx: num(s, "sessionTitleMaxWidthPx", SHIPPED.sessionTitleMaxWidthPx),
    sparkHeightPx: num(s, "sparkHeightPx", SHIPPED.sparkHeightPx),
    sparkViewMaxPx: num(s, "sparkViewMaxPx", SHIPPED.sparkViewMaxPx),
    sparkPlotHeightPx: num(s, "sparkPlotHeightPx", SHIPPED.sparkPlotHeightPx),
    sparkPlotTopPx: numZ(s, "sparkPlotTopPx", SHIPPED.sparkPlotTopPx),
    donutSizePx: num(s, "donutSizePx", SHIPPED.donutSizePx),
    donutRadiusPx: num(s, "donutRadiusPx", SHIPPED.donutRadiusPx),
    donutStrokePx: num(s, "donutStrokePx", SHIPPED.donutStrokePx),
    donutViewBoxPx: num(s, "donutViewBoxPx", SHIPPED.donutViewBoxPx),
    minLabelGapPx: numZ(s, "minLabelGapPx", SHIPPED.minLabelGapPx),
    minBarPx: numZ(s, "minBarPx", SHIPPED.minBarPx),
    sysHistoryLen: num(s, "sysHistoryLen", SHIPPED.sysHistoryLen),
    dailyDays: num(s, "dailyDays", SHIPPED.dailyDays),
    sessionsRows: num(s, "sessionsRows", SHIPPED.sessionsRows),
    sessionsTopRows: num(s, "sessionsTopRows", SHIPPED.sessionsTopRows),
    sessionNameMaxPct: num(s, "sessionNameMaxPct", SHIPPED.sessionNameMaxPct),
    workerRows: num(s, "workerRows", SHIPPED.workerRows),
    lowRequestMin: numZ(s, "lowRequestMin", SHIPPED.lowRequestMin),
    colorPruneDays: num(s, "colorPruneDays", SHIPPED.colorPruneDays),
    pollMs: num(s, "pollMs", SHIPPED.pollMs),
    limitsPollMs: num(s, "limitsPollMs", SHIPPED.limitsPollMs),
    poolPollMs: num(s, "poolPollMs", SHIPPED.poolPollMs),
    clockTickMs: num(s, "clockTickMs", SHIPPED.clockTickMs),
    stampStaleSecs: num(s, "stampStaleSecs", SHIPPED.stampStaleSecs),
    holdLastGoodSecs: numZ(s, "holdLastGoodSecs", SHIPPED.holdLastGoodSecs),
    jobPollMs: num(s, "jobPollMs", SHIPPED.jobPollMs),
    jobFirstDelayMs: numZ(s, "jobFirstDelayMs", SHIPPED.jobFirstDelayMs),
    jobMaxTries: num(s, "jobMaxTries", SHIPPED.jobMaxTries),
    serverCounterStaleSecs: num(s, "serverCounterStaleSecs", SHIPPED.serverCounterStaleSecs),
    gaugeWarnPct: numZ(s, "gaugeWarnPct", SHIPPED.gaugeWarnPct),
    gaugeBadPct: numZ(s, "gaugeBadPct", SHIPPED.gaugeBadPct),
    hitWarn: numZ(s, "hitWarn", SHIPPED.hitWarn),
    hitBad: numZ(s, "hitBad", SHIPPED.hitBad),
    errorWarn: numZ(s, "errorWarn", SHIPPED.errorWarn),
    errorBad: numZ(s, "errorBad", SHIPPED.errorBad),
    memoryTitle: str(s, "memoryTitle", SHIPPED.memoryTitle),
    memoryPollMs: num(s, "memoryPollMs", SHIPPED.memoryPollMs),
    memoryCoverageWarn: numZ(s, "memoryCoverageWarn", SHIPPED.memoryCoverageWarn),
    memoryCoverageBad: numZ(s, "memoryCoverageBad", SHIPPED.memoryCoverageBad),
    memoryStartGraceSecs: numZ(s, "memoryStartGraceSecs", SHIPPED.memoryStartGraceSecs),
    memoryStallSecs: num(s, "memoryStallSecs", SHIPPED.memoryStallSecs),
    memoryHistoryLen: num(s, "memoryHistoryLen", SHIPPED.memoryHistoryLen),
    memoryRingPx: num(s, "memoryRingPx", SHIPPED.memoryRingPx),
  };
}
