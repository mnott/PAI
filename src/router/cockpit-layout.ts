/**
 * cockpit-layout.ts — the policy values of the cockpit layout: grid
 * breakpoints and column counts, tile min/max widths, chart heights,
 * sample/history window lengths, refresh intervals, row limits and fold
 * defaults. They live in the shipped defaults file
 * (src/config/defaults/config.yaml, `router.cockpit.layout` section) and are
 * read through the main-config loader (effectiveMainConfig over
 * paiConfigFilePath(), so PAI_CONFIG_FILE and a user config.yaml/json win),
 * resolved at page-build time — never as constants in code. Pure styling
 * (fonts, colours from the theme mapping) stays in the page's CSS.
 */

import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";

/** The `router.cockpit.layout` subtree of the effective main config; {} when unreadable. */
function layoutSection(): Record<string, unknown> {
  try {
    const r = effectiveMainConfig(paiConfigFilePath()).router;
    const c =
      typeof r === "object" && r !== null && !Array.isArray(r)
        ? (r as Record<string, unknown>).cockpit
        : undefined;
    const l =
      typeof c === "object" && c !== null && !Array.isArray(c)
        ? (c as Record<string, unknown>).layout
        : undefined;
    return typeof l === "object" && l !== null && !Array.isArray(l) ? (l as Record<string, unknown>) : {};
  } catch {
    // a damaged user config must not blank the page: the shipped defaults stand alone
    return {};
  }
}

/** A positive number from the config subtree, else the shipped fallback. */
function num(section: Record<string, unknown>, key: string, fallback: number): number {
  const v = section[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
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

/** A list of non-empty strings (a list of lists for layout.rows), else the fallback. */
function strLists(section: Record<string, unknown>, key: string, fallback: string[][]): string[][] {
  const v = section[key];
  if (!Array.isArray(v)) return fallback;
  const rows: string[][] = [];
  for (const r of v) {
    if (!Array.isArray(r)) continue;
    const names = r.filter((x): x is string => typeof x === "string" && !!x);
    if (names.length) rows.push(names);
  }
  return rows;
}

/** The shipped values, kept only as the fallback when the defaults file is
 *  missing a key; the file is the source of truth. */
const SHIPPED = {
  gridBreakpointPx: 1000,
  minSectionPx: 380,
  gaugeMinWidthPx: 110,
  gaugeMaxWidthPx: 120,
  providerTileMinPx: 260,
  runtimeCardMinPx: 420,
  tilesWideBreakpointPx: 720,
  tilesWideCols: 4,
  tilesNarrowCols: 2,
  tilesOneColBreakpointPx: 339,
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
  bigDonutSizePx: 170,
  donutSizePx: 84,
  donutRadiusPx: 48,
  donutStrokePx: 16,
  donutViewBoxPx: 140,
  // width: the fallback when the container cannot be measured (the chart draws at its
  // real pixel width, so text keeps its size at any width); height: the fixed pixel height.
  tokensChartWidthPx: 760,
  tokensChartHeightPx: 220,
  powerChartWidthPx: 760,
  powerChartHeightPx: 150,
  dailyChartWidthPx: 520,
  dailyChartHeightPx: 200,
  // chart redraw on resize: a width change at or below the slack is ignored; the redraw is debounced
  chartResizeSlackPx: 8,
  chartResizeDebounceMs: 150,
  minLabelGapPx: 48,
  minBarPx: 3,
  sysHistoryLen: 60,
  dailyDays: 14,
  sessionsRows: 20,
  workerRows: 15,
  lowRequestMin: 5,
  // saved model colours older than this (days, by their "@ts" stamp) are pruned
  colorPruneDays: 90,
  pollMs: 5000,
  limitsPollMs: 30000,
  poolPollMs: 15000,
  clockTickMs: 1000,
  stampStaleSecs: 15,
  jobPollMs: 5000,
  jobFirstDelayMs: 2000,
  jobMaxTries: 120,
  serverCounterStaleSecs: 60,
  // an inline confirm (a shared runtime's stop) stays armed this long (ms) before it reverts
  confirmMs: 4000,
  foldDefaultKind: "coding",
  // drag-and-drop tunables (router.cockpit.layout): the rows override is empty
  // by default — the layout derives from the section order and the span classes.
  rows: [] as string[][],
  maxPerRow: 3,
  touchPressMs: 350,
  edgeScrollPx: 40,
  // colour thresholds: at/above Bad colours red, at/above Warn amber, below Warn
  // green. gaugeWarnPct/gaugeBadPct are percentages of a limits gauge; hitWarn/
  // hitBad and errorWarn/errorBad are ratios (0..1) of a hit ratio / error rate.
  gaugeWarnPct: 70,
  gaugeBadPct: 90,
  hitWarn: 0.8,
  hitBad: 0.5,
  errorWarn: 0.02,
  errorBad: 0.1,
} as const;

/** The layout policy of the cockpit page, read at page-build time. */
export interface CockpitLayout {
  /** main grid: 12 columns; cards wider than c8 collapse to full width below this width. */
  gridCols: number;
  gridBreakpointPx: number;
  /** a row of n sections stacks (one per line) only when the main width / n falls
   *  below this; a row of 2 at 822 px stays side by side, a row of 3 stacks. */
  minSectionPx: number;
  /** gauge tiles in the cloud/local flex rows. */
  gaugeMinWidthPx: number;
  gaugeMaxWidthPx: number;
  /** provider group cards in the responsive pgrid. */
  providerTileMinPx: number;
  /** runtime cards in the models rt-grid. */
  runtimeCardMinPx: number;
  /** metric tiles inside a runtime card: wide cols at/above the container breakpoint,
   *  narrow cols below it, one column at/below the one-col breakpoint. */
  tilesWideBreakpointPx: number;
  tilesWideCols: number;
  tilesNarrowCols: number;
  tilesOneColBreakpointPx: number;
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
  /** cache donut: solo size, ring size, radius, stroke, viewBox. */
  bigDonutSizePx: number;
  donutSizePx: number;
  donutRadiusPx: number;
  donutStrokePx: number;
  donutViewBoxPx: number;
  /** chart canvases: width is the fallback when the container cannot be measured (the
   *  svg draws at the container's real pixel width), height is the fixed pixel height. */
  tokensChartWidthPx: number;
  tokensChartHeightPx: number;
  powerChartWidthPx: number;
  powerChartHeightPx: number;
  dailyChartWidthPx: number;
  dailyChartHeightPx: number;
  /** chart redraw on resize: a width change at or below the slack is ignored (px); the
   *  redraw is debounced by this many ms. */
  chartResizeSlackPx: number;
  chartResizeDebounceMs: number;
  minLabelGapPx: number;
  minBarPx: number;
  sysHistoryLen: number;
  /** sample/history windows. */
  dailyDays: number;
  /** table row limits. */
  sessionsRows: number;
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
  /** a local switch/off job: first delay, poll interval, max tries. */
  jobPollMs: number;
  jobFirstDelayMs: number;
  jobMaxTries: number;
  /** a server prefix-cache counter older than this is marked. */
  serverCounterStaleSecs: number;
  /** an inline confirm (a shared runtime's stop) stays armed this long (ms) before it reverts. */
  confirmMs: number;
  /** fold default: a card whose data-def equals this opens, everything else folds. */
  foldDefaultKind: string;
  /** drag-and-drop layout: configured rows (list of section-name lists);
   *  empty = derive from the section order and the span classes. */
  rows: string[][];
  /** a row holds at most this many sections. */
  maxPerRow: number;
  /** on touch, a drag starts after this long press on the grip (ms). */
  touchPressMs: number;
  /** during a drag the page auto-scrolls within this of the viewport edge (px). */
  edgeScrollPx: number;
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
}

export function cockpitLayout(): CockpitLayout {
  const s = layoutSection();
  return {
    gridCols: 12,
    gridBreakpointPx: num(s, "gridBreakpointPx", SHIPPED.gridBreakpointPx),
    minSectionPx: num(s, "minSectionPx", SHIPPED.minSectionPx),
    gaugeMinWidthPx: num(s, "gaugeMinWidthPx", SHIPPED.gaugeMinWidthPx),
    gaugeMaxWidthPx: num(s, "gaugeMaxWidthPx", SHIPPED.gaugeMaxWidthPx),
    providerTileMinPx: num(s, "providerTileMinPx", SHIPPED.providerTileMinPx),
    runtimeCardMinPx: num(s, "runtimeCardMinPx", SHIPPED.runtimeCardMinPx),
    tilesWideBreakpointPx: num(s, "tilesWideBreakpointPx", SHIPPED.tilesWideBreakpointPx),
    tilesWideCols: num(s, "tilesWideCols", SHIPPED.tilesWideCols),
    tilesNarrowCols: num(s, "tilesNarrowCols", SHIPPED.tilesNarrowCols),
    tilesOneColBreakpointPx: num(s, "tilesOneColBreakpointPx", SHIPPED.tilesOneColBreakpointPx),
    ringMinWidthPx: num(s, "ringMinWidthPx", SHIPPED.ringMinWidthPx),
    palette: hexColors(s, "palette", [...SHIPPED.palette]),
    sessionTitleMaxWidthPx: num(s, "sessionTitleMaxWidthPx", SHIPPED.sessionTitleMaxWidthPx),
    sparkHeightPx: num(s, "sparkHeightPx", SHIPPED.sparkHeightPx),
    sparkViewMaxPx: num(s, "sparkViewMaxPx", SHIPPED.sparkViewMaxPx),
    sparkPlotHeightPx: num(s, "sparkPlotHeightPx", SHIPPED.sparkPlotHeightPx),
    sparkPlotTopPx: num(s, "sparkPlotTopPx", SHIPPED.sparkPlotTopPx),
    bigDonutSizePx: num(s, "bigDonutSizePx", SHIPPED.bigDonutSizePx),
    donutSizePx: num(s, "donutSizePx", SHIPPED.donutSizePx),
    donutRadiusPx: num(s, "donutRadiusPx", SHIPPED.donutRadiusPx),
    donutStrokePx: num(s, "donutStrokePx", SHIPPED.donutStrokePx),
    donutViewBoxPx: num(s, "donutViewBoxPx", SHIPPED.donutViewBoxPx),
    tokensChartWidthPx: num(s, "tokensChartWidthPx", SHIPPED.tokensChartWidthPx),
    tokensChartHeightPx: num(s, "tokensChartHeightPx", SHIPPED.tokensChartHeightPx),
    powerChartWidthPx: num(s, "powerChartWidthPx", SHIPPED.powerChartWidthPx),
    powerChartHeightPx: num(s, "powerChartHeightPx", SHIPPED.powerChartHeightPx),
    dailyChartWidthPx: num(s, "dailyChartWidthPx", SHIPPED.dailyChartWidthPx),
    dailyChartHeightPx: num(s, "dailyChartHeightPx", SHIPPED.dailyChartHeightPx),
    chartResizeSlackPx: num(s, "chartResizeSlackPx", SHIPPED.chartResizeSlackPx),
    chartResizeDebounceMs: num(s, "chartResizeDebounceMs", SHIPPED.chartResizeDebounceMs),
    minLabelGapPx: num(s, "minLabelGapPx", SHIPPED.minLabelGapPx),
    minBarPx: num(s, "minBarPx", SHIPPED.minBarPx),
    sysHistoryLen: num(s, "sysHistoryLen", SHIPPED.sysHistoryLen),
    dailyDays: num(s, "dailyDays", SHIPPED.dailyDays),
    sessionsRows: num(s, "sessionsRows", SHIPPED.sessionsRows),
    workerRows: num(s, "workerRows", SHIPPED.workerRows),
    lowRequestMin: num(s, "lowRequestMin", SHIPPED.lowRequestMin),
    colorPruneDays: num(s, "colorPruneDays", SHIPPED.colorPruneDays),
    pollMs: num(s, "pollMs", SHIPPED.pollMs),
    limitsPollMs: num(s, "limitsPollMs", SHIPPED.limitsPollMs),
    poolPollMs: num(s, "poolPollMs", SHIPPED.poolPollMs),
    clockTickMs: num(s, "clockTickMs", SHIPPED.clockTickMs),
    stampStaleSecs: num(s, "stampStaleSecs", SHIPPED.stampStaleSecs),
    jobPollMs: num(s, "jobPollMs", SHIPPED.jobPollMs),
    jobFirstDelayMs: num(s, "jobFirstDelayMs", SHIPPED.jobFirstDelayMs),
    jobMaxTries: num(s, "jobMaxTries", SHIPPED.jobMaxTries),
    serverCounterStaleSecs: num(s, "serverCounterStaleSecs", SHIPPED.serverCounterStaleSecs),
    confirmMs: num(s, "confirmMs", SHIPPED.confirmMs),
    foldDefaultKind: str(s, "foldDefaultKind", SHIPPED.foldDefaultKind),
    rows: strLists(s, "rows", SHIPPED.rows),
    maxPerRow: num(s, "maxPerRow", SHIPPED.maxPerRow),
    touchPressMs: num(s, "touchPressMs", SHIPPED.touchPressMs),
    edgeScrollPx: num(s, "edgeScrollPx", SHIPPED.edgeScrollPx),
    gaugeWarnPct: num(s, "gaugeWarnPct", SHIPPED.gaugeWarnPct),
    gaugeBadPct: num(s, "gaugeBadPct", SHIPPED.gaugeBadPct),
    hitWarn: num(s, "hitWarn", SHIPPED.hitWarn),
    hitBad: num(s, "hitBad", SHIPPED.hitBad),
    errorWarn: num(s, "errorWarn", SHIPPED.errorWarn),
    errorBad: num(s, "errorBad", SHIPPED.errorBad),
  };
}
