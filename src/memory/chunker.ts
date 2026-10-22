/**
 * Markdown text chunker for the PAI memory engine.
 *
 * Splits markdown files into overlapping text segments suitable for BM25
 * full-text indexing.  Respects heading boundaries where possible, falling
 * back to paragraph and sentence splitting when sections are large.
 */

import { sha256 } from "../utils/hash.js";

/** Bump whenever chunk text or boundaries change; forces one re-chunk of every file. */
// Bumping this re-chunks and re-embeds every indexed file.
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

  // Section end = line before the next heading of the same or higher level.
  // One reverse pass with a stack finds that heading for every heading.
  const nextSame: Array<Heading | undefined> = new Array(headings.length);
  const pending: Heading[] = [];
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i]!;
    while (pending.length > 0 && pending[pending.length - 1]!.level > h.level) pending.pop();
    nextSame[i] = pending[pending.length - 1];
    pending.push(h);
  }

  headings.forEach((h, i) => {
    const next = nextSame[i];
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
    sections.push({ lines: current, tokens: sizeOf(text), headingPath: currentPath });
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
      paragraphs.push({ lines: [...current], tokens: sizeOf(text), headingPath: block.headingPath });
      current = [];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const text = current.map((l) => l.text).join("\n");
    paragraphs.push({ lines: current, tokens: sizeOf(text), headingPath: block.headingPath });
  }

  return paragraphs.length > 0 ? paragraphs : [block];
}

/** Characters per budget token above which a block counts as oversized (guards CJK / unbroken text). */
const MAX_CHARS_PER_TOKEN = 6;

/** Chunk size measure: word-based token estimate, floored by a character-length estimate. */
function sizeOf(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / MAX_CHARS_PER_TOKEN));
}

/** A piece of one source line; `join` is what separates it from the previous piece of the same line. */
interface Piece {
  text: string;
  lineNo: number;
  join: string;
}

/** Split one over-budget line at sentence ends, then whitespace, then hard by characters. */
function splitLine(text: string, lineNo: number, budget: number): Piece[] {
  if (sizeOf(text) <= budget) return [{ text, lineNo, join: "" }];
  const maxChars = budget * MAX_CHARS_PER_TOKEN;
  const pieces: Piece[] = [];
  const push = (t: string, join: string) => { if (t) pieces.push({ text: t, lineNo, join }); };

  let acc = "";
  const emit = () => { push(acc, pieces.length > 0 ? " " : ""); acc = ""; };
  const addWord = (word: string) => {
    if (acc && sizeOf(acc + " " + word) > budget) emit();
    if (sizeOf(word) > budget) {
      // No whitespace to break on (CJK, base64, long URLs): hard split.
      if (acc) emit();
      for (let i = 0; i < word.length; i += maxChars) {
        push(word.slice(i, i + maxChars), i === 0 ? (pieces.length > 0 ? " " : "") : "");
      }
      return;
    }
    acc = acc ? acc + " " + word : word;
  };

  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z"'])/)) {
    if (acc && sizeOf(acc + " " + sentence) > budget) emit();
    if (sizeOf(sentence) <= budget) {
      acc = acc ? acc + " " + sentence : sentence;
    } else {
      for (const word of sentence.split(/\s+/).filter(Boolean)) addWord(word);
    }
  }
  emit();
  return pieces;
}

/**
 * Split an oversized LineBlock at line boundaries; lines that are themselves
 * too large are split by sentence, whitespace, then characters. Original line
 * breaks and real line numbers are kept.
 */
function splitOversized(block: LineBlock, budget: number): LineBlock[] {
  const result: LineBlock[] = [];
  let cur: Array<{ text: string; lineNo: number }> = [];
  let curText = "";

  const flush = () => {
    if (cur.length > 0) result.push({ lines: cur, tokens: sizeOf(curText), headingPath: block.headingPath });
    cur = [];
    curText = "";
  };
  const add = (piece: Piece, sep: string) => {
    const last = cur[cur.length - 1];
    if (last && piece.join && last.lineNo === piece.lineNo) last.text += piece.join + piece.text;
    else cur.push({ text: piece.text, lineNo: piece.lineNo });
    curText += (curText ? sep : "") + piece.text;
  };

  for (const line of block.lines) {
    for (const piece of splitLine(line.text, line.lineNo, budget)) {
      if (cur.length > 0 && sizeOf(curText + "\n" + piece.text) > budget) flush();
      add(piece, piece.join ? piece.join : "\n");
    }
  }
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
 * Newlines are preserved so line numbers still match the file; an unclosed
 * tag hides everything after it.
 */
export function stripPrivateTags(content: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, "");
  return content
    .replace(/<private>[\s\S]*?<\/private>/gi, blank)
    // Unclosed tag: fail private, hide through end of file.
    .replace(/<private>[\s\S]*$/i, blank);
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
    const budget = Math.max(1, maxTokens - sizeOf(breadcrumb(section.headingPath)));
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
      // Still too big — split at lines, then sentences/words/characters
      finalBlocks.push(...splitOversized(para, budget));
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
