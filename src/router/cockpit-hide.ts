/**
 * cockpit-hide.ts — the operator's hide rules of the cockpit (`router.cockpit.hide` in the main config).
 * A rule hides rows whose text contains `match` (case-insensitive substring, or `/regex/` / `/regex/i`) in the
 * lists it names (sessions, runs, timeline, search; default all). Policy lives in config; this module is the
 * validation, the read/write through the config layer and the matcher the search endpoint applies server side.
 * The page carries the same matcher in ES5 (script-hide.ts).
 */

import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { setConfigValueOp } from "../config/main-config-ops.js";

export const HIDE_LISTS = ["sessions", "runs", "timeline", "search"] as const;
export type HideList = (typeof HIDE_LISTS)[number];

export interface HideRule {
  match: string;
  in: HideList[];
  note?: string;
}

export class HideRuleError extends Error {}

const MATCH_MAX = 200;
const NOTE_MAX = 300;
const MAX_RULES = 200;

/** A `/body/flags` pattern compiled case-insensitively; null when the match is a plain substring. */
export function hideRegex(match: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(match);
  if (!m) return null;
  const flags = m[2]!.includes("i") ? m[2]! : m[2]! + "i";
  return new RegExp(m[1]!, flags);
}

/** Validates a rule list from the page or the config; throws HideRuleError naming the offending rule. */
export function parseHideRules(raw: unknown): HideRule[] {
  if (!Array.isArray(raw)) throw new HideRuleError("rules must be a list");
  if (raw.length > MAX_RULES) throw new HideRuleError(`at most ${MAX_RULES} rules`);
  return raw.map((r, i) => {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new HideRuleError(`${at}: must be an object`);
    const { match, in: lists, note } = r as { match?: unknown; in?: unknown; note?: unknown };
    if (typeof match !== "string" || !match.trim()) throw new HideRuleError(`${at}: match must be a non-empty text`);
    if (match.length > MATCH_MAX) throw new HideRuleError(`${at}: match is longer than ${MATCH_MAX} characters`);
    try {
      hideRegex(match);
    } catch (e) {
      throw new HideRuleError(`${at}: invalid regex ${match}: ${(e as Error).message}`);
    }
    let inn: HideList[] = [...HIDE_LISTS];
    if (lists !== undefined) {
      if (!Array.isArray(lists) || !lists.length || !lists.every((l) => (HIDE_LISTS as readonly unknown[]).includes(l))) {
        throw new HideRuleError(`${at}: in must be a non-empty list of ${HIDE_LISTS.join(", ")}`);
      }
      inn = HIDE_LISTS.filter((l) => lists.includes(l));
    }
    if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX)) throw new HideRuleError(`${at}: note must be a text of at most ${NOTE_MAX} characters`);
    return { match: match.trim() === match ? match : match.trim(), in: inn, ...(note ? { note } : {}) };
  });
}

/** The configured rules; a malformed config entry is dropped, never thrown (the page must still load). */
export function readHideRules(): HideRule[] {
  try {
    const r = effectiveMainConfig(paiConfigFilePath()).router as Record<string, any> | undefined;
    const raw = r?.cockpit?.hide;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
      try {
        return parseHideRules([x]);
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** Replaces the whole list in the user's main config. */
export function writeHideRules(rules: HideRule[]): void {
  setConfigValueOp("router.cockpit.hide", JSON.stringify(rules));
}

/** (list, text) → true when a rule for that list matches the text. */
export function hideMatcher(rules: HideRule[]): (list: HideList, text: string) => boolean {
  const compiled = rules.map((r) => ({ in: r.in, re: hideRegex(r.match), sub: r.match.toLowerCase() }));
  return (list, text) => {
    const low = text.toLowerCase();
    return compiled.some((c) => c.in.includes(list) && (c.re ? c.re.test(text) : low.includes(c.sub)));
  };
}
