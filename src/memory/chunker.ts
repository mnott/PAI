/**
 * Markdown text chunker for the PAI memory engine.
 *
 * Splits markdown files into overlapping text segments suitable for BM25
 * full-text indexing.  Respects heading boundaries where possible, falling
 * back to paragraph and sentence splitting when sections are large.
 */

import { sha256 } from "../utils/hash.js";

export interface Chunk {
  text: string;
  startLine: number;  // 1-indexed
  endLine: number;    // 1-indexed, inclusive
  hash: string;       // SHA-256 of text
}

export interface ChunkOptions {
  /** Approximate maximum tokens per chunk. Default 400. */
  maxTokens?: number;
  /** Overlap in tokens from the previous chunk. Default 80. */
  overlap?: number;
}

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP = 80;

/**
 * Approximate token count using a words * 1.3 heuristic.
 * Matches the OpenClaw estimate approach.
 */
export function estimateTokens(text: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(wordCount * 1.3);
}

// sha256 imported from utils/hash.ts

// ---------------------------------------------------------------------------
// Internal section / paragraph / sentence splitters
// ---------------------------------------------------------------------------

/**
 * A contiguous block of lines associated with an approximate token count.
 */
interface LineBlock {
  lines: Array<{ text: string; lineNo: number }>;
  tokens: number;
}

/**
 * Split content into sections delimited by ## or ### headings.
 * Each section starts at its heading line (or at line 1 for a preamble).
 */
function splitBySections(
  lines: Array<{ text: string; lineNo: number }>,
): LineBlock[] {
  const sections: LineBlock[] = [];
  let current: Array<{ text: string; lineNo: number }> = [];

  for (const line of lines) {
    const isHeading = /^#{1,3}\s/.test(line.text);
    if (isHeading && current.length > 0) {
      const text = current.map((l) => l.text).join("\n");
      sections.push({ lines: current, tokens: estimateTokens(text) });
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0) {
    const text = current.map((l) => l.text).join("\n");
    sections.push({ lines: current, tokens: estimateTokens(text) });
  }

  return sections;
}

/**
 * Split a LineBlock by double-newline paragraph boundaries.
 */
function splitByParagraphs(block: LineBlock): LineBlock[] {
  const paragraphs: LineBlock[] = [];
  let current: Array<{ text: string; lineNo: number }> = [];

  for (const line of block.lines) {
    if (line.text.trim() === "" && current.length > 0) {
      // Empty line — potential paragraph boundary
      const text = current.map((l) => l.text).join("\n");
      paragraphs.push({ lines: [...current], tokens: estimateTokens(text) });
      current = [];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const text = current.map((l) => l.text).join("\n");
    paragraphs.push({ lines: current, tokens: estimateTokens(text) });
  }

  return paragraphs.length > 0 ? paragraphs : [block];
}

/**
 * Split a LineBlock by sentence boundaries (. ! ?) when even paragraphs are
 * too large.  Works character-by-character within joined lines.
 */
function splitBySentences(block: LineBlock, maxTokens: number): LineBlock[] {
  const fullText = block.lines.map((l) => l.text).join(" ");
  // Very rough sentence split — split on '. ', '! ', '? ' followed by uppercase
  const sentenceRe = /(?<=[.!?])\s+(?=[A-Z"'])/g;
  const sentences = fullText.split(sentenceRe);

  const result: LineBlock[] = [];
  let accText = "";
  // We can't recover exact line numbers inside a single oversized paragraph,
  // so we approximate using the block's start/end lines distributed evenly.
  const startLine = block.lines[0]?.lineNo ?? 1;
  const endLine = block.lines[block.lines.length - 1]?.lineNo ?? startLine;
  const totalLines = endLine - startLine + 1;
  const linesPerSentence = Math.max(1, Math.floor(totalLines / Math.max(1, sentences.length)));

  let sentenceIdx = 0;
  let approxLine = startLine;

  const flush = () => {
    if (!accText.trim()) return;
    const endApprox = Math.min(approxLine + linesPerSentence - 1, endLine);
    result.push({
      lines: [{ text: accText.trim(), lineNo: approxLine }],
      tokens: estimateTokens(accText),
    });
    approxLine = endApprox + 1;
    accText = "";
  };

  for (const sentence of sentences) {
    sentenceIdx++;
    const candidateText = accText ? accText + " " + sentence : sentence;
    if (estimateTokens(candidateText) > maxTokens && accText) {
      flush();
      accText = sentence;
    } else {
      accText = candidateText;
    }
  }
  void sentenceIdx; // used only for iteration count
  flush();

  return result.length > 0 ? result : [block];
}

// ---------------------------------------------------------------------------
// Overlap helper
// ---------------------------------------------------------------------------

/**
 * Extract the last `overlapTokens` worth of text from a list of previously
 * emitted chunks to prepend to the next chunk.
 */
function buildOverlapPrefix(
  chunks: Chunk[],
  overlapTokens: number,
): Array<{ text: string; lineNo: number }> {
  if (overlapTokens <= 0 || chunks.length === 0) return [];

  const lastChunk = chunks[chunks.length - 1];
  if (!lastChunk) return [];

  const lines = lastChunk.text.split("\n");
  const kept: string[] = [];
  let acc = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const lineTokens = estimateTokens(lines[i] ?? "");
    acc += lineTokens;
    kept.unshift(lines[i] ?? "");
    if (acc >= overlapTokens) break;
  }

  // Distribute overlap lines across the lastChunk's line range
  const startLine = lastChunk.endLine - kept.length + 1;
  return kept.map((text, idx) => ({ text, lineNo: Math.max(lastChunk.startLine, startLine + idx) }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk a markdown file into overlapping segments for BM25 indexing.
 *
 * Strategy:
 *  1. Split by headings (##, ###) as natural boundaries.
 *  2. If a section exceeds maxTokens, split by paragraphs.
 *  3. If a paragraph still exceeds maxTokens, split by sentences.
 *  4. Apply overlap: each chunk includes the last `overlap` tokens from the
 *     previous chunk.
 */
/**
 * Strip `<private>...</private>` blocks from content before indexing.
 * Content within these tags is excluded from memory — never stored or searched.
 */
export function stripPrivateTags(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "");
}

export function chunkMarkdown(content: string, opts?: ChunkOptions): Chunk[] {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts?.overlap ?? DEFAULT_OVERLAP;

  // Strip private content before indexing
  content = stripPrivateTags(content);

  if (!content.trim()) return [];

  const rawLines = content.split("\n");
  const lines: Array<{ text: string; lineNo: number }> = rawLines.map((text, idx) => ({
    text,
    lineNo: idx + 1, // 1-indexed
  }));

  // Step 1: section split
  const sections = splitBySections(lines);

  // Step 2 & 3: further split oversized sections
  const finalBlocks: LineBlock[] = [];
  for (const section of sections) {
    if (section.tokens <= maxTokens) {
      finalBlocks.push(section);
      continue;
    }
    // Too big — split by paragraphs
    const paras = splitByParagraphs(section);
    for (const para of paras) {
      if (para.tokens <= maxTokens) {
        finalBlocks.push(para);
        continue;
      }
      // Still too big — split by sentences
      const sentences = splitBySentences(para, maxTokens);
      finalBlocks.push(...sentences);
    }
  }

  // Step 4: build final chunks with overlap
  const chunks: Chunk[] = [];

  for (const block of finalBlocks) {
    if (block.lines.length === 0) continue;

    // Build overlap prefix from previous chunks
    const overlapLines = buildOverlapPrefix(chunks, overlapTokens);

    // Combine overlap + block lines
    const allLines = [...overlapLines, ...block.lines];
    const text = allLines.map((l) => l.text).join("\n").trim();

    if (!text) continue;

    const startLine = block.lines[0]?.lineNo ?? 1;
    const endLine = block.lines[block.lines.length - 1]?.lineNo ?? startLine;

    chunks.push({
      text,
      startLine,
      endLine,
      hash: sha256(text),
    });
  }

  return chunks;
}
