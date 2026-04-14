/**
 * kg-extraction.ts — Shared KG triple extraction logic.
 *
 * Extracted from session-summary-worker.ts so both the worker and the
 * CLI backfill (`pai kg backfill`) can use the same code path.
 *
 * Provides:
 *   - findClaudeBinary()       — locate the claude CLI
 *   - spawnClaude()            — generic prompt -> response runner (strips ANTHROPIC_API_KEY)
 *   - extractAndStoreTriples() — run the extractor prompt and persist triples to Postgres
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Pool } from "pg";
import type { Database } from "better-sqlite3";

import { buildTripleExtractionPrompt } from "../daemon/templates/triple-extraction-prompt.js";
import { kgAdd, kgQuery, kgInvalidate } from "./kg.js";
import { upsertKgEntity } from "./kg-entity.js";

// ---------------------------------------------------------------------------
// Claude CLI binary discovery
// ---------------------------------------------------------------------------

/**
 * Find the `claude` CLI binary. Checks common installation locations first
 * (launchd PATH is minimal so bare "claude" often won't resolve).
 */
export function findClaudeBinary(): string | null {
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* skip */ }
  }
  return "claude";
}

const CLAUDE_TIMEOUT_MS: Record<string, number> = {
  haiku: 60_000,
  sonnet: 120_000,
  opus: 300_000,
};

/**
 * Spawn the claude CLI with a prompt on stdin and return stdout.
 *
 * IMPORTANT: ANTHROPIC_API_KEY is stripped from the spawned environment so
 * the CLI uses the user's Max plan (free) instead of billing the API key.
 */
export async function spawnClaude(
  prompt: string,
  model: "haiku" | "sonnet" | "opus" = "sonnet"
): Promise<string | null> {
  const claudeBin = findClaudeBinary();
  if (!claudeBin) {
    process.stderr.write("[kg-extraction] claude CLI not found.\n");
    return null;
  }

  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const { ANTHROPIC_API_KEY: _drop, ...envWithoutApiKey } = process.env;
    const child = spawn(
      claudeBin,
      ["--model", model, "-p", "--no-session-persistence"],
      { env: envWithoutApiKey, stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err: Error) => {
      if (timer) { clearTimeout(timer); timer = null; }
      process.stderr.write(`[kg-extraction] ${model} spawn error: ${err.message}\n`);
      resolve(null);
    });

    child.on("close", (code: number | null) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (code !== 0) {
        process.stderr.write(
          `[kg-extraction] ${model} exited ${code}: ${stderr.slice(0, 300)}\n`
        );
        resolve(null);
      } else {
        resolve(stdout.trim() || null);
      }
    });

    timer = setTimeout(() => {
      process.stderr.write(`[kg-extraction] ${model} timed out — killing process.\n`);
      child.kill("SIGTERM");
      resolve(null);
    }, CLAUDE_TIMEOUT_MS[model] ?? 120_000);

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Triple extraction
// ---------------------------------------------------------------------------

export interface ExtractTriplesParams {
  summaryText: string;
  projectSlug: string;
  projectId: number | null;
  sessionId: string;
  gitLog?: string;
  model?: "haiku" | "sonnet" | "opus";
  /** Optional federation SQLite db — when provided, entities are upserted into kg_entities (QW1) */
  federationDb?: Database;
  /** Tenant ID for multi-tenant entity scoping (default: "default") */
  tenantId?: string;
}

export interface ExtractTriplesResult {
  extracted: number;
  added: number;
  superseded: number;
}

/**
 * Extract structured KG triples from a session summary and store them in
 * Postgres. Idempotent: if a (subject, predicate) pair already has the same
 * object, no new row is added; if the object differs, the old triple is
 * invalidated (valid_to = NOW()) and a new one is inserted.
 *
 * Best-effort: per-triple errors are caught and logged but never thrown.
 * Returns a small stats object so callers can report progress.
 */
export async function extractAndStoreTriples(
  pool: Pool,
  params: ExtractTriplesParams
): Promise<ExtractTriplesResult> {
  const stats: ExtractTriplesResult = { extracted: 0, added: 0, superseded: 0 };

  const prompt = buildTripleExtractionPrompt({
    sessionContent: params.summaryText,
    projectSlug: params.projectSlug,
    gitLog: params.gitLog ?? "",
  });

  const jsonOutput = await spawnClaude(prompt, params.model ?? "sonnet");
  if (!jsonOutput) return stats;

  // Strip markdown code fences if Claude wrapped the JSON
  const cleaned = jsonOutput
    .replace(/^```json\s*/m, "")
    .replace(/^```\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();

  // Support both legacy array format and new structured format
  type LegacyTriple = { subject: string; predicate: string; object: string };
  type NewRelation = { source: string; relation: string; target: string };
  type NewEntity = { name: string; type: string; description: string };
  type NewFormat = { entities: NewEntity[]; relations: NewRelation[] };

  let triples: Array<LegacyTriple>;
  try {
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed)) {
      // Legacy format: [{subject, predicate, object}]
      triples = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.relations)) {
      // New structured format: {entities: [...], relations: [...]}
      const newFmt = parsed as NewFormat;

      // QW1: Upsert entities into federation SQLite kg_entities table when db is available
      if (params.federationDb && Array.isArray(newFmt.entities)) {
        const tenantId = params.tenantId ?? "default";
        for (const entity of newFmt.entities) {
          if (!entity.name) continue;
          try {
            upsertKgEntity(params.federationDb, {
              name: entity.name,
              type: entity.type ?? "unknown",
              description: entity.description,
              tenantId,
            });
          } catch (entityErr) {
            process.stderr.write(`[kg-extraction] entity upsert error (${entity.name}): ${entityErr}\n`);
          }
        }
      }

      triples = newFmt.relations.map((r: NewRelation) => ({
        subject: r.source,
        predicate: r.relation,
        object: r.target,
      }));
    } else {
      process.stderr.write(`[kg-extraction] Unexpected JSON shape — neither array nor {entities,relations}\n`);
      return stats;
    }
  } catch (e) {
    process.stderr.write(`[kg-extraction] JSON parse failed: ${e}\n`);
    return stats;
  }

  if (!Array.isArray(triples)) return stats;
  stats.extracted = triples.length;

  for (const t of triples) {
    if (!t.subject || !t.predicate || !t.object) continue;

    try {
      const existing = await kgQuery(pool, {
        subject: t.subject,
        predicate: t.predicate,
        project_id: params.projectId ?? undefined,
      });

      // If an identical (subject, predicate, object) is already valid, skip — idempotent
      const alreadyValid = existing.find((e) => e.object === t.object && !e.valid_to);
      if (alreadyValid) continue;

      // Invalidate any superseded triple (same subject+predicate, different object)
      const supersedes = existing.find((e) => e.object !== t.object && !e.valid_to);
      if (supersedes) {
        await kgInvalidate(pool, supersedes.id);
        stats.superseded++;
      }

      await kgAdd(pool, {
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        project_id: params.projectId ?? undefined,
        source_session: params.sessionId,
        confidence: "EXTRACTED",
      });
      stats.added++;
    } catch (tripleErr) {
      process.stderr.write(`[kg-extraction] store error (${t.subject}): ${tripleErr}\n`);
    }
  }

  return stats;
}
