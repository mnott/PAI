/**
 * denials.ts — hook/permission denials a worker ran into, recorded by the
 * runner so orchestrators can fix specs that contradict the worker contract
 * and turn recurring ones into deterministic rules.
 *
 * Detection happens on the stream-json tool_result (see run.ts); this file is
 * pure: text → denial, denial list → specConflict flags.
 */

export interface Denial {
  at: string;
  tool: string;
  hook: string;
  /** First ~120 chars of the denied input (command, file_path, …). */
  input: string;
  /** First ~200 chars of the denial reason. */
  reason: string;
  specConflict: boolean;
}

/** Entries kept per run; `denialCount` on the status keeps the true total. */
export const MAX_DENIALS = 50;
const MIN_SPEC_OVERLAP = 20;

/**
 * Claude Code's denial texts: `PreToolUse:<Tool> hook error: [<hook>]: <reason>`
 * (also "hook blocking error from command"), the `<prog>: command denied by
 * permission rules` shape, and the plain permission-denied sentences.
 */
export function parseDenialText(
  text: string,
  fallbackTool = "?"
): { tool: string; hook: string; reason: string } | null {
  const pre = text.match(/^PreToolUse:(\S+) hook (?:blocking )?error(?: from command)?:\s*(?:\[([^\]]*)\]:?\s*)?([\s\S]*)/);
  if (pre) return { tool: pre[1], hook: pre[2] ?? "hook", reason: pre[3].trim() };
  const rules = text.match(/(?:^|\n)(\S+): command denied by permission rules/);
  if (rules) return { tool: fallbackTool, hook: rules[1], reason: text.trim() };
  if (/Permission to use \S+ has been denied|requested permissions to use \S+, but you haven't granted/.test(text)) {
    return { tool: fallbackTool, hook: "permission", reason: text.trim() };
  }
  return null;
}

/** The denied input as one short line: command / file_path / path / pattern / url, else JSON. */
export function denialInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  const key = ["command", "file_path", "path", "pattern", "url"].find((k) => typeof o[k] === "string");
  return (key ? String(o[key]) : JSON.stringify(o)).replace(/\s+/g, " ").slice(0, 120);
}

const normalizeReason = (r: string): string => r.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * specConflict: the denial is likely the orchestrator's spec contradicting the
 * worker contract, not a worker mistake. True when
 *  (a) the same (hook, tool, normalized reason) was denied 2+ times in the run, or
 *  (b) the denied input shares a >= 20 char verbatim substring with the spec/prompt.
 * Sets the flag on every entry it matches, so the first occurrence of a
 * repeated denial is flagged too. Cheap enough: O(input × spec) on ≤120 chars.
 */
export function markSpecConflicts(denials: Denial[], spec: string | null): void {
  const key = (d: Denial): string => `${d.hook}\0${d.tool}\0${normalizeReason(d.reason)}`;
  const seen = new Map<string, number>();
  for (const d of denials) seen.set(key(d), (seen.get(key(d)) ?? 0) + 1);
  for (const d of denials) {
    d.specConflict = (seen.get(key(d)) ?? 0) >= 2 || sharesSubstring(d.input, spec ?? "");
  }
}

function sharesSubstring(input: string, spec: string): boolean {
  for (let i = 0; i + MIN_SPEC_OVERLAP <= input.length; i++) {
    if (spec.includes(input.slice(i, i + MIN_SPEC_OVERLAP))) return true;
  }
  return false;
}

/** Status fields the recorder owns. */
export interface DenialStatus {
  denials?: Denial[];
  denialCount?: number;
}

/**
 * Record one tool_result block when it is a denial. `uses` maps tool_use ids to
 * the tool name and input. Returns whether the status changed.
 */
export function recordDenial(
  status: DenialStatus,
  block: { tool_use_id?: string; is_error?: boolean; content?: unknown },
  text: string,
  uses: Map<string, { name: string; input: unknown }>,
  spec: string | null,
  at: string
): boolean {
  if (block.is_error !== true) return false;
  const use = block.tool_use_id ? uses.get(block.tool_use_id) : undefined;
  const p = parseDenialText(text, use?.name ?? "?");
  if (!p) return false;
  const list = (status.denials ??= []);
  status.denialCount = (status.denialCount ?? 0) + 1;
  if (list.length < MAX_DENIALS) {
    list.push({
      at,
      tool: use?.name ?? p.tool,
      hook: p.hook,
      input: denialInput(use?.input),
      reason: p.reason.slice(0, 200),
      specConflict: false,
    });
  }
  markSpecConflicts(list, spec);
  return true;
}

/** `denied N` plus `spec?` when any entry looks like a spec conflict; "" when none. */
export function denialMark(s: DenialStatus): string {
  const n = s.denialCount ?? s.denials?.length ?? 0;
  if (n <= 0) return "";
  return `denied ${n}${s.denials?.some((d) => d.specConflict) ? " spec?" : ""}`;
}

/** Replay lines: one per recorded denial, `!` marking a likely spec conflict. */
export function denialLines(s: DenialStatus): string[] {
  const list = s.denials ?? [];
  if (!list.length) return [];
  const more = (s.denialCount ?? list.length) - list.length;
  return [
    `  ${denialMark(s)}:`,
    ...list.map((d) => `  ${d.specConflict ? "!" : " "} ${d.at.slice(11, 19)} ${d.tool} [${d.hook}] ${d.input} — ${d.reason}`),
    ...(more > 0 ? [`    … ${more} more`] : []),
  ];
}
