/**
 * Question-aware ranking for `explore`.
 *
 * A question like "where is the merge gate implemented" must find the symbols
 * about "merge" and "gate", not the local variables named `where`. Stopwords
 * are dropped first, every remaining term is matched against the symbol name
 * (camel/snake split), the file path segments and the doc comment, and the
 * score is the number of distinct terms covered; exported definitions beat
 * local variables, which only show when nothing better matches.
 */
import { splitIdentifierWords } from "./fts.js";
import type { SymbolRow } from "./store.js";

const STOPWORDS = new Set((
  "a an the this that these those it its is are was were be been being am do does did done doing has have had having " +
  "where what which who whom whose when why how whether there here " +
  "in on at of to for from by with without within into onto over under about as and or but not no nor so if then than " +
  "can could should would will shall may might must we you i me my our your they them their " +
  "implemented implement implementation implementing defined define definition defines declared declare " +
  "code function functions method methods class classes file files symbol symbols variable variables " +
  "find show tell get use used uses using work works working happen happens look looks exist exists located live lives " +
  "all any some each every other another also just only very much many more most"
).split(/\s+/));

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w.toLowerCase());
}

/** content terms of a question: lower-case sub-words with stopwords removed */
export function questionTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? []) {
    for (const w of splitIdentifierWords(raw)) if (!isStopword(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** identifier-looking tokens (camelCase / snake_case / dotted) used as exact-name candidates */
export function exactNameTokens(query: string): string[] {
  const out = new Set<string>();
  for (const t of query.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) ?? []) {
    if (isStopword(t)) continue;
    if (/[a-z][A-Z]|_|\./.test(t)) out.add(t);
  }
  return [...out];
}

function covers(words: Set<string>, term: string): boolean {
  if (words.has(term)) return true;
  if (term.length < 4) return false;
  for (const w of words) if (w.length >= 4 && (w.startsWith(term) || term.startsWith(w))) return true;
  return false;
}

export function pathWords(path: string): Set<string> {
  return new Set(splitIdentifierWords(path));
}

export interface ScoredSymbol { symbol: SymbolRow; score: number; covered: number }

/** score one symbol against the question terms; covered=0 means no match */
export function scoreSymbol(s: SymbolRow, terms: string[], exactNames: Set<string>): ScoredSymbol {
  const nameW = new Set(splitIdentifierWords(s.qualifiedName || s.name));
  const pathW = pathWords(s.file);
  const docW = new Set(splitIdentifierWords(s.doc ?? ""));
  let covered = 0;
  let score = 0;
  for (const t of terms) {
    const inName = covers(nameW, t);
    const inPath = covers(pathW, t);
    const inDoc = covers(docW, t);
    if (inName || inPath || inDoc) covered++;
    score += (inName ? 4 : 0) + (inPath ? 2 : 0) + (inDoc ? 1 : 0);
  }
  if (covered === 0 && !exactNames.has(s.name) && !exactNames.has(s.qualifiedName)) return { symbol: s, score: 0, covered: 0 };
  score += covered * 10;
  if (exactNames.has(s.name) || exactNames.has(s.qualifiedName)) { score += 40; covered = Math.max(covered, 1); }
  // definitions over locals
  if (s.kind === "variable") score += s.exported ? 2 : -6;
  else score += s.exported ? 8 : 3;
  if (["function", "class", "method", "struct", "interface", "protocol", "enum"].includes(s.kind)) score += 2;
  return { symbol: s, score, covered };
}

export interface RankedFile { file: string; score: number; symbols: ScoredSymbol[] }

/**
 * Rank candidates into files, best file first. Local (non-exported) variables
 * are kept only when no definition matches at all.
 */
export function rankCandidates(
  candidates: SymbolRow[],
  terms: string[],
  exactNames: Set<string>,
  limits: { files: number; perFile: number; total: number },
): RankedFile[] {
  const seen = new Set<number>();
  let scored: ScoredSymbol[] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const r = scoreSymbol(c, terms, exactNames);
    if (r.covered > 0) scored.push(r);
  }
  const better = scored.filter((r) => !(r.symbol.kind === "variable" && !r.symbol.exported));
  if (better.length) scored = better;
  const byFile = new Map<string, ScoredSymbol[]>();
  for (const r of scored) {
    const list = byFile.get(r.symbol.file);
    if (list) list.push(r); else byFile.set(r.symbol.file, [r]);
  }
  const files: RankedFile[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => b.score - a.score || a.symbol.startLine - b.symbol.startLine);
    // best symbol dominates; further symbols add a little
    const score = list[0].score + list.slice(1, 4).reduce((n, r) => n + r.score * 0.1, 0);
    files.push({ file, score, symbols: list });
  }
  files.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const out: RankedFile[] = [];
  let total = 0;
  for (const f of files.slice(0, limits.files)) {
    const room = limits.total - total;
    if (room <= 0) break;
    const symbols = f.symbols.slice(0, Math.min(limits.perFile, room));
    total += symbols.length;
    out.push({ ...f, symbols });
  }
  return out;
}
