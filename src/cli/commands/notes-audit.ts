/** `pai notes audit`: read-only scan of session notes for generic, mismatched, mixed-topic and empty notes. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findNotesDir } from "../../hooks/ts/lib/project-utils/paths.js";
import { computeTopicOverlap, TOPIC_OVERLAP_THRESHOLD } from "../../daemon/session-summary-worker.js";

export type FindingKind = "generic-title" | "topic-mismatch" | "mixed-topics" | "empty";
export interface Finding { file: string; kind: FindingKind; detail: string }
export interface AuditResult { notesDir: string | null; scanned: number; findings: Finding[] }

const STUB_BYTES = 400;
const GENERIC = /^(new session|untitled|untitled session|session|)$/i;

function listNotes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 2 && /^\d+$/.test(e.name)) walk(p, depth + 1);
      else if (e.isFile() && /^\d{3,}\s*-.*\.md$/.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** Body text of the note without H1/headings, comments, rules and metadata footer lines. */
function bodyText(content: string): string {
  return content
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("#") && !t.startsWith("<!--") && !/^[-*_]{3,}$/.test(t) && !/^\*\*(Completed|Status|Date|Tags)[^*]*\*\*/.test(t);
    })
    .join("\n")
    .trim();
}

/**
 * Mixed-topic heuristic: split the note on "### AI Summary" blocks; a block's topic is its first
 * non-empty line. With at least two blocks, if any pair has word overlap (Jaccard, same stopwords
 * as the summary worker) below TOPIC_OVERLAP_THRESHOLD (0.15), the note is flagged.
 */
export function mixedTopics(content: string): [string, string] | null {
  const blocks = content.split(/^### AI Summary[^\n]*\n/m).slice(1);
  if (blocks.length < 2) return null;
  const topics = blocks
    .map((b) => (b.split(/\n(?=##\s)/)[0] ?? "").split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).find((l) => l) ?? "")
    .filter(Boolean);
  for (let i = 0; i < topics.length; i++)
    for (let j = i + 1; j < topics.length; j++)
      if (computeTopicOverlap(topics[i], topics[j]) < TOPIC_OVERLAP_THRESHOLD) return [topics[i], topics[j]];
  return null;
}

export function auditNotes(dirArg: string): AuditResult {
  const found = findNotesDir(dirArg);
  const notesDir = found.path && existsSync(found.path) ? found.path : null;
  if (!notesDir) return { notesDir: null, scanned: 0, findings: [] };
  const files = listNotes(notesDir);
  const findings: Finding[] = [];
  for (const f of files) {
    const rel = f.slice(notesDir.length + 1);
    let content: string;
    try { content = readFileSync(f, "utf-8"); } catch { continue; }
    const title = content.match(/^# Session \d+:?[ \t]*(.*)$/m)?.[1]?.trim() ?? "";
    const topic = content.match(/<!-- TOPIC:\s*(.+?)\s*-->/)?.[1]?.trim();
    if (GENERIC.test(title)) findings.push({ file: rel, kind: "generic-title", detail: title ? `"${title}"` : "no title" });
    else if (topic && computeTopicOverlap(title, topic) < TOPIC_OVERLAP_THRESHOLD)
      findings.push({ file: rel, kind: "topic-mismatch", detail: `title "${title}" vs topic "${topic}"` });
    const mixed = mixedTopics(content);
    if (mixed) findings.push({ file: rel, kind: "mixed-topics", detail: `"${mixed[0]}" vs "${mixed[1]}"` });
    const size = statSync(f).size;
    const body = bodyText(content);
    if (!body || size < STUB_BYTES) findings.push({ file: rel, kind: "empty", detail: `${size} bytes${body ? "" : ", no body"}` });
  }
  return { notesDir, scanned: files.length, findings };
}

export function renderAudit(r: AuditResult): string {
  if (!r.notesDir) return "No notes directory found.";
  const lines = [`Scanned ${r.scanned} notes in ${r.notesDir}: ${r.findings.length} findings`];
  for (const f of r.findings) lines.push(`${f.kind.padEnd(14)} ${f.file}  ${f.detail}`);
  return lines.join("\n");
}
