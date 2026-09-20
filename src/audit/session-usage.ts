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
  message?: {
    id?: string;
    model?: string;
    usage?: Record<string, unknown> & {
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
  };
}

/**
 * Fold one already-parsed JSONL line into a report being accumulated.
 * Exported separately so both the streaming file reader below and tests
 * (which build fixtures as arrays of objects, not files) share one path.
 */
export function foldAssistantLine(
  report: Pick<SessionUsageReport, "turns" | "totals" | "models" | "firstTurnContext" | "lastTurnContext" | "cacheCreationSplit">,
  seenIds: Set<string>,
  line: AssistantLine
): void {
  if (line.type !== "assistant") return;
  const message = line.message;
  const usage = message?.usage;
  if (!usage) return;
  const id = message?.id ?? line.uuid;
  if (id) {
    if (seenIds.has(id)) return;
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
  const model = message?.model ?? "unknown";
  report.models[model] = (report.models[model] ?? 0) + 1;
  const split = usage.cache_creation;
  if (split) {
    report.cacheCreationSplit.ephemeral5m += Number(split.ephemeral_5m_input_tokens) || 0;
    report.cacheCreationSplit.ephemeral1h += Number(split.ephemeral_1h_input_tokens) || 0;
  }
}

/** Parse a session/subagent/worker-event JSONL file into a usage report. */
export async function parseSessionUsage(path: string): Promise<SessionUsageReport> {
  const report: SessionUsageReport = {
    path,
    sizeBytes: existsSync(path) ? readFileSync(path).byteLength : 0,
    turns: 0,
    totals: emptyTotals(),
    models: {},
    firstTurnContext: null,
    lastTurnContext: null,
    cacheCreationSplit: { ephemeral5m: 0, ephemeral1h: 0 },
  };
  const seenIds = new Set<string>();

  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    let obj: AssistantLine;
    try {
      obj = JSON.parse(raw) as AssistantLine;
    } catch {
      continue;
    }
    foldAssistantLine(report, seenIds, obj);
  }
  return report;
}

export function totalUsageTokens(totals: UsageTotals): number {
  return totals.cache_read_input_tokens + totals.cache_creation_input_tokens + totals.input_tokens + totals.output_tokens;
}
