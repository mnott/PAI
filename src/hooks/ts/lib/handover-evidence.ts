/**
 * Evidence binding for the model-written pre-compaction handover.
 *
 * The handover is prose written by a model about the session. Nothing else
 * checks its claims, and the successor session cannot: by the time it reads
 * the handover, the transcript it describes has been compacted away. This
 * module does the one check that is cheap and deterministic — every
 * checkable identifier in the handover (commit hashes, versions, paths,
 * pids, timestamps, token counts) must appear verbatim in the transcript
 * the handover was written from. Identifiers that do not are reported as
 * unverified. Nothing is ever dropped or rewritten: the reader gets the
 * handover unchanged plus one footer line saying how much of it is
 * anchored in the record.
 *
 * Borrowed from the evidence-binding step of graph extractors that check an
 * LLM's output against the chunk it was given. No model is called.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentToText } from "./transcript-text.js";

export interface EvidenceResult {
  /** Distinct checkable identifiers found in the handover. */
  total: number;
  /** Identifiers present verbatim (after normalisation) in the transcript. */
  found: string[];
  /** Identifiers absent from the transcript — unverified, not wrong. */
  missing: string[];
  /** One line for the reader, never empty. */
  footer: string;
}

/** Minimum identifier length worth checking; shorter strings match by accident. */
const MIN_TOKEN_LENGTH = 4;
/** How many unverified identifiers the footer names before "+N more". */
const FOOTER_NAMED_MISSING = 5;
/** Length of the handover's opening used to recognise its own echo in a tool result. */
const ECHO_HEAD_LENGTH = 80;

/** Markers of text that was injected INTO the session rather than produced by it. */
const INJECTED_MARKERS = [
  "HANDOVER FROM THE PREVIOUS SESSION",
  "MODEL-WRITTEN HANDOVER",
  "SESSION STATE RECOVERED AFTER COMPACTION",
];

/** Tools whose input would contain the handover itself when it targets the handover file. */
const HANDOVER_WRITERS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Identifier classes, in priority order. Each pattern yields either its
 * whole match or capture group 1 when present. Kept deliberately literal:
 * an identifier is something a reader could grep for.
 */
const TOKEN_PATTERNS: RegExp[] = [
  // git hashes: 7-40 hex chars with at least one letter (a plain number is not a hash)
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  // package@version
  /(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(?:-[\w.]+)?/g,
  // semver
  /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/g,
  // absolute paths (two or more segments)
  /(?:^|[\s(`'"])(\/[\w.-]+(?:\/[\w.-]+)+)/gm,
  // relative paths with a slash and an extension
  /(?:^|[\s(`'"])((?:~\/|\.\.?\/)?[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,5})\b/gm,
  // process ids
  /\bpid\s*[:=#]?\s*(\d{3,7})\b/gi,
  // ISO dates and timestamps
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g,
  // numbers with units — digits only are kept
  /\b(\d[\d,]*)\s*(?:tokens?|ms|MB|GB)\b/g,
];

/** Strip thousands separators so "784,000" and "784000" compare equal. */
function normalise(text: string): string {
  return text.replace(/(\d),(?=\d{3}\b)/g, "$1");
}

function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

/** Every distinct checkable identifier in a handover, in order of first appearance. */
export function extractCheckableTokens(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).trim();
      const token = normalise(raw);
      if (token.length < MIN_TOKEN_LENGTH || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

interface TranscriptEntry {
  type?: string;
  message?: { content?: unknown };
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  input?: { file_path?: unknown } & Record<string, unknown>;
  content?: unknown;
}

/**
 * Everything the session itself said, did, or was shown — minus the two
 * places where the handover could verify against itself: the tool call
 * that wrote the handover file, and injected blocks carried over from an
 * earlier compaction.
 */
function buildHaystack(
  transcriptPaths: string[],
  handoverPath: string | null,
  handoverHead: string
): string {
  const parts: string[] = [];
  const resolvedHandover = handoverPath ? resolve(handoverPath) : null;

  const pushUserText = (text: string): void => {
    if (INJECTED_MARKERS.some((m) => text.includes(m))) return;
    parts.push(stripSystemReminders(text));
  };

  for (const path of transcriptPaths) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      const content = entry.message?.content;
      if (content === undefined) continue;

      if (entry.type === "user") {
        if (typeof content === "string") {
          pushUserText(content);
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const part of content as ContentPart[]) {
          if (part?.type === "text" && typeof part.text === "string") pushUserText(part.text);
          else if (part?.type === "tool_result") {
            const text = contentToText(part.content);
            if (handoverHead && text.startsWith(handoverHead)) continue;
            parts.push(text);
          }
        }
      } else if (entry.type === "assistant" && Array.isArray(content)) {
        for (const part of content as ContentPart[]) {
          if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
          else if (part?.type === "tool_use") {
            const target = part.input?.file_path;
            if (
              resolvedHandover &&
              HANDOVER_WRITERS.has(part.name ?? "") &&
              typeof target === "string" &&
              resolve(target) === resolvedHandover
            ) {
              continue;
            }
            parts.push(JSON.stringify(part.input ?? {}));
          }
        }
      }
    }
  }
  return normalise(parts.join("\n"));
}

function footerFor(found: string[], missing: string[]): string {
  const total = found.length + missing.length;
  if (total === 0) return "Evidence: no checkable identifiers";
  let footer = `Evidence: ${found.length}/${total} identifiers found in the transcript`;
  if (missing.length > 0) {
    const named = missing.slice(0, FOOTER_NAMED_MISSING).join(", ");
    const more = missing.length - FOOTER_NAMED_MISSING;
    footer += `; unverified: ${named}${more > 0 ? ` +${more} more` : ""}`;
  }
  return footer;
}

/**
 * Check a handover's identifiers against the transcript(s) it was written
 * from. Never throws: any failure degrades to a footer that says the check
 * was unavailable, so the handover itself is always delivered.
 *
 * @param handoverMarkdown  the handover text, returned to the reader unchanged
 * @param handoverPath      where the handover was written, if it was written
 *                          to a file — its own Write/Edit is excluded as evidence
 * @param transcriptPaths   the session's transcript file(s)
 */
export function bindHandoverEvidence(
  handoverMarkdown: string,
  handoverPath: string | null,
  transcriptPaths: string[]
): EvidenceResult {
  try {
    const tokens = extractCheckableTokens(handoverMarkdown);
    if (tokens.length === 0) {
      return { total: 0, found: [], missing: [], footer: footerFor([], []) };
    }
    const head = handoverMarkdown.trim().slice(0, ECHO_HEAD_LENGTH);
    const haystack = buildHaystack(transcriptPaths, handoverPath, head);
    const found: string[] = [];
    const missing: string[] = [];
    for (const token of tokens) (haystack.includes(token) ? found : missing).push(token);
    return { total: tokens.length, found, missing, footer: footerFor(found, missing) };
  } catch {
    return { total: 0, found: [], missing: [], footer: "Evidence: check unavailable" };
  }
}
