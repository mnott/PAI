/**
 * RegistryBackend interface for the PAI registry (projects, sessions, tags,
 * aliases, links, compaction_log).
 *
 * Mirrors the pattern already proven by StorageBackend (src/storage/interface.ts)
 * for the federation/vault data: one async method per distinct operation used by
 * a caller today, no generic SQL passthrough. SQLite implementation lives in
 * registry-sqlite.ts; Postgres implementation is unit 4.
 *
 * Row shapes keep the existing snake_case column names (Project, Session) so the
 * 64 callers converted in unit 5 keep spreading/destructuring `.root_path`,
 * `.project_id` etc. unchanged — only the access path (`await backend.method()`
 * instead of `db.prepare(sql)`) changes.
 */

import type { MergePlan } from "../registry/merge.js";

export type { MergePlan };

// ---------------------------------------------------------------------------
// Row types (mirror registry/schema.ts DDL)
// ---------------------------------------------------------------------------

export type ProjectType = "local" | "central" | "obsidian-linked" | "external";
export type ProjectStatus = "active" | "archived" | "migrating";
export type SessionStatus = "open" | "completed" | "compacted";
export type LinkType = "related" | "follow-up" | "reference";
export type CompactionTrigger = "precompact" | "manual" | "end-session";

export interface Project {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  type: ProjectType;
  status: ProjectStatus;
  parent_id: number | null;
  obsidian_link: string | null;
  claude_notes_dir: string | null;
  session_config: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface ProjectWithSessionStats extends Project {
  session_count: number;
  last_active: number | null;
}

export interface Session {
  id: number;
  project_id: number;
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
  status: SessionStatus;
  claude_session_id: string | null;
  token_count: number | null;
  created_at: number;
  closed_at: number | null;
}

export interface SessionWithProject extends Session {
  project_slug: string;
  project_name: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewProject {
  slug: string;
  displayName: string;
  rootPath: string;
  encodedDir: string;
  type?: ProjectType;
  status?: ProjectStatus;
  createdAt: number;
  updatedAt: number;
}

/** Insert a project row, retrying with a numeric slug suffix on collision. */
export interface NewProjectWithSlugRetry {
  baseSlug: string;
  displayName: string;
  rootPath: string;
  encodedDir: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewSession {
  projectId: number;
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
  status?: SessionStatus;
  createdAt: number;
}

export interface NewCompactionLogEntry {
  projectId: number;
  sessionId: number | null;
  trigger: CompactionTrigger;
  filesWritten: string;
  tokenCount: number | null;
  createdAt: number;
}

export interface ListProjectsOptions {
  status?: ProjectStatus;
  /** WHERE status != 'archived' */
  excludeArchived?: boolean;
  tagName?: string;
  orderBy?: "status_updated" | "updated_desc" | "slug" | "id";
  limit?: number;
}

export interface ListProjectsByPathLengthOptions {
  excludeArchived?: boolean;
}

export interface ListProjectsWithStatsOptions {
  status?: ProjectStatus;
  tagId?: number;
  orderBy?: "status_updated" | "updated_desc";
}

export interface ListNamedProjectsOptions {
  /** LEFT JOIN aliases instead of JOIN, so unnamed projects are included too. */
  includeUnnamed?: boolean;
}

export interface ListSessionsOptions {
  projectId?: number;
  status?: SessionStatus | string;
  limit?: number;
}

export interface ListSessionsForProjectOptions {
  orderBy?: "number_asc" | "created_desc";
  limit?: number;
}

// ---------------------------------------------------------------------------
// RegistryBackend interface
// ---------------------------------------------------------------------------

export interface RegistryBackend {
  readonly backendType: "sqlite" | "postgres";

  close(): Promise<void>;

  /**
   * Erase every row from every registry table (projects, sessions, tags,
   * project_tags, session_tags, aliases, links, compaction_log). Used by
   * `pai registry rebuild`. Does not touch schema/DDL — only data.
   */
  resetRegistry(): Promise<void>;

  // -------------------------------------------------------------------------
  // Projects — reads
  // -------------------------------------------------------------------------

  getProjectById(id: number): Promise<Project | null>;
  /** Exact slug match; caseInsensitive uses lower(slug) = lower(?). excludeId excludes a row by id (conflict checks). */
  getProjectBySlug(
    slug: string,
    opts?: { caseInsensitive?: boolean; excludeId?: number }
  ): Promise<Project | null>;
  getProjectByAlias(
    alias: string,
    opts?: { caseInsensitive?: boolean }
  ): Promise<Project | null>;
  getProjectByRootPath(rootPath: string, opts?: { excludeId?: number }): Promise<Project | null>;
  getProjectByEncodedDir(encodedDir: string, opts?: { excludeId?: number }): Promise<Project | null>;
  /** status='active' AND cwd LIKE root_path || '%' ORDER BY length(root_path) DESC LIMIT 1. */
  findProjectByCwdPrefix(cwd: string): Promise<Project | null>;
  listProjects(opts?: ListProjectsOptions): Promise<Project[]>;
  /** All projects ordered by LENGTH(root_path) DESC, for caller-side prefix matching. */
  listProjectsByPathLengthDesc(opts?: ListProjectsByPathLengthOptions): Promise<Project[]>;
  listProjectsWithSessionStats(opts?: ListProjectsWithStatsOptions): Promise<ProjectWithSessionStats[]>;
  /** Projects joined to their curated alias ("name"), status='active'. */
  listNamedProjects(opts?: ListNamedProjectsOptions): Promise<
    Array<ProjectWithSessionStats & { name: string | null }>
  >;
  searchProjects(query: string, limit?: number): Promise<Project[]>;
  countProjects(opts?: { status?: ProjectStatus }): Promise<number>;
  getMostRecentProjectUpdatedAt(): Promise<number | null>;
  countChildProjects(parentId: number): Promise<number>;
  /** Sibling projects (slug variants) with at least one session, for split-identity detection. */
  findSiblingProjectsBySlugPattern(
    excludeProjectId: number,
    slug: string,
    limit?: number
  ): Promise<Array<{ slug: string; root_path: string; session_count: number }>>;

  // -------------------------------------------------------------------------
  // Projects — writes
  // -------------------------------------------------------------------------

  createProject(input: NewProject): Promise<Project>;
  createProjectWithSlugRetry(input: NewProjectWithSlugRetry): Promise<{ id: number; slug: string; created: boolean }>;
  updateProjectPath(id: number, patch: { rootPath?: string; encodedDir?: string }, updatedAt?: number): Promise<void>;
  updateProjectStatus(
    id: number,
    status: ProjectStatus,
    opts?: { archivedAt?: number | null; updatedAt?: number; requireCurrentStatus?: ProjectStatus }
  ): Promise<void>;
  updateProjectDisplayName(id: number, displayName: string, updatedAt?: number): Promise<void>;
  updateProjectType(id: number, type: ProjectType, updatedAt?: number): Promise<void>;
  updateProjectSessionConfig(id: number, config: string | null, updatedAt?: number): Promise<void>;
  updateProjectClaudeNotesDir(id: number, dir: string | null, updatedAt?: number): Promise<void>;
  updateProjectObsidianLink(id: number, link: string | null, updatedAt?: number): Promise<void>;
  updateProjectSlug(id: number, slug: string, updatedAt: number): Promise<void>;
  /** UPDATE projects SET parent_id = toParentId WHERE parent_id = fromParentId. Returns rows changed. */
  reassignProjectParent(fromParentId: number, toParentId: number): Promise<number>;
  deleteProject(id: number): Promise<void>;
  /** Atomic cascade: links, compaction_log, project_tags, aliases, sessions, then the project row. */
  deleteProjectCascade(id: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  listTagsForProject(projectId: number): Promise<string[]>;
  listAllTags(): Promise<Array<{ id: number; name: string }>>;
  /** INSERT OR IGNORE then SELECT id — returns the tag's id either way. */
  upsertTag(name: string): Promise<number>;
  addProjectTag(projectId: number, tagId: number): Promise<void>;
  projectHasTag(projectId: number, tagId: number): Promise<boolean>;
  deleteProjectTag(projectId: number, tagId: number): Promise<void>;
  reassignProjectTag(fromProjectId: number, toProjectId: number, tagId: number): Promise<void>;
  listProjectTagIds(projectId: number): Promise<number[]>;
  countProjectTagsForProject(projectId: number): Promise<number>;
  /** INSERT OR IGNORE INTO project_tags SELECT toProjectId, tag_id FROM project_tags WHERE project_id = fromProjectId. */
  copyProjectTags(fromProjectId: number, toProjectId: number): Promise<void>;
  deleteProjectTagsForProject(projectId: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  /** Look up the project_id an alias resolves to, or null. */
  resolveAlias(alias: string): Promise<number | null>;
  listAliasesForProject(projectId: number): Promise<string[]>;
  addAlias(alias: string, projectId: number): Promise<void>;
  removeAlias(alias: string): Promise<void>;
  countAliasesForProject(projectId: number): Promise<number>;
  /** Bulk UPDATE aliases SET project_id = toProjectId WHERE project_id = fromProjectId. */
  moveProjectAliases(fromProjectId: number, toProjectId: number): Promise<void>;
  /** Repoint a single alias to another project (used when folding duplicates). */
  reassignAlias(alias: string, toProjectId: number): Promise<void>;
  /** aliases JOIN projects, for task-owner resolution. Excludes archived projects. */
  listAliasMap(): Promise<Array<{ alias: string; slug: string; root_path: string }>>;

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  getSessionById(id: number): Promise<Session | null>;
  getSessionByNumber(projectId: number, number: number): Promise<Session | null>;
  getLatestSessionForProject(projectId: number): Promise<Session | null>;
  getMaxSessionNumber(projectId: number): Promise<number>;
  listSessionsForProject(projectId: number, opts?: ListSessionsForProjectOptions): Promise<Session[]>;
  /** Sessions joined to their project's slug/display_name, with optional project/status filters. */
  listSessions(opts?: ListSessionsOptions): Promise<SessionWithProject[]>;
  findSessionByFilename(projectId: number, filename: string): Promise<{ id: number } | null>;
  sessionNumberTaken(projectId: number, number: number): Promise<boolean>;
  createSession(input: NewSession): Promise<Session>;
  /** Insert only if (project_id, number) is free. Returns true if newly inserted. */
  upsertSessionIfAbsent(input: NewSession): Promise<boolean>;
  updateSessionMeta(id: number, patch: { slug?: string; title?: string; filename?: string }): Promise<void>;
  updateSessionNumber(id: number, number: number, opts?: { filename?: string }): Promise<void>;
  updateSessionFilename(id: number, filename: string): Promise<void>;
  /** Sets status, and closed_at when opts.closedAt is passed (session-stop/pre-compact hooks). */
  updateSessionStatus(id: number, status: SessionStatus, opts?: { closedAt?: number }): Promise<void>;
  moveSessionToProject(id: number, projectId: number, opts?: { number?: number }): Promise<void>;
  deleteSession(id: number): Promise<void>;
  /** Backfill claude_session_id/token_count/closed_at/status from dropId into keepId (COALESCE semantics), then leaves dropId untouched — caller deletes it separately via deleteSession. */
  backfillFoldedSession(keepId: number, dropId: number): Promise<void>;
  countSessionsForProject(projectId: number): Promise<number>;
  /** Total session count across all projects. */
  countSessions(): Promise<number>;
  getMostRecentSessionDate(projectId: number): Promise<string | null>;
  getMostRecentSessionCreatedAt(): Promise<number | null>;

  // -------------------------------------------------------------------------
  // Session tags
  // -------------------------------------------------------------------------

  listSessionTagIds(sessionId: number): Promise<number[]>;
  sessionHasTag(sessionId: number, tagId: number): Promise<boolean>;
  addSessionTag(sessionId: number, tagId: number): Promise<void>;
  deleteSessionTag(sessionId: number, tagId: number): Promise<void>;
  reassignSessionTag(fromSessionId: number, toSessionId: number, tagId: number): Promise<void>;
  listTagsForSession(sessionId: number): Promise<string[]>;

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  addLink(input: { sessionId: number; targetProjectId: number; linkType: LinkType; createdAt: number }): Promise<void>;
  listLinksForSession(sessionId: number): Promise<Array<{ id: number; target_project_id: number }>>;
  listLinksForProject(projectId: number): Promise<Array<{ id: number; session_id: number }>>;
  linkExists(sessionId: number, targetProjectId: number): Promise<boolean>;
  deleteLink(id: number): Promise<void>;
  deleteLinksTargetingProject(projectId: number): Promise<void>;
  /** DELETE FROM links WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?). */
  deleteLinksFromProjectSessions(projectId: number): Promise<void>;
  retargetLink(id: number, targetProjectId: number): Promise<void>;
  moveLinkToSession(id: number, sessionId: number): Promise<void>;
  /** Bulk UPDATE OR IGNORE links SET target_project_id = toProjectId WHERE target_project_id = fromProjectId. */
  reassignLinksTarget(fromProjectId: number, toProjectId: number): Promise<void>;
  countLinksForProject(projectId: number): Promise<number>;
  /** Self-links created by a merge: DELETE FROM links WHERE target_project_id = ? AND session_id IN (SELECT id FROM sessions WHERE project_id = ?), same id both sides. */
  deleteSelfLinksForProject(projectId: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Compaction log
  // -------------------------------------------------------------------------

  appendCompactionLog(entry: NewCompactionLogEntry): Promise<void>;
  countCompactionLogsForProject(projectId: number): Promise<number>;
  /** Returns rows changed. */
  moveCompactionLogsByProject(fromProjectId: number, toProjectId: number): Promise<number>;
  moveCompactionLogsBySession(fromSessionId: number, toSessionId: number): Promise<void>;
  deleteCompactionLogsForProject(projectId: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Project merge (wraps src/registry/merge.ts — behaviour unchanged)
  // -------------------------------------------------------------------------

  planProjectMerge(fromSlug: string, intoSlug: string): Promise<MergePlan>;
  applyProjectMerge(plan: MergePlan): Promise<void>;
}
