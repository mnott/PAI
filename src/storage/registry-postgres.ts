/**
 * PostgresRegistryBackend — implements RegistryBackend over the pg pool
 * pattern already used by PostgresBackend (src/storage/postgres/backend.ts).
 *
 * Same SQL shape as SQLiteRegistryBackend, translated to $-placeholders.
 * Behavioural notes where Postgres diverges from SQLite's "OR IGNORE":
 *  - `INSERT ... ON CONFLICT DO NOTHING` (no target) catches any unique
 *    violation on the table, matching SQLite's INSERT OR IGNORE.
 *  - SQLite's `UPDATE OR IGNORE` (used once, in reassignLinksTarget/
 *    applyProjectMerge's link retarget) has no direct Postgres equivalent —
 *    an UPDATE cannot specify ON CONFLICT. Replicated with a NOT EXISTS guard
 *    that skips rows whose new (session_id, target_project_id) would collide,
 *    leaving them for the caller's existing cleanup DELETE, exactly as the
 *    SQLite version does.
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import type { PostgresConfig } from "./postgres/config.js";
import type {
  RegistryBackend,
  Project,
  ProjectWithSessionStats,
  Session,
  SessionWithProject,
  NewProject,
  NewProjectWithSlugRetry,
  NewSession,
  NewCompactionLogEntry,
  ListProjectsOptions,
  ListProjectsByPathLengthOptions,
  ListProjectsWithStatsOptions,
  ListNamedProjectsOptions,
  ListSessionsOptions,
  ListSessionsForProjectOptions,
  ProjectType,
  ProjectStatus,
  SessionStatus,
  LinkType,
  MergePlan,
} from "./registry-interface.js";

const { Pool: PgPool } = pg;

/**
 * node-postgres returns BIGINT columns (created_at/updated_at/archived_at/
 * closed_at, and MAX() over a BIGINT column) as strings — JS numbers can't
 * safely hold the full 64-bit range. Every value here is Date.now() ms and
 * well inside Number.isSafeInteger, so a plain Number() conversion keeps the
 * shape identical to better-sqlite3's row objects (same pattern as
 * rowToKgEntity in postgres/backend.ts).
 */
function toNum(v: unknown): number {
  return typeof v === "string" ? Number(v) : (v as number);
}
function toNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : toNum(v);
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    ...row,
    created_at: toNum(row.created_at),
    updated_at: toNum(row.updated_at),
    archived_at: toNumOrNull(row.archived_at),
  } as Project;
}

function mapProjectWithStats(row: Record<string, unknown>): ProjectWithSessionStats {
  return {
    ...mapProject(row),
    session_count: toNum(row.session_count),
    last_active: toNumOrNull(row.last_active),
  } as ProjectWithSessionStats;
}

function mapSession(row: Record<string, unknown>): Session {
  return {
    ...row,
    created_at: toNum(row.created_at),
    closed_at: toNumOrNull(row.closed_at),
  } as Session;
}

export class PostgresRegistryBackend implements RegistryBackend {
  readonly backendType = "postgres" as const;

  private pool: Pool;
  /** False when constructed from a pool owned elsewhere (the shared storage
   *  backend pool, wired by src/storage/factory.ts) — close() must not end
   *  a pool this instance doesn't own. */
  private readonly ownsPool: boolean;

  constructor(configOrPool: PostgresConfig | Pool) {
    if (configOrPool instanceof PgPool) {
      this.pool = configOrPool;
      this.ownsPool = false;
      return;
    }

    const config = configOrPool;
    const connStr =
      config.connectionString ??
      `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`;

    this.pool = new PgPool({
      connectionString: connStr,
      max: config.maxConnections ?? 5,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    this.ownsPool = true;

    this.pool.on("error", (err) => {
      process.stderr.write(`[pai-postgres] Registry pool error: ${err.message}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async resetRegistry(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM links");
      await client.query("DELETE FROM compaction_log");
      await client.query("DELETE FROM session_tags");
      await client.query("DELETE FROM project_tags");
      await client.query("DELETE FROM aliases");
      await client.query("DELETE FROM sessions");
      await client.query("DELETE FROM tags");
      await client.query("DELETE FROM projects");
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Projects — reads
  // -------------------------------------------------------------------------

  async getProjectById(id: number): Promise<Project | null> {
    const r = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    return r.rows[0] ? mapProject(r.rows[0]) : null;
  }

  async getProjectBySlug(
    slug: string,
    opts: { caseInsensitive?: boolean; excludeId?: number } = {}
  ): Promise<Project | null> {
    let sql = opts.caseInsensitive
      ? "SELECT * FROM projects WHERE lower(slug) = lower($1)"
      : "SELECT * FROM projects WHERE slug = $1";
    const params: unknown[] = [slug];
    if (opts.excludeId !== undefined) {
      params.push(opts.excludeId);
      sql += ` AND id != $${params.length}`;
    }
    const r = await this.pool.query(sql, params);
    return r.rows[0] ? mapProject(r.rows[0]) : null;
  }

  async getProjectByAlias(
    alias: string,
    opts: { caseInsensitive?: boolean } = {}
  ): Promise<Project | null> {
    const sql = opts.caseInsensitive
      ? "SELECT p.* FROM projects p JOIN aliases a ON a.project_id = p.id WHERE lower(a.alias) = lower($1)"
      : "SELECT p.* FROM projects p JOIN aliases a ON a.project_id = p.id WHERE a.alias = $1";
    const r = await this.pool.query(sql, [alias]);
    return r.rows[0] ? mapProject(r.rows[0]) : null;
  }

  async getProjectByRootPath(rootPath: string, opts: { excludeId?: number } = {}): Promise<Project | null> {
    let sql = "SELECT * FROM projects WHERE root_path = $1";
    const params: unknown[] = [rootPath];
    if (opts.excludeId !== undefined) {
      params.push(opts.excludeId);
      sql += ` AND id != $${params.length}`;
    }
    const r = await this.pool.query(sql, params);
    return r.rows[0] ? mapProject(r.rows[0]) : null;
  }

  async getProjectByEncodedDir(encodedDir: string, opts: { excludeId?: number } = {}): Promise<Project | null> {
    let sql = "SELECT * FROM projects WHERE encoded_dir = $1";
    const params: unknown[] = [encodedDir];
    if (opts.excludeId !== undefined) {
      params.push(opts.excludeId);
      sql += ` AND id != $${params.length}`;
    }
    const r = await this.pool.query(sql, params);
    return r.rows[0] ? mapProject(r.rows[0]) : null;
  }

  async findProjectByCwdPrefix(cwd: string): Promise<Project | null> {
    const r = await this.pool.query(
      `SELECT * FROM projects WHERE status = 'active' AND $1 LIKE root_path || '%'
       ORDER BY length(root_path) DESC LIMIT 1`,
      [cwd]
    );
    return r.rows[0] ? mapProject(r.rows[0]) : null;
  }

  async listProjects(opts: ListProjectsOptions = {}): Promise<Project[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      params.push(opts.status);
      where.push(`p.status = $${params.length}`);
    }
    if (opts.excludeArchived) {
      where.push("p.status != 'archived'");
    }
    if (opts.tagName) {
      params.push(opts.tagName);
      where.push(
        `p.id IN (SELECT pt.project_id FROM project_tags pt JOIN tags t ON pt.tag_id = t.id WHERE t.name = $${params.length})`
      );
    }

    let sql = "SELECT p.* FROM projects p";
    if (where.length) sql += " WHERE " + where.join(" AND ");

    switch (opts.orderBy) {
      case "updated_desc":
        sql += " ORDER BY p.updated_at DESC";
        break;
      case "slug":
        sql += " ORDER BY p.slug ASC";
        break;
      case "id":
        sql += " ORDER BY p.id";
        break;
      case "status_updated":
      default:
        sql += " ORDER BY p.status ASC, p.updated_at DESC";
        break;
    }
    if (opts.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const r = await this.pool.query(sql, params);
    return r.rows.map(mapProject);
  }

  async listProjectsByPathLengthDesc(opts: ListProjectsByPathLengthOptions = {}): Promise<Project[]> {
    const where = opts.excludeArchived ? "WHERE status != 'archived'" : "";
    const r = await this.pool.query(`SELECT * FROM projects ${where} ORDER BY LENGTH(root_path) DESC`);
    return r.rows.map(mapProject);
  }

  async listProjectsWithSessionStats(
    opts: ListProjectsWithStatsOptions = {}
  ): Promise<ProjectWithSessionStats[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      params.push(opts.status);
      where.push(`p.status = $${params.length}`);
    }
    if (opts.tagId !== undefined) {
      params.push(opts.tagId);
      where.push(`p.id IN (SELECT project_id FROM project_tags WHERE tag_id = $${params.length})`);
    }

    let sql = `
      SELECT p.*,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id)::int AS session_count,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
      FROM projects p
    `;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql +=
      opts.orderBy === "updated_desc"
        ? " ORDER BY p.updated_at DESC"
        : " ORDER BY p.status ASC, p.updated_at DESC";

    const r = await this.pool.query(sql, params);
    return r.rows.map(mapProjectWithStats);
  }

  async listNamedProjects(
    opts: ListNamedProjectsOptions = {}
  ): Promise<Array<ProjectWithSessionStats & { name: string | null }>> {
    const join = opts.includeUnnamed ? "LEFT JOIN" : "JOIN";
    const sql = `
      SELECT p.*, a.alias AS name,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id)::int AS session_count,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
      FROM projects p
      ${join} aliases a ON a.project_id = p.id
      WHERE p.status = 'active'
      ORDER BY p.updated_at DESC
    `;
    const r = await this.pool.query(sql);
    return r.rows.map((row) => ({ ...mapProjectWithStats(row), name: row.name as string | null }));
  }

  async searchProjects(query: string, limit = 20): Promise<Project[]> {
    const q = `%${query}%`;
    const r = await this.pool.query(
      `SELECT * FROM projects WHERE slug LIKE $1 OR display_name LIKE $1 OR root_path LIKE $1
       ORDER BY updated_at DESC LIMIT $2`,
      [q, limit]
    );
    return r.rows.map(mapProject);
  }

  async countProjects(opts: { status?: ProjectStatus } = {}): Promise<number> {
    const r = opts.status
      ? await this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM projects WHERE status = $1", [
          opts.status,
        ])
      : await this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM projects");
    return parseInt(r.rows[0].n, 10);
  }

  async getMostRecentProjectUpdatedAt(): Promise<number | null> {
    const r = await this.pool.query<{ updated_at: string }>(
      "SELECT updated_at FROM projects ORDER BY updated_at DESC LIMIT 1"
    );
    return r.rows[0] ? Number(r.rows[0].updated_at) : null;
  }

  async countChildProjects(parentId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM projects WHERE parent_id = $1",
      [parentId]
    );
    return parseInt(r.rows[0].n, 10);
  }

  async findSiblingProjectsBySlugPattern(
    excludeProjectId: number,
    slug: string,
    limit = 3
  ): Promise<Array<{ slug: string; root_path: string; session_count: number }>> {
    const r = await this.pool.query(
      `SELECT p.slug, p.root_path, COUNT(s.id)::int AS session_count
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       WHERE p.id != $1 AND (p.slug = $2 OR p.slug LIKE $2 || '-%' OR $2 LIKE p.slug || '-%')
       GROUP BY p.id HAVING COUNT(s.id) > 0 ORDER BY session_count DESC LIMIT $3`,
      [excludeProjectId, slug, limit]
    );
    return r.rows as Array<{ slug: string; root_path: string; session_count: number }>;
  }

  // -------------------------------------------------------------------------
  // Projects — writes
  // -------------------------------------------------------------------------

  async createProject(input: NewProject): Promise<Project> {
    const type: ProjectType = input.type ?? "local";
    const status: ProjectStatus = input.status ?? "active";
    const r = await this.pool.query(
      `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [input.slug, input.displayName, input.rootPath, input.encodedDir, type, status, input.createdAt, input.updatedAt]
    );
    return mapProject(r.rows[0]);
  }

  async createProjectWithSlugRetry(
    input: NewProjectWithSlugRetry
  ): Promise<{ id: number; slug: string; created: boolean }> {
    let slug = input.baseSlug;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await this.pool.query<{ id: number }>(
        `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'local', 'active', $5, $6)
         ON CONFLICT DO NOTHING RETURNING id`,
        [slug, input.displayName, input.rootPath, input.encodedDir, input.createdAt, input.updatedAt]
      );
      if (r.rows.length > 0) {
        return { id: r.rows[0].id, slug, created: true };
      }

      const existing = await this.pool.query<{ id: number }>(
        "SELECT id FROM projects WHERE root_path = $1",
        [input.rootPath]
      );
      if (existing.rows[0]) {
        return { id: existing.rows[0].id, slug, created: false };
      }

      attempt++;
      slug = `${input.baseSlug}-${attempt}`;
    }
  }

  async updateProjectPath(
    id: number,
    patch: { rootPath?: string; encodedDir?: string },
    updatedAt?: number
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.rootPath !== undefined) {
      params.push(patch.rootPath);
      sets.push(`root_path = $${params.length}`);
    }
    if (patch.encodedDir !== undefined) {
      params.push(patch.encodedDir);
      sets.push(`encoded_dir = $${params.length}`);
    }
    if (updatedAt !== undefined) {
      params.push(updatedAt);
      sets.push(`updated_at = $${params.length}`);
    }
    if (!sets.length) return;
    params.push(id);
    await this.pool.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  }

  async updateProjectStatus(
    id: number,
    status: ProjectStatus,
    opts: { archivedAt?: number | null; updatedAt?: number; requireCurrentStatus?: ProjectStatus } = {}
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [status];
    sets.push("status = $1");
    if (opts.archivedAt !== undefined) {
      params.push(opts.archivedAt);
      sets.push(`archived_at = $${params.length}`);
    }
    if (opts.updatedAt !== undefined) {
      params.push(opts.updatedAt);
      sets.push(`updated_at = $${params.length}`);
    }
    params.push(id);
    let sql = `UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length}`;
    if (opts.requireCurrentStatus) {
      params.push(opts.requireCurrentStatus);
      sql += ` AND status = $${params.length}`;
    }
    await this.pool.query(sql, params);
  }

  async updateProjectDisplayName(id: number, displayName: string, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      await this.pool.query("UPDATE projects SET display_name = $1, updated_at = $2 WHERE id = $3", [
        displayName,
        updatedAt,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE projects SET display_name = $1 WHERE id = $2", [displayName, id]);
    }
  }

  async updateProjectType(id: number, type: ProjectType, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      await this.pool.query("UPDATE projects SET type = $1, updated_at = $2 WHERE id = $3", [
        type,
        updatedAt,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE projects SET type = $1 WHERE id = $2", [type, id]);
    }
  }

  async updateProjectSessionConfig(id: number, config: string | null, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      await this.pool.query("UPDATE projects SET session_config = $1, updated_at = $2 WHERE id = $3", [
        config,
        updatedAt,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE projects SET session_config = $1 WHERE id = $2", [config, id]);
    }
  }

  async updateProjectClaudeNotesDir(id: number, dir: string | null, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      await this.pool.query("UPDATE projects SET claude_notes_dir = $1, updated_at = $2 WHERE id = $3", [
        dir,
        updatedAt,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE projects SET claude_notes_dir = $1 WHERE id = $2", [dir, id]);
    }
  }

  async updateProjectObsidianLink(id: number, link: string | null, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      await this.pool.query("UPDATE projects SET obsidian_link = $1, updated_at = $2 WHERE id = $3", [
        link,
        updatedAt,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE projects SET obsidian_link = $1 WHERE id = $2", [link, id]);
    }
  }

  async updateProjectSlug(id: number, slug: string, updatedAt: number): Promise<void> {
    await this.pool.query("UPDATE projects SET slug = $1, updated_at = $2 WHERE id = $3", [slug, updatedAt, id]);
  }

  async reassignProjectParent(fromParentId: number, toParentId: number): Promise<number> {
    const r = await this.pool.query("UPDATE projects SET parent_id = $1 WHERE parent_id = $2", [
      toParentId,
      fromParentId,
    ]);
    return r.rowCount ?? 0;
  }

  async deleteProject(id: number): Promise<void> {
    await this.pool.query("DELETE FROM projects WHERE id = $1", [id]);
  }

  async deleteProjectCascade(id: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM links WHERE target_project_id = $1", [id]);
      await client.query(
        "DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)",
        [id]
      );
      await client.query("DELETE FROM compaction_log WHERE project_id = $1", [id]);
      await client.query("DELETE FROM project_tags WHERE project_id = $1", [id]);
      await client.query("DELETE FROM aliases WHERE project_id = $1", [id]);
      await client.query("DELETE FROM sessions WHERE project_id = $1", [id]);
      await client.query("DELETE FROM projects WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async listTagsForProject(projectId: number): Promise<string[]> {
    const r = await this.pool.query<{ name: string }>(
      "SELECT t.name FROM tags t JOIN project_tags pt ON pt.tag_id = t.id WHERE pt.project_id = $1 ORDER BY t.name",
      [projectId]
    );
    return r.rows.map((row) => row.name);
  }

  async listAllTags(): Promise<Array<{ id: number; name: string }>> {
    const r = await this.pool.query<{ id: number; name: string }>("SELECT id, name FROM tags ORDER BY name");
    return r.rows;
  }

  async upsertTag(name: string): Promise<number> {
    await this.pool.query("INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    const r = await this.pool.query<{ id: number }>("SELECT id FROM tags WHERE name = $1", [name]);
    return r.rows[0].id;
  }

  async addProjectTag(projectId: number, tagId: number): Promise<void> {
    await this.pool.query("INSERT INTO project_tags (project_id, tag_id) VALUES ($1, $2)", [projectId, tagId]);
  }

  async projectHasTag(projectId: number, tagId: number): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM project_tags WHERE project_id = $1 AND tag_id = $2", [
      projectId,
      tagId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async deleteProjectTag(projectId: number, tagId: number): Promise<void> {
    await this.pool.query("DELETE FROM project_tags WHERE project_id = $1 AND tag_id = $2", [projectId, tagId]);
  }

  async reassignProjectTag(fromProjectId: number, toProjectId: number, tagId: number): Promise<void> {
    await this.pool.query("UPDATE project_tags SET project_id = $1 WHERE project_id = $2 AND tag_id = $3", [
      toProjectId,
      fromProjectId,
      tagId,
    ]);
  }

  async listProjectTagIds(projectId: number): Promise<number[]> {
    const r = await this.pool.query<{ tag_id: number }>("SELECT tag_id FROM project_tags WHERE project_id = $1", [
      projectId,
    ]);
    return r.rows.map((row) => row.tag_id);
  }

  async countProjectTagsForProject(projectId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM project_tags WHERE project_id = $1",
      [projectId]
    );
    return parseInt(r.rows[0].n, 10);
  }

  async copyProjectTags(fromProjectId: number, toProjectId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_tags (project_id, tag_id) SELECT $1, tag_id FROM project_tags WHERE project_id = $2
       ON CONFLICT (project_id, tag_id) DO NOTHING`,
      [toProjectId, fromProjectId]
    );
  }

  async deleteProjectTagsForProject(projectId: number): Promise<void> {
    await this.pool.query("DELETE FROM project_tags WHERE project_id = $1", [projectId]);
  }

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  async resolveAlias(alias: string): Promise<number | null> {
    const r = await this.pool.query<{ project_id: number }>(
      "SELECT project_id FROM aliases WHERE alias = $1",
      [alias]
    );
    return r.rows[0]?.project_id ?? null;
  }

  async listAliasesForProject(projectId: number): Promise<string[]> {
    const r = await this.pool.query<{ alias: string }>(
      "SELECT alias FROM aliases WHERE project_id = $1 ORDER BY alias",
      [projectId]
    );
    return r.rows.map((row) => row.alias);
  }

  async addAlias(alias: string, projectId: number): Promise<void> {
    await this.pool.query("INSERT INTO aliases (alias, project_id) VALUES ($1, $2)", [alias, projectId]);
  }

  async removeAlias(alias: string): Promise<void> {
    await this.pool.query("DELETE FROM aliases WHERE alias = $1", [alias]);
  }

  async countAliasesForProject(projectId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM aliases WHERE project_id = $1",
      [projectId]
    );
    return parseInt(r.rows[0].n, 10);
  }

  async moveProjectAliases(fromProjectId: number, toProjectId: number): Promise<void> {
    await this.pool.query("UPDATE aliases SET project_id = $1 WHERE project_id = $2", [
      toProjectId,
      fromProjectId,
    ]);
  }

  async reassignAlias(alias: string, toProjectId: number): Promise<void> {
    await this.pool.query("UPDATE aliases SET project_id = $1 WHERE alias = $2", [toProjectId, alias]);
  }

  async listAliasMap(): Promise<Array<{ alias: string; slug: string; root_path: string }>> {
    const r = await this.pool.query(
      `SELECT a.alias AS alias, p.slug AS slug, p.root_path AS root_path
       FROM aliases a JOIN projects p ON p.id = a.project_id WHERE p.status != 'archived'`
    );
    return r.rows as Array<{ alias: string; slug: string; root_path: string }>;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async getSessionById(id: number): Promise<Session | null> {
    const r = await this.pool.query("SELECT * FROM sessions WHERE id = $1", [id]);
    return r.rows[0] ? mapSession(r.rows[0]) : null;
  }

  async getSessionByNumber(projectId: number, number: number): Promise<Session | null> {
    const r = await this.pool.query("SELECT * FROM sessions WHERE project_id = $1 AND number = $2", [
      projectId,
      number,
    ]);
    return r.rows[0] ? mapSession(r.rows[0]) : null;
  }

  async getLatestSessionForProject(projectId: number): Promise<Session | null> {
    const r = await this.pool.query(
      "SELECT * FROM sessions WHERE project_id = $1 ORDER BY number DESC LIMIT 1",
      [projectId]
    );
    return r.rows[0] ? mapSession(r.rows[0]) : null;
  }

  async getMaxSessionNumber(projectId: number): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      "SELECT COALESCE(MAX(number), 0) AS n FROM sessions WHERE project_id = $1",
      [projectId]
    );
    return r.rows[0].n;
  }

  async listSessionsForProject(
    projectId: number,
    opts: ListSessionsForProjectOptions = {}
  ): Promise<Session[]> {
    const orderBy = opts.orderBy === "created_desc" ? "created_at DESC" : "number ASC";
    let sql = `SELECT * FROM sessions WHERE project_id = $1 ORDER BY ${orderBy}`;
    const params: unknown[] = [projectId];
    if (opts.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const r = await this.pool.query(sql, params);
    return r.rows.map(mapSession);
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionWithProject[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId !== undefined) {
      params.push(opts.projectId);
      where.push(`s.project_id = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      where.push(`s.status = $${params.length}`);
    }
    let sql = `
      SELECT s.*, p.slug AS project_slug, p.display_name AS project_name
      FROM sessions s JOIN projects p ON p.id = s.project_id
    `;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY s.date DESC, s.number DESC";
    params.push(opts.limit ?? 20);
    sql += ` LIMIT $${params.length}`;
    const r = await this.pool.query(sql, params);
    return r.rows.map((row) => ({ ...mapSession(row), project_slug: row.project_slug as string, project_name: row.project_name as string }));
  }

  async findSessionByFilename(projectId: number, filename: string): Promise<{ id: number } | null> {
    const r = await this.pool.query<{ id: number }>(
      "SELECT id FROM sessions WHERE project_id = $1 AND filename = $2 LIMIT 1",
      [projectId, filename]
    );
    return r.rows[0] ?? null;
  }

  async sessionNumberTaken(projectId: number, number: number): Promise<boolean> {
    const r = await this.pool.query(
      "SELECT 1 FROM sessions WHERE project_id = $1 AND number = $2 LIMIT 1",
      [projectId, number]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async createSession(input: NewSession): Promise<Session> {
    const status = input.status ?? "completed";
    const r = await this.pool.query(
      `INSERT INTO sessions (project_id, number, date, slug, title, filename, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [input.projectId, input.number, input.date, input.slug, input.title, input.filename, status, input.createdAt]
    );
    return mapSession(r.rows[0]);
  }

  async upsertSessionIfAbsent(input: NewSession): Promise<boolean> {
    const existing = await this.pool.query(
      "SELECT id FROM sessions WHERE project_id = $1 AND number = $2",
      [input.projectId, input.number]
    );
    if ((existing.rowCount ?? 0) > 0) return false;

    const status = input.status ?? "completed";
    await this.pool.query(
      `INSERT INTO sessions (project_id, number, date, slug, title, filename, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.projectId, input.number, input.date, input.slug, input.title, input.filename, status, input.createdAt]
    );
    return true;
  }

  async updateSessionMeta(
    id: number,
    patch: { slug?: string; title?: string; filename?: string }
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.slug !== undefined) {
      params.push(patch.slug);
      sets.push(`slug = $${params.length}`);
    }
    if (patch.title !== undefined) {
      params.push(patch.title);
      sets.push(`title = $${params.length}`);
    }
    if (patch.filename !== undefined) {
      params.push(patch.filename);
      sets.push(`filename = $${params.length}`);
    }
    if (!sets.length) return;
    params.push(id);
    await this.pool.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  }

  async updateSessionNumber(id: number, number: number, opts: { filename?: string } = {}): Promise<void> {
    if (opts.filename !== undefined) {
      await this.pool.query("UPDATE sessions SET number = $1, filename = $2 WHERE id = $3", [
        number,
        opts.filename,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE sessions SET number = $1 WHERE id = $2", [number, id]);
    }
  }

  async updateSessionFilename(id: number, filename: string): Promise<void> {
    await this.pool.query("UPDATE sessions SET filename = $1 WHERE id = $2", [filename, id]);
  }

  async updateSessionStatus(id: number, status: SessionStatus, opts: { closedAt?: number } = {}): Promise<void> {
    if (opts.closedAt !== undefined) {
      await this.pool.query("UPDATE sessions SET status = $1, closed_at = $2 WHERE id = $3", [
        status,
        opts.closedAt,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE sessions SET status = $1 WHERE id = $2", [status, id]);
    }
  }

  async moveSessionToProject(id: number, projectId: number, opts: { number?: number } = {}): Promise<void> {
    if (opts.number !== undefined) {
      await this.pool.query("UPDATE sessions SET project_id = $1, number = $2 WHERE id = $3", [
        projectId,
        opts.number,
        id,
      ]);
    } else {
      await this.pool.query("UPDATE sessions SET project_id = $1 WHERE id = $2", [projectId, id]);
    }
  }

  async deleteSession(id: number): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }

  async backfillFoldedSession(keepId: number, dropId: number): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET
         claude_session_id = COALESCE(claude_session_id,
                                      (SELECT claude_session_id FROM sessions WHERE id = $1)),
         token_count       = COALESCE(token_count,
                                      (SELECT token_count FROM sessions WHERE id = $1)),
         closed_at         = COALESCE(closed_at,
                                      (SELECT closed_at FROM sessions WHERE id = $1)),
         status            = CASE WHEN status = 'open'
                                   AND (SELECT status FROM sessions WHERE id = $1) != 'open'
                                  THEN (SELECT status FROM sessions WHERE id = $1)
                                  ELSE status END
       WHERE id = $2`,
      [dropId, keepId]
    );
  }

  async countSessionsForProject(projectId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM sessions WHERE project_id = $1",
      [projectId]
    );
    return parseInt(r.rows[0].n, 10);
  }

  async countSessions(): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM sessions");
    return parseInt(r.rows[0].n, 10);
  }

  async getMostRecentSessionDate(projectId: number): Promise<string | null> {
    const r = await this.pool.query<{ date: string }>(
      "SELECT date FROM sessions WHERE project_id = $1 ORDER BY date DESC LIMIT 1",
      [projectId]
    );
    return r.rows[0]?.date ?? null;
  }

  async getMostRecentSessionCreatedAt(): Promise<number | null> {
    const r = await this.pool.query<{ created_at: string }>(
      "SELECT created_at FROM sessions ORDER BY created_at DESC LIMIT 1"
    );
    return r.rows[0] ? Number(r.rows[0].created_at) : null;
  }

  // -------------------------------------------------------------------------
  // Session tags
  // -------------------------------------------------------------------------

  async listSessionTagIds(sessionId: number): Promise<number[]> {
    const r = await this.pool.query<{ tag_id: number }>(
      "SELECT tag_id FROM session_tags WHERE session_id = $1",
      [sessionId]
    );
    return r.rows.map((row) => row.tag_id);
  }

  async sessionHasTag(sessionId: number, tagId: number): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM session_tags WHERE session_id = $1 AND tag_id = $2", [
      sessionId,
      tagId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async addSessionTag(sessionId: number, tagId: number): Promise<void> {
    await this.pool.query("INSERT INTO session_tags (session_id, tag_id) VALUES ($1, $2)", [sessionId, tagId]);
  }

  async deleteSessionTag(sessionId: number, tagId: number): Promise<void> {
    await this.pool.query("DELETE FROM session_tags WHERE session_id = $1 AND tag_id = $2", [sessionId, tagId]);
  }

  async reassignSessionTag(fromSessionId: number, toSessionId: number, tagId: number): Promise<void> {
    await this.pool.query(
      "UPDATE session_tags SET session_id = $1 WHERE session_id = $2 AND tag_id = $3",
      [toSessionId, fromSessionId, tagId]
    );
  }

  async listTagsForSession(sessionId: number): Promise<string[]> {
    const r = await this.pool.query<{ name: string }>(
      "SELECT t.name FROM tags t JOIN session_tags st ON st.tag_id = t.id WHERE st.session_id = $1 ORDER BY t.name",
      [sessionId]
    );
    return r.rows.map((row) => row.name);
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  async addLink(input: {
    sessionId: number;
    targetProjectId: number;
    linkType: LinkType;
    createdAt: number;
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO links (session_id, target_project_id, link_type, created_at) VALUES ($1, $2, $3, $4)",
      [input.sessionId, input.targetProjectId, input.linkType, input.createdAt]
    );
  }

  async listLinksForSession(sessionId: number): Promise<Array<{ id: number; target_project_id: number }>> {
    const r = await this.pool.query("SELECT id, target_project_id FROM links WHERE session_id = $1", [
      sessionId,
    ]);
    return r.rows as Array<{ id: number; target_project_id: number }>;
  }

  async listLinksForProject(projectId: number): Promise<Array<{ id: number; session_id: number }>> {
    const r = await this.pool.query("SELECT id, session_id FROM links WHERE target_project_id = $1", [
      projectId,
    ]);
    return r.rows as Array<{ id: number; session_id: number }>;
  }

  async linkExists(sessionId: number, targetProjectId: number): Promise<boolean> {
    const r = await this.pool.query(
      "SELECT 1 FROM links WHERE session_id = $1 AND target_project_id = $2 LIMIT 1",
      [sessionId, targetProjectId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async deleteLink(id: number): Promise<void> {
    await this.pool.query("DELETE FROM links WHERE id = $1", [id]);
  }

  async deleteLinksTargetingProject(projectId: number): Promise<void> {
    await this.pool.query("DELETE FROM links WHERE target_project_id = $1", [projectId]);
  }

  async deleteLinksFromProjectSessions(projectId: number): Promise<void> {
    await this.pool.query(
      "DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)",
      [projectId]
    );
  }

  async retargetLink(id: number, targetProjectId: number): Promise<void> {
    await this.pool.query("UPDATE links SET target_project_id = $1 WHERE id = $2", [targetProjectId, id]);
  }

  async moveLinkToSession(id: number, sessionId: number): Promise<void> {
    await this.pool.query("UPDATE links SET session_id = $1 WHERE id = $2", [sessionId, id]);
  }

  async reassignLinksTarget(fromProjectId: number, toProjectId: number): Promise<void> {
    // Postgres UPDATE has no OR IGNORE; skip rows that would collide with an
    // existing (session_id, target_project_id) row, matching SQLite's behaviour
    // of silently leaving those rows for the caller's follow-up cleanup.
    await this.pool.query(
      `UPDATE links SET target_project_id = $1 WHERE target_project_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM links l2 WHERE l2.session_id = links.session_id AND l2.target_project_id = $1
         )`,
      [toProjectId, fromProjectId]
    );
  }

  async countLinksForProject(projectId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM links WHERE target_project_id = $1",
      [projectId]
    );
    return parseInt(r.rows[0].n, 10);
  }

  async deleteSelfLinksForProject(projectId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM links WHERE target_project_id = $1
         AND session_id IN (SELECT id FROM sessions WHERE project_id = $2)`,
      [projectId, projectId]
    );
  }

  // -------------------------------------------------------------------------
  // Compaction log
  // -------------------------------------------------------------------------

  async appendCompactionLog(entry: NewCompactionLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO compaction_log (project_id, session_id, trigger, files_written, token_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.projectId, entry.sessionId, entry.trigger, entry.filesWritten, entry.tokenCount, entry.createdAt]
    );
  }

  async countCompactionLogsForProject(projectId: number): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM compaction_log WHERE project_id = $1",
      [projectId]
    );
    return parseInt(r.rows[0].n, 10);
  }

  async moveCompactionLogsByProject(fromProjectId: number, toProjectId: number): Promise<number> {
    const r = await this.pool.query("UPDATE compaction_log SET project_id = $1 WHERE project_id = $2", [
      toProjectId,
      fromProjectId,
    ]);
    return r.rowCount ?? 0;
  }

  async moveCompactionLogsBySession(fromSessionId: number, toSessionId: number): Promise<void> {
    await this.pool.query("UPDATE compaction_log SET session_id = $1 WHERE session_id = $2", [
      toSessionId,
      fromSessionId,
    ]);
  }

  async deleteCompactionLogsForProject(projectId: number): Promise<void> {
    await this.pool.query("DELETE FROM compaction_log WHERE project_id = $1", [projectId]);
  }

  // -------------------------------------------------------------------------
  // Project merge
  // -------------------------------------------------------------------------

  async planProjectMerge(fromSlug: string, intoSlug: string): Promise<MergePlan> {
    const { MergeError } = await import("../registry/merge.js");
    if (fromSlug === intoSlug) {
      throw new MergeError(`Cannot merge ${fromSlug} into itself.`);
    }

    const fromR = await this.pool.query<{ id: number; slug: string }>(
      "SELECT id, slug FROM projects WHERE slug = $1",
      [fromSlug]
    );
    const intoR = await this.pool.query<{ id: number; slug: string }>(
      "SELECT id, slug FROM projects WHERE slug = $1",
      [intoSlug]
    );
    const from = fromR.rows[0];
    const into = intoR.rows[0];
    if (!from) throw new MergeError(`No project with slug "${fromSlug}".`);
    if (!into) throw new MergeError(`No project with slug "${intoSlug}".`);

    const maxRow = await this.pool.query<{ n: number }>(
      "SELECT COALESCE(MAX(number), 0) AS n FROM sessions WHERE project_id = $1",
      [into.id]
    );
    let next = maxRow.rows[0].n;

    const incoming = await this.pool.query<{ id: number; number: number }>(
      "SELECT id, number FROM sessions WHERE project_id = $1 ORDER BY number ASC",
      [from.id]
    );
    const sessions = incoming.rows.map((s) => ({ id: s.id, from: s.number, to: ++next }));

    const count = async (sql: string, ...args: unknown[]): Promise<number> => {
      const r = await this.pool.query<{ n: string }>(sql, args);
      return parseInt(r.rows[0].n, 10);
    };

    const aliasTaken =
      (await count("SELECT COUNT(*)::text AS n FROM aliases WHERE alias = $1", from.slug)) > 0 ||
      (await count("SELECT COUNT(*)::text AS n FROM projects WHERE slug = $1", from.slug)) > 1;

    return {
      fromId: from.id,
      fromSlug: from.slug,
      intoId: into.id,
      intoSlug: into.slug,
      sessions,
      tags: await count("SELECT COUNT(*)::text AS n FROM project_tags WHERE project_id = $1", from.id),
      aliases: await count("SELECT COUNT(*)::text AS n FROM aliases WHERE project_id = $1", from.id),
      compactions: await count(
        "SELECT COUNT(*)::text AS n FROM compaction_log WHERE project_id = $1",
        from.id
      ),
      links: await count("SELECT COUNT(*)::text AS n FROM links WHERE target_project_id = $1", from.id),
      aliasToAdd: aliasTaken ? undefined : from.slug,
    };
  }

  async applyProjectMerge(plan: MergePlan): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const s of plan.sessions) {
        await client.query("UPDATE sessions SET project_id = $1, number = $2 WHERE id = $3", [
          plan.intoId,
          s.to,
          s.id,
        ]);
      }

      await client.query(
        `INSERT INTO project_tags (project_id, tag_id)
         SELECT $1, tag_id FROM project_tags WHERE project_id = $2
         ON CONFLICT (project_id, tag_id) DO NOTHING`,
        [plan.intoId, plan.fromId]
      );
      await client.query("DELETE FROM project_tags WHERE project_id = $1", [plan.fromId]);

      await client.query("UPDATE aliases SET project_id = $1 WHERE project_id = $2", [
        plan.intoId,
        plan.fromId,
      ]);

      await client.query("UPDATE compaction_log SET project_id = $1 WHERE project_id = $2", [
        plan.intoId,
        plan.fromId,
      ]);

      // Links: same NOT EXISTS guard as reassignLinksTarget, plus the same
      // two follow-up cleanups SQLite's applyMerge does.
      await client.query(
        `UPDATE links SET target_project_id = $1 WHERE target_project_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM links l2 WHERE l2.session_id = links.session_id AND l2.target_project_id = $1
           )`,
        [plan.intoId, plan.fromId]
      );
      await client.query("DELETE FROM links WHERE target_project_id = $1", [plan.fromId]);
      await client.query(
        `DELETE FROM links WHERE target_project_id = $1
           AND session_id IN (SELECT id FROM sessions WHERE project_id = $2)`,
        [plan.intoId, plan.intoId]
      );

      if (plan.aliasToAdd) {
        await client.query(
          "INSERT INTO aliases (alias, project_id) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING",
          [plan.aliasToAdd, plan.intoId]
        );
      }

      await client.query("DELETE FROM projects WHERE id = $1", [plan.fromId]);

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
