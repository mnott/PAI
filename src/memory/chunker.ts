/**
 * Markdown text chunker for the PAI memory engine.
 *
 * Splits markdown files into overlapping text segments suitable for BM25
 * full-text indexing.  Respects heading boundaries where possible, falling
 * back to paragraph and sentence splitting when sections are large.
 */

import { sha256 } from "../utils/hash.js";

/** Bump whenever chunk text or boundaries change; forces one re-chunk of every file. */
export const CHUNKER_VERSION = 2;

/** File-level change-detection hash: content plus chunker version. */
export function fileContentHash(content: string, version: number = CHUNKER_VERSION): string {
  return sha256(`chunker v${version}\n${content}`);
}

export interface Chunk {
  text: string;
  startLine: number;  // 1-indexed
  endLine: number;    // 1-indexed, inclusive
  hash: string;       // SHA-256 of text
  /** Ancestor heading titles, outermost first, including the chunk's own section heading. */
  headingPath: string[];
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
// Heading parser (the only one — chunker and memory_outline both use it)
// ---------------------------------------------------------------------------

export interface Heading {
  level: number;  // 1-6
  title: string;
  line: number;   // 1-indexed
}

/**
 * Parse ATX headings (levels 1-6) from lines. Lines inside ``` or ~~~ fences
 * are never headings.
 */
export function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: { ch: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (f) {
      const marker = f[1]!;
      if (!fence) fence = { ch: marker[0]!, len: marker.length };
      else if (marker[0] === fence.ch && marker.length >= fence.len && !text.slice(f[0].length).trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(text);
    if (h && h[2]) headings.push({ level: h[1]!.length, title: h[2], line: i + 1 });
  }
  return headings;
}

/** Heading path (outermost first) in effect at each heading, via a level stack. */
function headingPaths(headings: Heading[]): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  const stack: Heading[] = [];
  for (const h of headings) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push(h);
    paths.set(h.line, stack.map((x) => x.title));
  }
  return paths;
}

export interface OutlineNode {
  level: number;
  title: string;
  startLine: number;
  endLine: number;
  tokens: number;
  children: OutlineNode[];
}

/**
 * Heading tree of a markdown file. A section ends on the line before the next
 * heading of the same or higher level (or at EOF) and includes its children.
 */
export function buildOutline(content: string): OutlineNode[] {
  const lines = content.split("\n");
  const last = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const headings = parseHeadings(lines);
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  headings.forEach((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    const endLine = Math.max(h.line, next ? next.line - 1 : last);
    const node: OutlineNode = {
      level: h.level,
      title: h.title,
      startLine: h.line,
      endLine,
      tokens: estimateTokens(lines.slice(h.line - 1, endLine).join("\n")),
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    (stack.length > 0 ? stack[stack.length - 1]!.children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

// ---------------------------------------------------------------------------
// Internal section / paragraph / sentence splitters
// ---------------------------------------------------------------------------

/**
 * A contiguous block of lines associated with an approximate token count.
 */
interface LineBlock {
  lines: Array<{ text: string; lineNo: number }>;
  tokens: number;
  headingPath: string[];
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
  let currentPath: string[] = [];

  const headings = parseHeadings(lines.map((l) => l.text));
  const paths = headingPaths(headings);
  const splitAt = new Set(headings.filter((h) => h.level <= 3).map((h) => h.line));

  const flush = () => {
    const text = current.map((l) => l.text).join("\n");
    sections.push({ lines: current, tokens: estimateTokens(text), headingPath: currentPath });
    current = [];
  };

  for (const line of lines) {
    if (splitAt.has(line.lineNo)) {
      if (current.length > 0) flush();
      currentPath = paths.get(line.lineNo) ?? [];
    }
    current.push(line);
  }

  if (current.length > 0) flush();

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
      paragraphs.push({ lines: [...current], tokens: estimateTokens(text), headingPath: block.headingPath });
      current = [];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const text = current.map((l) => l.text).join("\n");
    paragraphs.push({ lines: current, tokens: estimateTokens(text), headingPath: block.headingPath });
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
      headingPath: block.headingPath,
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
  lastChunk: { text: string; startLine: number; endLine: number } | undefined,
  overlapTokens: number,
): Array<{ text: string; lineNo: number }> {
  if (overlapTokens <= 0 || !lastChunk) return [];

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

/** One breadcrumb line ("[A > B]\n") for a non-empty heading path, else "". */
function breadcrumb(path: string[]): string {
  return path.length > 0 ? `[${path.join(" > ")}]\n` : "";
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

  // Step 2 & 3: further split oversized sections. The breadcrumb line is
  // prepended to every chunk, so it counts against the token budget.
  const finalBlocks: LineBlock[] = [];
  for (const section of sections) {
    const budget = Math.max(1, maxTokens - estimateTokens(breadcrumb(section.headingPath)));
    if (section.tokens <= budget) {
      finalBlocks.push(section);
      continue;
    }
    // Too big — split by paragraphs
    const paras = splitByParagraphs(section);
    for (const para of paras) {
      if (para.tokens <= budget) {
        finalBlocks.push(para);
        continue;
      }
      // Still too big — split by sentences
      const sentences = splitBySentences(para, budget);
      finalBlocks.push(...sentences);
    }
  }

  // Step 4: build final chunks with overlap
  const chunks: Chunk[] = [];
  let prev: { text: string; startLine: number; endLine: number } | undefined;

  for (const block of finalBlocks) {
    if (block.lines.length === 0) continue;

    // Build overlap prefix from the previous chunk's raw (unprefixed) text
    const overlapLines = buildOverlapPrefix(prev, overlapTokens);

    // Combine overlap + block lines
    const allLines = [...overlapLines, ...block.lines];
    const raw = allLines.map((l) => l.text).join("\n").trim();

    if (!raw) continue;

    const startLine = block.lines[0]?.lineNo ?? 1;
    const endLine = block.lines[block.lines.length - 1]?.lineNo ?? startLine;
    const text = breadcrumb(block.headingPath) + raw;

    prev = { text: raw, startLine, endLine };
    chunks.push({
      text,
      startLine,
      endLine,
      hash: sha256(text),
      headingPath: block.headingPath,
    });
  }

  return chunks;
}
