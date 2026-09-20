/**
 * session-usage.ts — parse the usage numbers out of a Claude Code session
 * (or subagent, or pai-worker event-mirror) JSONL transcript.
 *
 * All three log shapes share the same assistant-message envelope
 * ({ type: "assistant", message: { id, model, usage } }), so one parser
 * covers `pai audit tokens session` and the per-log readings feeding
 * `pai audit tokens spawn`.
 *
 * Streaming writes one JSONL line per content block of the same logical
 * turn, repeating message.id and usage each time — summing every line would
 * multiply usage by the block count. Keeping only the first line seen per
 * message.id is what the reference script (and this parser) count instead.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

export interface UsageTotals {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CacheCreationSplit {
  ephemeral5m: number;
  ephemeral1h: number;
}

export interface CompactionEvent {
  trigger: string;
  preTokens: number;
  turnIndex: number;
}

export interface SessionUsageReport {
  path: string;
  sizeBytes: number;
  turns: number;
  totals: UsageTotals;
  /** Per-model assistant-turn counts. */
  models: Record<string, number>;
  /** cache_read + cache_creation + input on the first / last assistant turn seen. */
  firstTurnContext: number | null;
  lastTurnContext: number | null;
  cacheCreationSplit: CacheCreationSplit;
  /** Average / max of the per-turn context value across all turns; null if no turns. */
  avgContext: number | null;
  maxContext: number | null;
  /** Turns whose per-turn context value exceeds the report's threshold. */
  turnsAboveThreshold: number;
  /** Turns whose cache_creation_input_tokens exceeds 20000. */
  cacheRebuildTurns: number;
  /** Real human-authored user prompts (excludes tool-result-only "user" lines). */
  userPrompts: number;
  /**
   * Sum over assistant turns of the real user prompts seen before that turn;
   * multiplied by per-prompt hook tokens it gives the tokens UserPromptSubmit
   * output occupied across the whole session.
   */
  promptExposure: number;
  compactions: CompactionEvent[];
}

const USAGE_KEYS: (keyof UsageTotals)[] = [
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "input_tokens",
  "output_tokens",
];

function emptyTotals(): UsageTotals {
  return { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 };
}

interface AssistantLine {
  type?: string;
  uuid?: string;
  subtype?: string;
  compactMetadata?: { trigger?: string; preTokens?: number };
  message?: {
    id?: string;
    model?: string;
    usage?: Record<string, unknown> & {
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
    content?: string | Array<{ type?: string }>;
  };
}

/**
 * `type:"system"` `subtype:"compact_boundary"` lines mark a compaction.
 * turnIndex is the count of assistant turns already folded when it fired,
 * so it lines up with the turn numbering the text/JSON report prints.
 */
export function isCompactBoundary(line: AssistantLine): boolean {
  return line.type === "system" && line.subtype === "compact_boundary";
}

export function parseCompactionEvent(line: AssistantLine, turnIndex: number): CompactionEvent | null {
  const meta = line.compactMetadata;
  if (!meta || typeof meta.preTokens !== "number") return null;
  return { trigger: meta.trigger ?? "unknown", preTokens: meta.preTokens, turnIndex };
}

/**
 * Fold one already-parsed JSONL line into a report being accumulated.
 * Exported separately so both the streaming file reader below and tests
 * (which build fixtures as arrays of objects, not files) share one path.
 * Returns the turn's context value when a new turn was counted, else null
 * (non-assistant line, no usage, or a duplicate message.id already seen).
 */
export function foldAssistantLine(
  report: Pick<
    SessionUsageReport,
    | "turns"
    | "totals"
    | "models"
    | "firstTurnContext"
    | "lastTurnContext"
    | "cacheCreationSplit"
    | "maxContext"
    | "turnsAboveThreshold"
    | "cacheRebuildTurns"
  >,
  seenIds: Set<string>,
  line: AssistantLine,
  threshold: number
): number | null {
  if (line.type !== "assistant") return null;
  const message = line.message;
  const usage = message?.usage;
  if (!usage) return null;
  const id = message?.id ?? line.uuid;
  if (id) {
    if (seenIds.has(id)) return null;
    seenIds.add(id);
  }
  report.turns++;
  for (const key of USAGE_KEYS) {
    const v = usage[key];
    if (typeof v === "number") report.totals[key] += v;
  }
  const context =
    (Number(usage.cache_read_input_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0) +
    (Number(usage.input_tokens) || 0);
  if (report.firstTurnContext === null) report.firstTurnContext = context;
  report.lastTurnContext = context;
  report.maxContext = report.maxContext === null ? context : Math.max(report.maxContext, context);
  if (context > threshold) report.turnsAboveThreshold++;
  if ((Number(usage.cache_creation_input_tokens) || 0) > 20000) report.cacheRebuildTurns++;
  const model = message?.model ?? "unknown";
  report.models[model] = (report.models[model] ?? 0) + 1;
  const split = usage.cache_creation;
  if (split) {
    report.cacheCreationSplit.ephemeral5m += Number(split.ephemeral_5m_input_tokens) || 0;
    report.cacheCreationSplit.ephemeral1h += Number(split.ephemeral_1h_input_tokens) || 0;
  }
  return context;
}

/**
 * True for a real human-authored `type:"user"` prompt line: content is a
 * plain string, or a content array with no `tool_result` block. Claude Code
 * encodes tool results as `type:"user"` messages whose content array is
 * entirely (or partly) tool_result blocks — those must not count as prompts.
 */
export function isRealUserPrompt(line: AssistantLine): boolean {
  if (line.type !== "user") return false;
  const content = line.message?.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) return !content.some((block) => block?.type === "tool_result");
  return false;
}

/** Parse a session/subagent/worker-event JSONL file into a usage report. */
export async function parseSessionUsage(path: string, threshold = 200_000): Promise<SessionUsageReport> {
  const report: SessionUsageReport = {
    path,
    sizeBytes: existsSync(path) ? readFileSync(path).byteLength : 0,
    turns: 0,
    totals: emptyTotals(),
    models: {},
    firstTurnContext: null,
    lastTurnContext: null,
    cacheCreationSplit: { ephemeral5m: 0, ephemeral1h: 0 },
    avgContext: null,
    maxContext: null,
    turnsAboveThreshold: 0,
    cacheRebuildTurns: 0,
    userPrompts: 0,
    promptExposure: 0,
    compactions: [],
  };
  const seenIds = new Set<string>();
  let contextSum = 0;

  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    let obj: AssistantLine;
    try {
      obj = JSON.parse(raw) as AssistantLine;
    } catch {
      continue;
    }
    if (obj.type === "user") {
      if (isRealUserPrompt(obj)) report.userPrompts++;
      continue;
    }
    if (isCompactBoundary(obj)) {
      const event = parseCompactionEvent(obj, report.turns);
      if (event) report.compactions.push(event);
      continue;
    }
    const context = foldAssistantLine(report, seenIds, obj, threshold);
    if (context !== null) {
      contextSum += context;
      report.promptExposure += report.userPrompts;
    }
  }
  report.avgContext = report.turns > 0 ? Math.round(contextSum / report.turns) : null;
  return report;
}

export function totalUsageTokens(totals: UsageTotals): number {
  return totals.cache_read_input_tokens + totals.cache_creation_input_tokens + totals.input_tokens + totals.output_tokens;
}
