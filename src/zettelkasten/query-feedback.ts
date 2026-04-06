/**
 * Query feedback loop — persist search queries and results as markdown files.
 *
 * When memory_search or zettel_converse returns results, the query + result
 * metadata is saved to ~/.config/pai/queries/ as a markdown file with YAML
 * frontmatter. The daemon indexer picks these up on the next cycle and indexes
 * them into federation.db, creating a self-reinforcing feedback loop: past
 * queries become searchable context for future queries.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface QueryRecord {
  /** The original query string. */
  query: string;
  /** Timestamp of the query. */
  timestamp: number;
  /** Tool that produced the result: 'memory_search' | 'zettel_converse'. */
  source: string;
  /** Slugs of the top result paths (for linking back). */
  sourceSlugs: string[];
  /** Preview of the answer/result (first 500 chars). */
  answerPreview: string;
  /** Number of results returned. */
  resultCount: number;
}

const QUERIES_DIR = join(homedir(), ".config", "pai", "queries");

/**
 * Ensure the queries directory exists.
 */
function ensureQueriesDir(): void {
  if (!existsSync(QUERIES_DIR)) {
    mkdirSync(QUERIES_DIR, { recursive: true });
  }
}

/**
 * Generate a filename-safe slug from a query string.
 */
function querySlug(query: string, timestamp: number): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const ts = new Date(timestamp).toISOString().slice(0, 10);
  const shortHash = timestamp.toString(36).slice(-4);
  return `${ts}-${slug}-${shortHash}`;
}

/**
 * Save a query + result record as a markdown file with YAML frontmatter.
 *
 * The file is written to ~/.config/pai/queries/ and will be picked up by
 * the daemon indexer on the next cycle.
 */
export function saveQueryResult(record: QueryRecord): string | null {
  try {
    ensureQueriesDir();

    const filename = querySlug(record.query, record.timestamp) + ".md";
    const filepath = join(QUERIES_DIR, filename);

    // Don't overwrite if the exact file already exists
    if (existsSync(filepath)) return filepath;

    const frontmatter = [
      "---",
      `query: "${record.query.replace(/"/g, '\\"')}"`,
      `timestamp: ${new Date(record.timestamp).toISOString()}`,
      `source: ${record.source}`,
      `result_count: ${record.resultCount}`,
      `source_slugs:`,
      ...record.sourceSlugs.map((s) => `  - "${s}"`),
      "---",
    ].join("\n");

    const body = [
      "",
      `# Query: ${record.query}`,
      "",
      `**Source:** ${record.source}  `,
      `**Date:** ${new Date(record.timestamp).toISOString().slice(0, 19).replace("T", " ")}  `,
      `**Results:** ${record.resultCount}`,
      "",
      "## Answer Preview",
      "",
      record.answerPreview,
      "",
      "## Source Paths",
      "",
      ...record.sourceSlugs.map((s) => `- \`${s}\``),
      "",
    ].join("\n");

    writeFileSync(filepath, frontmatter + body, "utf8");
    return filepath;
  } catch {
    // Non-critical — don't crash the parent tool if query logging fails
    return null;
  }
}
