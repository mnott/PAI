/**
 * SQLiteRegistryBackend — wraps the existing better-sqlite3 registry.db
 * (src/registry/db.ts, src/registry/merge.ts) behind the RegistryBackend
 * interface.
 *
 * Thin adapter: every method is the same SQL the 64 direct callers run today,
 * just relocated here and wrapped in Promise.resolve(...) so the interface can
 * be async (matching StorageBackend, and Postgres in unit 4) without changing
 * SQLite behaviour.
 */

import type { Database } from "better-sqlite3";
import { planMerge, applyMerge } from "./sqlite/registry-merge.js";
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

export class SQLiteRegistryBackend implements RegistryBackend {
  readonly backendType = "sqlite" as const;

  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Expose the raw better-sqlite3 Database handle for not-yet-converted callers. */
  getRawDb(): Database {
    return this.db;
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  async resetRegistry(): Promise<void> {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM links").run();
      this.db.prepare("DELETE FROM compaction_log").run();
      this.db.prepare("DELETE FROM session_tags").run();
      this.db.prepare("DELETE FROM project_tags").run();
      this.db.prepare("DELETE FROM aliases").run();
      this.db.prepare("DELETE FROM sessions").run();
      this.db.prepare("DELETE FROM tags").run();
      this.db.prepare("DELETE FROM projects").run();
    });
    run();
  }

  // -------------------------------------------------------------------------
  // Projects — reads
  // -------------------------------------------------------------------------

  async getProjectById(id: number): Promise<Project | null> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
    return row ?? null;
  }

  async getProjectBySlug(
    slug: string,
    opts: { caseInsensitive?: boolean; excludeId?: number } = {}
  ): Promise<Project | null> {
    let sql = opts.caseInsensitive
      ? "SELECT * FROM projects WHERE lower(slug) = lower(?)"
      : "SELECT * FROM projects WHERE slug = ?";
    const params: unknown[] = [slug];
    if (opts.excludeId !== undefined) {
      sql += " AND id != ?";
      params.push(opts.excludeId);
    }
    const row = this.db.prepare(sql).get(...params) as Project | undefined;
    return row ?? null;
  }

  async getProjectByAlias(
    alias: string,
    opts: { caseInsensitive?: boolean } = {}
  ): Promise<Project | null> {
    const sql = opts.caseInsensitive
      ? "SELECT p.* FROM projects p JOIN aliases a ON a.project_id = p.id WHERE lower(a.alias) = lower(?)"
      : "SELECT p.* FROM projects p JOIN aliases a ON a.project_id = p.id WHERE a.alias = ?";
    const row = this.db.prepare(sql).get(alias) as Project | undefined;
    return row ?? null;
  }

  async getProjectByRootPath(rootPath: string, opts: { excludeId?: number } = {}): Promise<Project | null> {
    let sql = "SELECT * FROM projects WHERE root_path = ?";
    const params: unknown[] = [rootPath];
    if (opts.excludeId !== undefined) {
      sql += " AND id != ?";
      params.push(opts.excludeId);
    }
    const row = this.db.prepare(sql).get(...params) as Project | undefined;
    return row ?? null;
  }

  async getProjectByEncodedDir(encodedDir: string, opts: { excludeId?: number } = {}): Promise<Project | null> {
    let sql = "SELECT * FROM projects WHERE encoded_dir = ?";
    const params: unknown[] = [encodedDir];
    if (opts.excludeId !== undefined) {
      sql += " AND id != ?";
      params.push(opts.excludeId);
    }
    const row = this.db.prepare(sql).get(...params) as Project | undefined;
    return row ?? null;
  }

  async findProjectByCwdPrefix(cwd: string): Promise<Project | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM projects WHERE status = 'active' AND ? LIKE root_path || '%'
         ORDER BY length(root_path) DESC LIMIT 1`
      )
      .get(cwd) as Project | undefined;
    return row ?? null;
  }

  async listProjects(opts: ListProjectsOptions = {}): Promise<Project[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      where.push("p.status = ?");
      params.push(opts.status);
    }
    if (opts.excludeArchived) {
      where.push("p.status != 'archived'");
    }
    if (opts.tagName) {
      where.push(
        "p.id IN (SELECT pt.project_id FROM project_tags pt JOIN tags t ON pt.tag_id = t.id WHERE t.name = ?)"
      );
      params.push(opts.tagName);
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
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    return this.db.prepare(sql).all(...params) as Project[];
  }

  async listProjectsByPathLengthDesc(opts: ListProjectsByPathLengthOptions = {}): Promise<Project[]> {
    const where = opts.excludeArchived ? "WHERE status != 'archived'" : "";
    return this.db
      .prepare(`SELECT * FROM projects ${where} ORDER BY LENGTH(root_path) DESC`)
      .all() as Project[];
  }

  async listProjectsWithSessionStats(
    opts: ListProjectsWithStatsOptions = {}
  ): Promise<ProjectWithSessionStats[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      where.push("p.status = ?");
      params.push(opts.status);
    }
    if (opts.tagId !== undefined) {
      where.push("p.id IN (SELECT project_id FROM project_tags WHERE tag_id = ?)");
      params.push(opts.tagId);
    }

    let sql = `
      SELECT p.*,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
      FROM projects p
    `;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql +=
      opts.orderBy === "updated_desc"
        ? " ORDER BY p.updated_at DESC"
        : " ORDER BY p.status ASC, p.updated_at DESC";

    return this.db.prepare(sql).all(...params) as ProjectWithSessionStats[];
  }

  async listNamedProjects(
    opts: ListNamedProjectsOptions = {}
  ): Promise<Array<ProjectWithSessionStats & { name: string | null }>> {
    const join = opts.includeUnnamed ? "LEFT JOIN" : "JOIN";
    const sql = `
      SELECT p.*, a.alias AS name,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.project_id = p.id) AS last_active
      FROM projects p
      ${join} aliases a ON a.project_id = p.id
      WHERE p.status = 'active'
      ORDER BY p.updated_at DESC
    `;
    return this.db.prepare(sql).all() as Array<ProjectWithSessionStats & { name: string | null }>;
  }

  async searchProjects(query: string, limit = 20): Promise<Project[]> {
    const q = `%${query}%`;
    return this.db
      .prepare(
        `SELECT * FROM projects WHERE slug LIKE ? OR display_name LIKE ? OR root_path LIKE ?
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(q, q, q, limit) as Project[];
  }

  async countProjects(opts: { status?: ProjectStatus } = {}): Promise<number> {
    const sql = opts.status
      ? "SELECT COUNT(*) AS n FROM projects WHERE status = ?"
      : "SELECT COUNT(*) AS n FROM projects";
    const row = opts.status
      ? (this.db.prepare(sql).get(opts.status) as { n: number })
      : (this.db.prepare(sql).get() as { n: number });
    return row.n;
  }

  async getMostRecentProjectUpdatedAt(): Promise<number | null> {
    const row = this.db.prepare("SELECT updated_at FROM projects ORDER BY updated_at DESC LIMIT 1").get() as
      | { updated_at: number }
      | undefined;
    return row?.updated_at ?? null;
  }

  async countChildProjects(parentId: number): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE parent_id = ?").get(parentId) as {
      n: number;
    }).n;
  }

  async findSiblingProjectsBySlugPattern(
    excludeProjectId: number,
    slug: string,
    limit = 3
  ): Promise<Array<{ slug: string; root_path: string; session_count: number }>> {
    return this.db
      .prepare(
        `SELECT p.slug, p.root_path, COUNT(s.id) AS session_count
         FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
         WHERE p.id != ? AND (p.slug = ? OR p.slug LIKE ? || '-%' OR ? LIKE p.slug || '-%')
         GROUP BY p.id HAVING session_count > 0 ORDER BY session_count DESC LIMIT ?`
      )
      .all(excludeProjectId, slug, slug, slug, limit) as Array<{
      slug: string;
      root_path: string;
      session_count: number;
    }>;
  }

  // -------------------------------------------------------------------------
  // Projects — writes
  // -------------------------------------------------------------------------

  async createProject(input: NewProject): Promise<Project> {
    const type: ProjectType = input.type ?? "local";
    const status: ProjectStatus = input.status ?? "active";
    const result = this.db
      .prepare(
        `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.slug,
        input.displayName,
        input.rootPath,
        input.encodedDir,
        type,
        status,
        input.createdAt,
        input.updatedAt
      );
    return (await this.getProjectById(result.lastInsertRowid as number))!;
  }

  async createProjectWithSlugRetry(
    input: NewProjectWithSlugRetry
  ): Promise<{ id: number; slug: string; created: boolean }> {
    let slug = input.baseSlug;
    let attempt = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`
    );

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const info = insert.run(
        slug,
        input.displayName,
        input.rootPath,
        input.encodedDir,
        input.createdAt,
        input.updatedAt
      );
      if (info.changes > 0) {
        return { id: info.lastInsertRowid as number, slug, created: true };
      }

      const existing = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(input.rootPath) as
        | { id: number }
        | undefined;
      if (existing) {
        return { id: existing.id, slug, created: false };
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
      sets.push("root_path = ?");
      params.push(patch.rootPath);
    }
    if (patch.encodedDir !== undefined) {
      sets.push("encoded_dir = ?");
      params.push(patch.encodedDir);
    }
    if (updatedAt !== undefined) {
      sets.push("updated_at = ?");
      params.push(updatedAt);
    }
    if (!sets.length) return;
    params.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  async updateProjectStatus(
    id: number,
    status: ProjectStatus,
    opts: { archivedAt?: number | null; updatedAt?: number; requireCurrentStatus?: ProjectStatus } = {}
  ): Promise<void> {
    const sets: string[] = ["status = ?"];
    const params: unknown[] = [status];
    if (opts.archivedAt !== undefined) {
      sets.push("archived_at = ?");
      params.push(opts.archivedAt);
    }
    if (opts.updatedAt !== undefined) {
      sets.push("updated_at = ?");
      params.push(opts.updatedAt);
    }
    let sql = `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`;
    params.push(id);
    if (opts.requireCurrentStatus) {
      sql += " AND status = ?";
      params.push(opts.requireCurrentStatus);
    }
    this.db.prepare(sql).run(...params);
  }

  async updateProjectDisplayName(id: number, displayName: string, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      this.db
        .prepare("UPDATE projects SET display_name = ?, updated_at = ? WHERE id = ?")
        .run(displayName, updatedAt, id);
    } else {
      this.db.prepare("UPDATE projects SET display_name = ? WHERE id = ?").run(displayName, id);
    }
  }

  async updateProjectType(id: number, type: ProjectType, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      this.db.prepare("UPDATE projects SET type = ?, updated_at = ? WHERE id = ?").run(type, updatedAt, id);
    } else {
      this.db.prepare("UPDATE projects SET type = ? WHERE id = ?").run(type, id);
    }
  }

  async updateProjectSessionConfig(id: number, config: string | null, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      this.db
        .prepare("UPDATE projects SET session_config = ?, updated_at = ? WHERE id = ?")
        .run(config, updatedAt, id);
    } else {
      this.db.prepare("UPDATE projects SET session_config = ? WHERE id = ?").run(config, id);
    }
  }

  async updateProjectClaudeNotesDir(id: number, dir: string | null, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      this.db
        .prepare("UPDATE projects SET claude_notes_dir = ?, updated_at = ? WHERE id = ?")
        .run(dir, updatedAt, id);
    } else {
      this.db.prepare("UPDATE projects SET claude_notes_dir = ? WHERE id = ?").run(dir, id);
    }
  }

  async updateProjectObsidianLink(id: number, link: string | null, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) {
      this.db
        .prepare("UPDATE projects SET obsidian_link = ?, updated_at = ? WHERE id = ?")
        .run(link, updatedAt, id);
    } else {
      this.db.prepare("UPDATE projects SET obsidian_link = ? WHERE id = ?").run(link, id);
    }
  }

  async updateProjectSlug(id: number, slug: string, updatedAt: number): Promise<void> {
    this.db.prepare("UPDATE projects SET slug = ?, updated_at = ? WHERE id = ?").run(slug, updatedAt, id);
  }

  async reassignProjectParent(fromParentId: number, toParentId: number): Promise<number> {
    return this.db.prepare("UPDATE projects SET parent_id = ? WHERE parent_id = ?").run(toParentId, fromParentId)
      .changes;
  }

  async deleteProject(id: number): Promise<void> {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  async deleteProjectCascade(id: number): Promise<void> {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM links WHERE target_project_id = ?").run(id);
      this.db
        .prepare("DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)")
        .run(id);
      this.db.prepare("DELETE FROM compaction_log WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_tags WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM aliases WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    run();
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async listTagsForProject(projectId: number): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT t.name FROM tags t JOIN project_tags pt ON pt.tag_id = t.id WHERE pt.project_id = ? ORDER BY t.name"
      )
      .all(projectId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async listAllTags(): Promise<Array<{ id: number; name: string }>> {
    return this.db.prepare("SELECT id, name FROM tags ORDER BY name").all() as Array<{
      id: number;
      name: string;
    }>;
  }

  async upsertTag(name: string): Promise<number> {
    this.db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(name);
    return (this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number }).id;
  }

  async addProjectTag(projectId: number, tagId: number): Promise<void> {
    this.db.prepare("INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)").run(projectId, tagId);
  }

  async projectHasTag(projectId: number, tagId: number): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM project_tags WHERE project_id = ? AND tag_id = ?").get(projectId, tagId);
  }

  async deleteProjectTag(projectId: number, tagId: number): Promise<void> {
    this.db.prepare("DELETE FROM project_tags WHERE project_id = ? AND tag_id = ?").run(projectId, tagId);
  }

  async reassignProjectTag(fromProjectId: number, toProjectId: number, tagId: number): Promise<void> {
    this.db
      .prepare("UPDATE project_tags SET project_id = ? WHERE project_id = ? AND tag_id = ?")
      .run(toProjectId, fromProjectId, tagId);
  }

  async listProjectTagIds(projectId: number): Promise<number[]> {
    const rows = this.db.prepare("SELECT tag_id FROM project_tags WHERE project_id = ?").all(projectId) as Array<{
      tag_id: number;
    }>;
    return rows.map((r) => r.tag_id);
  }

  async countProjectTagsForProject(projectId: number): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?").get(projectId) as {
      n: number;
    }).n;
  }

  async copyProjectTags(fromProjectId: number, toProjectId: number): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO project_tags (project_id, tag_id) SELECT ?, tag_id FROM project_tags WHERE project_id = ?"
      )
      .run(toProjectId, fromProjectId);
  }

  async deleteProjectTagsForProject(projectId: number): Promise<void> {
    this.db.prepare("DELETE FROM project_tags WHERE project_id = ?").run(projectId);
  }

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  async resolveAlias(alias: string): Promise<number | null> {
    const row = this.db.prepare("SELECT project_id FROM aliases WHERE alias = ?").get(alias) as
      | { project_id: number }
      | undefined;
    return row?.project_id ?? null;
  }

  async listAliasesForProject(projectId: number): Promise<string[]> {
    const rows = this.db.prepare("SELECT alias FROM aliases WHERE project_id = ? ORDER BY alias").all(
      projectId
    ) as Array<{ alias: string }>;
    return rows.map((r) => r.alias);
  }

  async addAlias(alias: string, projectId: number): Promise<void> {
    this.db.prepare("INSERT INTO aliases (alias, project_id) VALUES (?, ?)").run(alias, projectId);
  }

  async removeAlias(alias: string): Promise<void> {
    this.db.prepare("DELETE FROM aliases WHERE alias = ?").run(alias);
  }

  async countAliasesForProject(projectId: number): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE project_id = ?").get(projectId) as {
      n: number;
    }).n;
  }

  async moveProjectAliases(fromProjectId: number, toProjectId: number): Promise<void> {
    this.db.prepare("UPDATE aliases SET project_id = ? WHERE project_id = ?").run(toProjectId, fromProjectId);
  }

  async reassignAlias(alias: string, toProjectId: number): Promise<void> {
    this.db.prepare("UPDATE aliases SET project_id = ? WHERE alias = ?").run(toProjectId, alias);
  }

  async listAliasMap(): Promise<Array<{ alias: string; slug: string; root_path: string }>> {
    return this.db
      .prepare(
        `SELECT a.alias AS alias, p.slug AS slug, p.root_path AS root_path
         FROM aliases a JOIN projects p ON p.id = a.project_id WHERE p.status != 'archived'`
      )
      .all() as Array<{ alias: string; slug: string; root_path: string }>;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async getSessionById(id: number): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
    return row ?? null;
  }

  async getSessionByNumber(projectId: number, number: number): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND number = ?").get(
      projectId,
      number
    ) as Session | undefined;
    return row ?? null;
  }

  async getLatestSessionForProject(projectId: number): Promise<Session | null> {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY number DESC LIMIT 1")
      .get(projectId) as Session | undefined;
    return row ?? null;
  }

  async getMaxSessionNumber(projectId: number): Promise<number> {
    const row = this.db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM sessions WHERE project_id = ?").get(
      projectId
    ) as { n: number };
    return row.n;
  }

  async listSessionsForProject(
    projectId: number,
    opts: ListSessionsForProjectOptions = {}
  ): Promise<Session[]> {
    const orderBy = opts.orderBy === "created_desc" ? "created_at DESC" : "number ASC";
    let sql = `SELECT * FROM sessions WHERE project_id = ? ORDER BY ${orderBy}`;
    const params: unknown[] = [projectId];
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return this.db.prepare(sql).all(...params) as Session[];
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionWithProject[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId !== undefined) {
      where.push("s.project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.status) {
      where.push("s.status = ?");
      params.push(opts.status);
    }
    let sql = `
      SELECT s.*, p.slug AS project_slug, p.display_name AS project_name
      FROM sessions s JOIN projects p ON p.id = s.project_id
    `;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY s.date DESC, s.number DESC";
    const limit = opts.limit ?? 20;
    sql += ` LIMIT ${limit}`;
    return this.db.prepare(sql).all(...params) as SessionWithProject[];
  }

  async findSessionByFilename(projectId: number, filename: string): Promise<{ id: number } | null> {
    const row = this.db
      .prepare("SELECT id FROM sessions WHERE project_id = ? AND filename = ? LIMIT 1")
      .get(projectId, filename) as { id: number } | undefined;
    return row ?? null;
  }

  async sessionNumberTaken(projectId: number, number: number): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM sessions WHERE project_id = ? AND number = ? LIMIT 1").get(
      projectId,
      number
    );
  }

  async createSession(input: NewSession): Promise<Session> {
    const status = input.status ?? "completed";
    const result = this.db
      .prepare(
        `INSERT INTO sessions (project_id, number, date, slug, title, filename, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.projectId, input.number, input.date, input.slug, input.title, input.filename, status, input.createdAt);
    return (await this.getSessionById(result.lastInsertRowid as number))!;
  }

  async upsertSessionIfAbsent(input: NewSession): Promise<boolean> {
    const existing = this.db
      .prepare("SELECT id FROM sessions WHERE project_id = ? AND number = ?")
      .get(input.projectId, input.number);
    if (existing) return false;

    const status = input.status ?? "completed";
    this.db
      .prepare(
        `INSERT INTO sessions (project_id, number, date, slug, title, filename, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.projectId, input.number, input.date, input.slug, input.title, input.filename, status, input.createdAt);
    return true;
  }

  async updateSessionMeta(
    id: number,
    patch: { slug?: string; title?: string; filename?: string }
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.slug !== undefined) {
      sets.push("slug = ?");
      params.push(patch.slug);
    }
    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title);
    }
    if (patch.filename !== undefined) {
      sets.push("filename = ?");
      params.push(patch.filename);
    }
    if (!sets.length) return;
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  async updateSessionNumber(id: number, number: number, opts: { filename?: string } = {}): Promise<void> {
    if (opts.filename !== undefined) {
      this.db.prepare("UPDATE sessions SET number = ?, filename = ? WHERE id = ?").run(number, opts.filename, id);
    } else {
      this.db.prepare("UPDATE sessions SET number = ? WHERE id = ?").run(number, id);
    }
  }

  async updateSessionFilename(id: number, filename: string): Promise<void> {
    this.db.prepare("UPDATE sessions SET filename = ? WHERE id = ?").run(filename, id);
  }

  async updateSessionStatus(id: number, status: SessionStatus, opts: { closedAt?: number } = {}): Promise<void> {
    if (opts.closedAt !== undefined) {
      this.db.prepare("UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?").run(status, opts.closedAt, id);
    } else {
      this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
    }
  }

  async moveSessionToProject(id: number, projectId: number, opts: { number?: number } = {}): Promise<void> {
    if (opts.number !== undefined) {
      this.db.prepare("UPDATE sessions SET project_id = ?, number = ? WHERE id = ?").run(
        projectId,
        opts.number,
        id
      );
    } else {
      this.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run(projectId, id);
    }
  }

  async deleteSession(id: number): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async backfillFoldedSession(keepId: number, dropId: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE sessions SET
           claude_session_id = COALESCE(claude_session_id,
                                        (SELECT claude_session_id FROM sessions WHERE id = ?)),
           token_count       = COALESCE(token_count,
                                        (SELECT token_count FROM sessions WHERE id = ?)),
           closed_at         = COALESCE(closed_at,
                                        (SELECT closed_at FROM sessions WHERE id = ?)),
           status            = CASE WHEN status = 'open'
                                     AND (SELECT status FROM sessions WHERE id = ?) != 'open'
                                    THEN (SELECT status FROM sessions WHERE id = ?)
                                    ELSE status END
         WHERE id = ?`
      )
      .run(dropId, dropId, dropId, dropId, dropId, keepId);
  }

  async countSessionsForProject(projectId: number): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?").get(projectId) as {
      n: number;
    }).n;
  }

  async countSessions(): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  }

  async getMostRecentSessionDate(projectId: number): Promise<string | null> {
    const row = this.db
      .prepare("SELECT date FROM sessions WHERE project_id = ? ORDER BY date DESC LIMIT 1")
      .get(projectId) as { date: string } | undefined;
    return row?.date ?? null;
  }

  async getMostRecentSessionCreatedAt(): Promise<number | null> {
    const row = this.db.prepare("SELECT created_at FROM sessions ORDER BY created_at DESC LIMIT 1").get() as
      | { created_at: number }
      | undefined;
    return row?.created_at ?? null;
  }

  // -------------------------------------------------------------------------
  // Session tags
  // -------------------------------------------------------------------------

  async listSessionTagIds(sessionId: number): Promise<number[]> {
    const rows = this.db.prepare("SELECT tag_id FROM session_tags WHERE session_id = ?").all(sessionId) as Array<{
      tag_id: number;
    }>;
    return rows.map((r) => r.tag_id);
  }

  async sessionHasTag(sessionId: number, tagId: number): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM session_tags WHERE session_id = ? AND tag_id = ?").get(
      sessionId,
      tagId
    );
  }

  async addSessionTag(sessionId: number, tagId: number): Promise<void> {
    this.db.prepare("INSERT INTO session_tags (session_id, tag_id) VALUES (?, ?)").run(sessionId, tagId);
  }

  async deleteSessionTag(sessionId: number, tagId: number): Promise<void> {
    this.db.prepare("DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?").run(sessionId, tagId);
  }

  async reassignSessionTag(fromSessionId: number, toSessionId: number, tagId: number): Promise<void> {
    this.db
      .prepare("UPDATE session_tags SET session_id = ? WHERE session_id = ? AND tag_id = ?")
      .run(toSessionId, fromSessionId, tagId);
  }

  async listTagsForSession(sessionId: number): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT t.name FROM tags t JOIN session_tags st ON st.tag_id = t.id WHERE st.session_id = ? ORDER BY t.name"
      )
      .all(sessionId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
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
    this.db
      .prepare("INSERT INTO links (session_id, target_project_id, link_type, created_at) VALUES (?, ?, ?, ?)")
      .run(input.sessionId, input.targetProjectId, input.linkType, input.createdAt);
  }

  async listLinksForSession(sessionId: number): Promise<Array<{ id: number; target_project_id: number }>> {
    return this.db.prepare("SELECT id, target_project_id FROM links WHERE session_id = ?").all(
      sessionId
    ) as Array<{ id: number; target_project_id: number }>;
  }

  async listLinksForProject(projectId: number): Promise<Array<{ id: number; session_id: number }>> {
    return this.db.prepare("SELECT id, session_id FROM links WHERE target_project_id = ?").all(
      projectId
    ) as Array<{ id: number; session_id: number }>;
  }

  async linkExists(sessionId: number, targetProjectId: number): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM links WHERE session_id = ? AND target_project_id = ? LIMIT 1").get(
      sessionId,
      targetProjectId
    );
  }

  async deleteLink(id: number): Promise<void> {
    this.db.prepare("DELETE FROM links WHERE id = ?").run(id);
  }

  async deleteLinksTargetingProject(projectId: number): Promise<void> {
    this.db.prepare("DELETE FROM links WHERE target_project_id = ?").run(projectId);
  }

  async deleteLinksFromProjectSessions(projectId: number): Promise<void> {
    this.db
      .prepare("DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)")
      .run(projectId);
  }

  async retargetLink(id: number, targetProjectId: number): Promise<void> {
    this.db.prepare("UPDATE links SET target_project_id = ? WHERE id = ?").run(targetProjectId, id);
  }

  async moveLinkToSession(id: number, sessionId: number): Promise<void> {
    this.db.prepare("UPDATE links SET session_id = ? WHERE id = ?").run(sessionId, id);
  }

  async reassignLinksTarget(fromProjectId: number, toProjectId: number): Promise<void> {
    this.db
      .prepare("UPDATE OR IGNORE links SET target_project_id = ? WHERE target_project_id = ?")
      .run(toProjectId, fromProjectId);
  }

  async countLinksForProject(projectId: number): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM links WHERE target_project_id = ?").get(projectId) as {
      n: number;
    }).n;
  }

  async deleteSelfLinksForProject(projectId: number): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM links WHERE target_project_id = ?
           AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)`
      )
      .run(projectId, projectId);
  }

  // -------------------------------------------------------------------------
  // Compaction log
  // -------------------------------------------------------------------------

  async appendCompactionLog(entry: NewCompactionLogEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO compaction_log (project_id, session_id, trigger, files_written, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(entry.projectId, entry.sessionId, entry.trigger, entry.filesWritten, entry.tokenCount, entry.createdAt);
  }

  async countCompactionLogsForProject(projectId: number): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM compaction_log WHERE project_id = ?").get(projectId) as {
      n: number;
    }).n;
  }

  async moveCompactionLogsByProject(fromProjectId: number, toProjectId: number): Promise<number> {
    return this.db
      .prepare("UPDATE compaction_log SET project_id = ? WHERE project_id = ?")
      .run(toProjectId, fromProjectId).changes;
  }

  async moveCompactionLogsBySession(fromSessionId: number, toSessionId: number): Promise<void> {
    this.db
      .prepare("UPDATE compaction_log SET session_id = ? WHERE session_id = ?")
      .run(toSessionId, fromSessionId);
  }

  async deleteCompactionLogsForProject(projectId: number): Promise<void> {
    this.db.prepare("DELETE FROM compaction_log WHERE project_id = ?").run(projectId);
  }

  // -------------------------------------------------------------------------
  // Project merge
  // -------------------------------------------------------------------------

  async planProjectMerge(fromSlug: string, intoSlug: string): Promise<MergePlan> {
    return planMerge(this.db, fromSlug, intoSlug);
  }

  async applyProjectMerge(plan: MergePlan): Promise<void> {
    applyMerge(this.db, plan);
  }
}
