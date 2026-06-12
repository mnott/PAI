/**
 * store.ts — PostgreSQL persistence for PAI observations.
 *
 * All functions accept a pg.Pool and are safe to call concurrently.
 * Schema is initialized lazily via ensureObservationTables().
 *
 * Content-hash deduplication: observations with the same hash
 * created within a 30-second window are silently dropped to prevent
 * duplicate entries from rapid repeated tool calls.
 */

import { sha256 } from '../utils/hash.js';
import type { Pool } from 'pg';
import type { ClassifiedObservation } from './classifier.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ObservationRow {
  id: number;
  session_id: string;
  project_id: number | null;
  project_slug: string | null;
  type: string;
  title: string;
  narrative: string | null;
  tool_name: string | null;
  tool_input_summary: string | null;
  files_read: string[];
  files_modified: string[];
  concepts: string[];
  content_hash: string | null;
  created_at: Date;
}

export interface SessionSummaryRow {
  id: number;
  session_id: string;
  project_id: number | null;
  project_slug: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  observation_count: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface StoreObservationInput extends Omit<ClassifiedObservation, 'narrative'> {
  session_id: string;
  project_id?: number | null;
  project_slug?: string | null;
  narrative?: string | null;
}

export interface StoreSessionSummaryInput {
  session_id: string;
  project_id?: number | null;
  project_slug?: string | null;
  request?: string | null;
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
  next_steps?: string | null;
  observation_count?: number;
}

export interface QueryObservationsOptions {
  projectId?: number;
  sessionId?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

let _tablesEnsured = false;

/**
 * Inlined schema DDL — avoids runtime file reads that break in bundled code
 * (the bundler puts this in a shared chunk whose __dirname differs from src/).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pai_observations (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id INTEGER,
  project_slug TEXT,
  type TEXT NOT NULL CHECK (type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT NOT NULL,
  narrative TEXT,
  tool_name TEXT,
  tool_input_summary TEXT,
  files_read JSONB DEFAULT '[]'::jsonb,
  files_modified JSONB DEFAULT '[]'::jsonb,
  concepts JSONB DEFAULT '[]'::jsonb,
  content_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_project ON pai_observations(project_id);
CREATE INDEX IF NOT EXISTS idx_obs_session ON pai_observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type ON pai_observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_created ON pai_observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_hash ON pai_observations(content_hash);

CREATE TABLE IF NOT EXISTS pai_session_summaries (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  project_id INTEGER,
  project_slug TEXT,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  observation_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ss_project ON pai_session_summaries(project_id);
CREATE INDEX IF NOT EXISTS idx_ss_session ON pai_session_summaries(session_id);
`;

/**
 * Run schema DDL idempotently against the given pool.
 * Uses a module-level flag so subsequent calls are no-ops within the same
 * process lifetime (the SQL itself uses IF NOT EXISTS so it is safe to re-run).
 */
export async function ensureObservationTables(pool: Pool): Promise<void> {
  if (_tablesEnsured) return;
  await pool.query(SCHEMA_SQL);
  _tablesEnsured = true;
}

// ---------------------------------------------------------------------------
// Content-hash deduplication
// ---------------------------------------------------------------------------

/**
 * Compute a 16-character hex content hash for deduplication.
 * Hash = SHA256(session_id + tool_name + title).slice(0, 16)
 */
function computeContentHash(sessionId: string, toolName: string, title: string): string {
  return sha256(sessionId + '\x00' + toolName + '\x00' + title).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Store observation
// ---------------------------------------------------------------------------

/**
 * Insert an observation, skipping duplicates within a 30-second window.
 * Returns the inserted row's id, or null if the insert was suppressed.
 */
export async function storeObservation(
  pool: Pool,
  obs: StoreObservationInput
): Promise<number | null> {
  await ensureObservationTables(pool);

  const hash = computeContentHash(obs.session_id, obs.tool_name, obs.title);

  // Check for a recent duplicate (30-second window)
  const dupCheck = await pool.query<{ id: number }>(
    `SELECT id FROM pai_observations
     WHERE content_hash = $1
       AND session_id   = $2
       AND created_at  >= NOW() - INTERVAL '30 seconds'
     LIMIT 1`,
    [hash, obs.session_id]
  );

  if (dupCheck.rowCount && dupCheck.rowCount > 0) {
    // Duplicate within dedup window — silently skip
    return null;
  }

  const result = await pool.query<{ id: number }>(
    `INSERT INTO pai_observations
       (session_id, project_id, project_slug, type, title, narrative,
        tool_name, tool_input_summary, files_read, files_modified, concepts, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
     RETURNING id`,
    [
      obs.session_id,
      obs.project_id ?? null,
      obs.project_slug ?? null,
      obs.type,
      obs.title,
      obs.narrative ?? null,
      obs.tool_name,
      obs.tool_input_summary ?? null,
      JSON.stringify(obs.files_read),
      JSON.stringify(obs.files_modified),
      JSON.stringify(obs.concepts),
      hash,
    ]
  );

  return result.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Query observations
// ---------------------------------------------------------------------------

/**
 * Filtered query for observations with optional projectId, sessionId, type,
 * limit, and offset. Returns results ordered by created_at DESC.
 */
export async function queryObservations(
  pool: Pool,
  opts: QueryObservationsOptions = {}
): Promise<ObservationRow[]> {
  await ensureObservationTables(pool);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.projectId !== undefined) {
    conditions.push(`project_id = $${idx++}`);
    params.push(opts.projectId);
  }
  if (opts.sessionId !== undefined) {
    conditions.push(`session_id = $${idx++}`);
    params.push(opts.sessionId);
  }
  if (opts.type !== undefined) {
    conditions.push(`type = $${idx++}`);
    params.push(opts.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  params.push(limit, offset);

  const result = await pool.query<ObservationRow>(
    `SELECT id, session_id, project_id, project_slug, type, title, narrative,
            tool_name, tool_input_summary,
            files_read, files_modified, concepts,
            content_hash, created_at
     FROM pai_observations
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );

  return result.rows;
}

/**
 * Most recent observations for a project, ordered by created_at DESC.
 */
export async function queryRecentObservations(
  pool: Pool,
  projectId: number,
  limit: number
): Promise<ObservationRow[]> {
  await ensureObservationTables(pool);

  const result = await pool.query<ObservationRow>(
    `SELECT id, session_id, project_id, project_slug, type, title, narrative,
            tool_name, tool_input_summary,
            files_read, files_modified, concepts,
            content_hash, created_at
     FROM pai_observations
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [projectId, limit]
  );

  return result.rows;
}

/**
 * All observations for a specific session, ordered chronologically.
 */
export async function querySessionObservations(
  pool: Pool,
  sessionId: string
): Promise<ObservationRow[]> {
  await ensureObservationTables(pool);

  const result = await pool.query<ObservationRow>(
    `SELECT id, session_id, project_id, project_slug, type, title, narrative,
            tool_name, tool_input_summary,
            files_read, files_modified, concepts,
            content_hash, created_at
     FROM pai_observations
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  return result.rows;
}

// ---------------------------------------------------------------------------
// Session summaries
// ---------------------------------------------------------------------------

/**
 * Upsert a session summary.  Uses ON CONFLICT on session_id so calling this
 * multiple times with updated content is safe.
 */
export async function storeSessionSummary(
  pool: Pool,
  summary: StoreSessionSummaryInput
): Promise<void> {
  await ensureObservationTables(pool);

  await pool.query(
    `INSERT INTO pai_session_summaries
       (session_id, project_id, project_slug, request, investigated,
        learned, completed, next_steps, observation_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (session_id) DO UPDATE SET
       project_id        = EXCLUDED.project_id,
       project_slug      = EXCLUDED.project_slug,
       request           = EXCLUDED.request,
       investigated      = EXCLUDED.investigated,
       learned           = EXCLUDED.learned,
       completed         = EXCLUDED.completed,
       next_steps        = EXCLUDED.next_steps,
       observation_count = EXCLUDED.observation_count`,
    [
      summary.session_id,
      summary.project_id ?? null,
      summary.project_slug ?? null,
      summary.request ?? null,
      summary.investigated ?? null,
      summary.learned ?? null,
      summary.completed ?? null,
      summary.next_steps ?? null,
      summary.observation_count ?? 0,
    ]
  );
}

// ---------------------------------------------------------------------------
// Skill telemetry — self-educating skill system, Phase 1 (capture)
// ---------------------------------------------------------------------------

export interface SkillTelemetryRow {
  id: number;
  scope: string;
  skill_name: string;
  source: string;
  status: string;
  trigger_count: number;
  accept_count: number;
  first_triggered: Date;
  last_triggered: Date;
  context_projects: string[];
  hash: string | null;
  audit_status: string | null;
  last_audited: Date | null;
}

export interface RecordSkillInvocationInput {
  skill_name: string;
  /** 'local' | 'skills.sh' | repo slug */
  source?: string;
  /** governance seam — defaults to 'default' */
  scope?: string;
  /** project slug for context_projects rollup */
  project_slug?: string | null;
}

export interface QuerySkillTelemetryOptions {
  scope?: string;
  status?: string;
  limit?: number;
}

const SKILL_TELEMETRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pai_skill_telemetry (
  id               SERIAL PRIMARY KEY,
  scope            TEXT NOT NULL DEFAULT 'default',
  skill_name       TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'local',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','archived')),
  trigger_count    INTEGER NOT NULL DEFAULT 0,
  accept_count     INTEGER NOT NULL DEFAULT 0,
  first_triggered  TIMESTAMPTZ DEFAULT NOW(),
  last_triggered   TIMESTAMPTZ DEFAULT NOW(),
  context_projects JSONB DEFAULT '[]'::jsonb,
  hash             TEXT,
  audit_status     TEXT,
  last_audited     TIMESTAMPTZ,
  UNIQUE(scope, skill_name, source)
);

CREATE INDEX IF NOT EXISTS idx_skilltel_scope   ON pai_skill_telemetry(scope);
CREATE INDEX IF NOT EXISTS idx_skilltel_status  ON pai_skill_telemetry(scope, status);
CREATE INDEX IF NOT EXISTS idx_skilltel_last    ON pai_skill_telemetry(last_triggered DESC);
`;

let _skillTelemetryEnsured = false;

export async function ensureSkillTelemetryTable(pool: Pool): Promise<void> {
  if (_skillTelemetryEnsured) return;
  await pool.query(SKILL_TELEMETRY_SCHEMA_SQL);
  _skillTelemetryEnsured = true;
}

/**
 * Record a single skill invocation. Upserts on (scope, skill_name, source):
 * increments trigger_count, refreshes last_triggered, and dedup-merges the
 * project slug into context_projects.
 */
export async function recordSkillInvocation(
  pool: Pool,
  input: RecordSkillInvocationInput
): Promise<void> {
  await ensureSkillTelemetryTable(pool);

  const scope = input.scope ?? 'default';
  const source = input.source ?? 'local';
  const proj = input.project_slug ?? null;
  const initialProjects = JSON.stringify(proj ? [proj] : []);

  await pool.query(
    `INSERT INTO pai_skill_telemetry
       (scope, skill_name, source, trigger_count, context_projects)
     VALUES ($1, $2, $3, 1, $4::jsonb)
     ON CONFLICT (scope, skill_name, source) DO UPDATE SET
       trigger_count    = pai_skill_telemetry.trigger_count + 1,
       last_triggered   = NOW(),
       context_projects = CASE
         WHEN $5::text IS NULL THEN pai_skill_telemetry.context_projects
         WHEN pai_skill_telemetry.context_projects @> to_jsonb($5::text)
           THEN pai_skill_telemetry.context_projects
         ELSE pai_skill_telemetry.context_projects || to_jsonb($5::text)
       END`,
    [scope, input.skill_name, source, initialProjects, proj]
  );
}

/**
 * List skill telemetry rows, most-triggered first.
 */
export async function querySkillTelemetry(
  pool: Pool,
  opts: QuerySkillTelemetryOptions = {}
): Promise<SkillTelemetryRow[]> {
  await ensureSkillTelemetryTable(pool);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  conditions.push(`scope = $${idx++}`);
  params.push(opts.scope ?? 'default');

  if (opts.status !== undefined) {
    conditions.push(`status = $${idx++}`);
    params.push(opts.status);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = opts.limit ?? 100;
  params.push(limit);

  const result = await pool.query<SkillTelemetryRow>(
    `SELECT id, scope, skill_name, source, status,
            trigger_count, accept_count,
            first_triggered, last_triggered,
            context_projects, hash, audit_status, last_audited
     FROM pai_skill_telemetry
     ${where}
     ORDER BY trigger_count DESC, last_triggered DESC
     LIMIT $${idx}`,
    params
  );

  return result.rows;
}

/**
 * Most recent session summaries for a project, ordered by created_at DESC.
 */
export async function queryRecentSummaries(
  pool: Pool,
  projectId: number,
  limit: number
): Promise<SessionSummaryRow[]> {
  await ensureObservationTables(pool);

  const result = await pool.query<SessionSummaryRow>(
    `SELECT id, session_id, project_id, project_slug,
            request, investigated, learned, completed, next_steps,
            observation_count, created_at
     FROM pai_session_summaries
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [projectId, limit]
  );

  return result.rows;
}
