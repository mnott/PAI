/**
 * notice-policy.ts — the policy values of the notice path (the PAILot gate,
 * the run/queue reporters, the worker trouble notices). They live in the
 * shipped defaults file (src/config/defaults/config.yaml, `notices` section)
 * and are read through the main-config loader (effectiveMainConfig over
 * paiConfigFilePath(), so PAI_CONFIG_FILE and a user config.yaml/json win),
 * resolved at call time — never as constants in code.
 */

import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";

/** The `notices` subtree of the effective main config; {} when unreadable. */
function noticesSection(): Record<string, unknown> {
  try {
    const n = effectiveMainConfig(paiConfigFilePath()).notices;
    return typeof n === "object" && n !== null && !Array.isArray(n) ? (n as Record<string, unknown>) : {};
  } catch {
    // a damaged user config must not silence notices: the shipped defaults stand alone
    return {};
  }
}

/** A positive number from the config subtree, else the shipped fallback. */
function num(section: Record<string, unknown>, key: string, fallback: number): number {
  const v = section[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The shipped values, kept only as the fallback when the defaults file is
 *  missing a key; the file is the source of truth. */
const SHIPPED = {
  pailotMaxPerMinute: 5,
  pailotDedupHours: 24,
  pailotWindowSecs: 60,
  planGroupThrottleMinutes: 15,
  queueReadyBatchMinutes: 10,
  troubleThrottleMinutes: 5,
  denialWindowMinutes: 10,
  denialThreshold: 3,
  stallMinutes: 10,
} as const;

export interface PailotPolicy {
  /** Messages that may leave per window, from all PAI processes. */
  maxPerMinute: number;
  /** How long a sent text stays a duplicate. */
  dedupMs: number;
  /** The rate window. */
  windowMs: number;
}

export function pailotPolicy(): PailotPolicy {
  const p = noticesSection().pailot;
  const s = typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  return {
    maxPerMinute: num(s, "maxPerMinute", SHIPPED.pailotMaxPerMinute),
    dedupMs: num(s, "dedupHours", SHIPPED.pailotDedupHours) * 3_600_000,
    windowMs: num(s, "windowSecs", SHIPPED.pailotWindowSecs) * 1_000,
  };
}

export interface RunReportPolicy {
  /** At most one grouped unit-done message per this span. */
  planGroupThrottleMs: number;
  /** Ready queue items batch into one message per this span. */
  queueReadyBatchMs: number;
}

export function runReportPolicy(): RunReportPolicy {
  const r = noticesSection().runReports;
  const s = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
  return {
    planGroupThrottleMs: num(s, "planGroupThrottleMinutes", SHIPPED.planGroupThrottleMinutes) * 60_000,
    queueReadyBatchMs: num(s, "queueReadyBatchMinutes", SHIPPED.queueReadyBatchMinutes) * 60_000,
  };
}

export interface TroublePolicy {
  /** At most one trouble message per worker per this span (hard stops bypass). */
  throttleMs: number;
  /** Denials count towards the threshold within this span. */
  denialWindowMs: number;
  /** Denials in the window before the session is told. */
  denialThreshold: number;
  /** Quiet this long while running tells once. */
  stallMs: number;
}

export function troublePolicy(): TroublePolicy {
  const t = noticesSection().trouble;
  const s = typeof t === "object" && t !== null && !Array.isArray(t) ? (t as Record<string, unknown>) : {};
  return {
    throttleMs: num(s, "throttleMinutes", SHIPPED.troubleThrottleMinutes) * 60_000,
    denialWindowMs: num(s, "denialWindowMinutes", SHIPPED.denialWindowMinutes) * 60_000,
    denialThreshold: num(s, "denialThreshold", SHIPPED.denialThreshold),
    stallMs: num(s, "stallMinutes", SHIPPED.stallMinutes) * 60_000,
  };
}
