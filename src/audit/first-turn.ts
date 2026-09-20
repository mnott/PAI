/**
 * first-turn.ts — where a turn's context actually comes from, attributed
 * line by line from the transcript.
 *
 * The API reports one number per assistant turn (cache_read + cache_creation
 * + input). The transcript holds the pieces Claude Code injected since the
 * previous turn: SessionStart / UserPromptSubmit hook output, the skill
 * listing, the deferred-tool name list, MCP server instructions, the human
 * prompt, any isMeta expansion (a skill body, a pasted slash-command result),
 * tool results, and the previous turn's own visible output (re-sent as
 * context on every later turn). Each of those is counted in cl100k here;
 * what is left over is the system prompt, the built-in tool schemas, agents
 * and memory files, which never appear in the transcript.
 *
 * Only the live lineage counts. Lines chain by parentUuid, and a prompt the
 * user abandoned before a reply (Escape, re-submit) leaves a dead branch
 * whose lines were never sent — run 9 measured a session whose first
 * /Name was abandoned and read 24k where the true baseline is 30k, because
 * the 3.5k-token skill listing sat on the dead branch.
 *
 * `type:"system"` lines with subtype local_command hold a slash command's
 * raw stdout, and the model receives it verbatim in addition to the isMeta
 * markdown copy — run 11 measured both present on the same turn, so both are
 * counted.
 */

import { readFileSync, existsSync } from "node:fs";
import { countTokens } from "./tokens.js";

export type FirstTurnKind =
  | "hook:SessionStart"
  | "hook:UserPromptSubmit"
  | "hook:other"
  | "skill_listing"
  | "deferred_tools"
  | "mcp_instructions"
  | "attachment:other"
  | "prompt"
  | "prompt:meta"
  | "prompt:local_command"
  | "system:display-only"
  | "tool_result"
  | "assistant:prev";

export interface FirstTurnItem {
  kind: FirstTurnKind;
  tokens: number;
  /** Hook name, attachment type, or the first 40 chars of a prompt. */
  label: string;
}

export interface FirstTurnBreakdown {
  path: string;
  /** cache_read + cache_creation + input on the first assistant turn; null if none. */
  apiContext: number | null;
  items: FirstTurnItem[];
  /** Sum of every live-lineage item except system:display-only. */
  transcriptTokens: number;
  /** Per-kind sums over the live lineage (display-only excluded). */
  byKind: Partial<Record<FirstTurnKind, number>>;
  /** apiContext - transcriptTokens: system prompt, tool schemas, agents, memory (+ tokenizer delta). */
  remainder: number | null;
  /** Tokens on abandoned branches before the first turn — persisted but never sent. */
  deadBranchTokens: number;
  deadBranchLines: number;
}

/** Per-turn attribution of one API call's context growth (turn 2+; turn 1 reduces to the FirstTurnBreakdown shape). */
export interface TurnBreakdown {
  path: string;
  turn: number;
  /** cache_read + cache_creation + input on this turn's API call. */
  apiContext: number | null;
  /** Same, for the previous API call; 0 for turn 1. */
  prevApiContext: number;
  /** apiContext - prevApiContext; null if this turn has no usage. */
  billedDelta: number | null;
  /** Previous call's usage.output_tokens (includes thinking); 0 for turn 1. */
  prevOutputTokens: number;
  items: FirstTurnItem[];
  /** Sum of every item except system:display-only. */
  transcriptTokens: number;
  byKind: Partial<Record<FirstTurnKind, number>>;
  /** cl100k count of the previous call's visible text + tool_use input (the assistant:prev item); not part of transcriptTokens. */
  prevVisibleTokens: number;
  /**
   * billedDelta - transcriptTokens - prevOutputTokens. transcriptTokens
   * excludes assistant:prev (the previous call's visible output is only
   * present via prevOutputTokens, which also covers its redacted thinking),
   * so this is a single-count residual: positive means cl100k undercounts
   * the billing tokenizer for this turn's content; negative means the
   * previous call's thinking was not re-sent (thinking is only re-sent
   * inside a tool-use loop, not after a turn-ending text reply).
   */
  residual: number | null;
}

interface ContentBlock {
  type?: string;
  text?: string;
  input?: unknown;
}

interface Line {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  content?: string;
  attachment?: {
    type?: string;
    hookName?: string;
    stdout?: string;
    content?: string;
    addedNames?: string[];
    instructions?: unknown;
    addedInstructions?: unknown;
  };
  message?: {
    id?: string;
    content?: unknown;
    usage?: {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

function parseLines(path: string): Line[] {
  const lines: Line[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      /* skip */
    }
  }
  return lines;
}

function classify(line: Line): FirstTurnItem | null {
  if (line.type === "attachment") {
    const a = line.attachment ?? {};
    switch (a.type) {
      case "hook_success": {
        const name = a.hookName ?? "";
        const kind: FirstTurnKind = name.startsWith("SessionStart")
          ? "hook:SessionStart"
          : name.startsWith("UserPromptSubmit")
            ? "hook:UserPromptSubmit"
            : "hook:other";
        return { kind, tokens: countTokens(a.stdout ?? a.content ?? ""), label: name };
      }
      case "skill_listing":
        return { kind: "skill_listing", tokens: countTokens(a.content ?? ""), label: "skill_listing" };
      case "deferred_tools_delta":
        return { kind: "deferred_tools", tokens: countTokens((a.addedNames ?? []).join("\n")), label: "deferred_tools_delta" };
      case "mcp_instructions_delta":
        return {
          kind: "mcp_instructions",
          tokens: countTokens(JSON.stringify(a.instructions ?? a.addedInstructions ?? a)),
          label: "mcp_instructions_delta",
        };
      default:
        return { kind: "attachment:other", tokens: countTokens(JSON.stringify(a)), label: a.type ?? "attachment" };
    }
  }
  if (line.type === "user") {
    const c = line.message?.content;
    const isToolResult = Array.isArray(c) && (c as ContentBlock[]).some((b) => b?.type === "tool_result");
    const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
    return {
      kind: isToolResult ? "tool_result" : line.isMeta ? "prompt:meta" : "prompt",
      tokens: countTokens(text),
      label: text.slice(0, 40).replace(/\s+/g, " "),
    };
  }
  if (line.type === "system") {
    const kind: FirstTurnKind = line.subtype === "local_command" ? "prompt:local_command" : "system:display-only";
    return { kind, tokens: countTokens(line.content ?? ""), label: line.subtype ?? "system" };
  }
  return null;
}

function apiContextOf(usage: NonNullable<Line["message"]>["usage"]): number | null {
  if (!usage) return null;
  return (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.input_tokens ?? 0);
}

/**
 * Attribute API call `turn`'s context growth to the transcript lines
 * injected since the previous call. Turn numbering matches
 * session-usage.ts's `turnIndex`: several assistant lines sharing one
 * message.id (one line per streamed content block) are one call. Returns
 * null if the transcript has fewer than `turn` calls.
 */
export function turnBreakdown(path: string, turn: number): TurnBreakdown | null {
  if (!existsSync(path)) return null;
  const lines = parseLines(path);
  const byUuid = new Map<string, Line>();
  for (const l of lines) if (l.uuid) byUuid.set(l.uuid, l);

  const seen = new Set<string>();
  let n = 0;
  let target: Line | null = null;
  for (const l of lines) {
    if (l.type === "assistant" && l.message?.usage) {
      const id = l.message.id ?? l.uuid ?? "";
      if (!seen.has(id)) {
        seen.add(id);
        n++;
        if (n === turn) {
          target = l;
          break;
        }
      }
    }
  }
  if (!target) return null;

  // Walk parentUuid back, collecting the live lineage since the previous
  // call, until an assistant-with-usage line (a block of the previous call)
  // is hit.
  const rawChain: Line[] = [];
  let prevLine: Line | null = null;
  let cur = target.parentUuid ? byUuid.get(target.parentUuid) : undefined;
  while (cur) {
    if (cur.type === "assistant" && cur.message?.usage) {
      prevLine = cur;
      break;
    }
    rawChain.unshift(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }

  const items: FirstTurnItem[] = [];
  for (const l of rawChain) {
    const item = classify(l);
    if (item) items.push(item);
  }

  let prevApiContext = 0;
  let prevOutputTokens = 0;
  if (prevLine) {
    prevApiContext = apiContextOf(prevLine.message?.usage) ?? 0;
    prevOutputTokens = prevLine.message?.usage?.output_tokens ?? 0;

    // Gather every content-block line of the previous call (streaming can
    // split one call's thinking/text/tool_use blocks across several lines
    // chained by parentUuid, all sharing one message.id).
    const prevId = prevLine.message?.id ?? prevLine.uuid ?? "";
    const prevBlocks: Line[] = [prevLine];
    let cur2 = prevLine.parentUuid ? byUuid.get(prevLine.parentUuid) : undefined;
    while (cur2 && cur2.type === "assistant" && (cur2.message?.id ?? cur2.uuid ?? "") === prevId) {
      prevBlocks.unshift(cur2);
      cur2 = cur2.parentUuid ? byUuid.get(cur2.parentUuid) : undefined;
    }

    let prevText = "";
    let thinkingCount = 0;
    for (const b of prevBlocks) {
      const content = b.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        if (block?.type === "text") prevText += block.text ?? "";
        else if (block?.type === "tool_use") prevText += JSON.stringify(block.input ?? {});
        else if (block?.type === "thinking") thinkingCount++;
      }
    }
    const label = thinkingCount > 0 ? `previous call output (${thinkingCount} thinking block(s) redacted)` : "previous call output";
    items.push({ kind: "assistant:prev", tokens: countTokens(prevText), label });
  }

  const byKind: Partial<Record<FirstTurnKind, number>> = {};
  let transcriptTokens = 0;
  let prevVisibleTokens = 0;
  for (const item of items) {
    if (item.kind === "system:display-only") continue;
    if (item.kind === "assistant:prev") {
      prevVisibleTokens = item.tokens;
      continue;
    }
    transcriptTokens += item.tokens;
    byKind[item.kind] = (byKind[item.kind] ?? 0) + item.tokens;
  }

  const apiContext = apiContextOf(target.message?.usage);
  const billedDelta = apiContext === null ? null : apiContext - prevApiContext;
  const residual = billedDelta === null ? null : billedDelta - transcriptTokens - prevOutputTokens;

  return {
    path,
    turn,
    apiContext,
    prevApiContext,
    billedDelta,
    prevOutputTokens,
    items,
    transcriptTokens,
    byKind,
    prevVisibleTokens,
    residual,
  };
}

/** Attribute the first assistant turn's context to the transcript lines on its live lineage. */
export function firstTurnBreakdown(path: string): FirstTurnBreakdown {
  const empty: FirstTurnBreakdown = {
    path,
    apiContext: null,
    items: [],
    transcriptTokens: 0,
    byKind: {},
    remainder: null,
    deadBranchTokens: 0,
    deadBranchLines: 0,
  };
  if (!existsSync(path)) return empty;

  const tb = turnBreakdown(path, 1);
  if (!tb) return empty;

  const lines = parseLines(path);
  const byUuid = new Map<string, Line>();
  let firstIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.uuid) byUuid.set(l.uuid, l);
    if (l.type === "assistant" && l.message?.usage && firstIndex < 0) firstIndex = i;
  }
  if (firstIndex < 0) return empty;
  const first = lines[firstIndex];

  const live = new Set<Line>();
  let cur = first.parentUuid ? byUuid.get(first.parentUuid) : undefined;
  while (cur && !live.has(cur)) {
    live.add(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }

  let deadBranchTokens = 0;
  let deadBranchLines = 0;
  for (let i = 0; i < firstIndex; i++) {
    const l = lines[i];
    if (!l.uuid || live.has(l)) continue;
    const item = classify(l);
    if (!item || item.kind === "system:display-only") continue;
    deadBranchLines++;
    deadBranchTokens += item.tokens;
  }

  return {
    path,
    apiContext: tb.apiContext,
    items: tb.items,
    transcriptTokens: tb.transcriptTokens,
    byKind: tb.byKind,
    remainder: tb.residual,
    deadBranchTokens,
    deadBranchLines,
  };
}

/** One-line evidence string for the combined report's first-turn finding. */
export function firstTurnEvidence(b: FirstTurnBreakdown): string {
  const parts: string[] = [];
  const order: FirstTurnKind[] = [
    "skill_listing",
    "mcp_instructions",
    "deferred_tools",
    "hook:SessionStart",
    "hook:UserPromptSubmit",
    "hook:other",
    "prompt:meta",
    "prompt:local_command",
    "prompt",
    "attachment:other",
  ];
  for (const k of order) {
    const v = b.byKind[k];
    if (v) parts.push(`${k} ${v}`);
  }
  const dead = b.deadBranchTokens > 0 ? `; dead-branch ${b.deadBranchTokens} not sent` : "";
  return `transcript-side ${b.transcriptTokens} (${parts.join(", ")}), remainder ${b.remainder ?? "n/a"}${dead}`;
}
