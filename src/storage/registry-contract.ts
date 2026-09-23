/**
 * Backend-agnostic RegistryBackend contract.
 *
 * One function, called from a `*.test.ts` file with a factory for the backend
 * under test. Unit 3 runs this against SQLiteRegistryBackend; unit 4 runs the
 * same function against a scratch Postgres database — same assertions, same
 * expected results, proving the two implementations agree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RegistryBackend } from "./registry-interface.js";
import { SQLiteRegistryBackend } from "./registry-sqlite.js";

export interface RegistryBackendFixture {
  backend: RegistryBackend;
  cleanup: () => Promise<void>;
}

/**
 * Every method the contract suite must call at least once, derived from the
 * reference SQLite implementation's own prototype rather than hand-typed —
 * "constructor" and "getRawDb" are the only members SQLiteRegistryBackend
 * carries that are not part of the RegistryBackend interface.
 */
const NON_INTERFACE_MEMBERS = new Set(["constructor", "getRawDb"]);
const ALL_REGISTRY_METHODS = Object.getOwnPropertyNames(SQLiteRegistryBackend.prototype).filter(
  (m) => !NON_INTERFACE_MEMBERS.has(m)
);

function trackCalls(raw: RegistryBackend, calledMethods: Set<string>): RegistryBackend {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && typeof prop === "string") {
        return (...args: unknown[]) => {
          calledMethods.add(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
}

export function defineRegistryBackendContract(
  label: string,
  makeFixture: () => Promise<RegistryBackendFixture>
): void {
  describe(`RegistryBackend contract (${label})`, () => {
    let backend: RegistryBackend;
    let cleanup: () => Promise<void>;
    const calledMethods = new Set<string>();

    beforeEach(async () => {
      const fixture = await makeFixture();
      backend = trackCalls(fixture.backend, calledMethods);
      cleanup = fixture.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // -----------------------------------------------------------------------
    // Projects
    // -----------------------------------------------------------------------

    it("creates a project and round-trips it by id, slug, and root_path", async () => {
      const created = await backend.createProject({
        slug: "pai",
        displayName: "PAI",
        rootPath: "/tmp/pai",
        encodedDir: "-tmp-pai",
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(created.id).toBeGreaterThan(0);
      expect(created.status).toBe("active");
      expect(created.type).toBe("local");

      const byId = await backend.getProjectById(created.id);
      expect(byId?.slug).toBe("pai");

      const bySlug = await backend.getProjectBySlug("pai");
      expect(bySlug?.id).toBe(created.id);

      const byPath = await backend.getProjectByRootPath("/tmp/pai");
      expect(byPath?.id).toBe(created.id);

      const byCI = await backend.getProjectBySlug("PAI", { caseInsensitive: true });
      expect(byCI?.id).toBe(created.id);
    });

    it("archives and unarchives a project, tracking archived_at", async () => {
      const p = await backend.createProject({
        slug: "arch",
        displayName: "Arch",
        rootPath: "/tmp/arch",
        encodedDir: "-tmp-arch",
        createdAt: 1000,
        updatedAt: 1000,
      });

      await backend.updateProjectStatus(p.id, "archived", { archivedAt: 2000, updatedAt: 2000 });
      let row = await backend.getProjectById(p.id);
      expect(row?.status).toBe("archived");
      expect(row?.archived_at).toBe(2000);

      await backend.updateProjectStatus(p.id, "active", { archivedAt: null, updatedAt: 3000 });
      row = await backend.getProjectById(p.id);
      expect(row?.status).toBe("active");
      expect(row?.archived_at).toBeNull();
    });

    it("lists projects with session stats", async () => {
      const p = await backend.createProject({
        slug: "stats",
        displayName: "Stats",
        rootPath: "/tmp/stats",
        encodedDir: "-tmp-stats",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s1",
        title: "Session One",
        filename: "0001.md",
        createdAt: 1000,
      });

      const rows = await backend.listProjectsWithSessionStats({ status: "active" });
      const found = rows.find((r) => r.id === p.id);
      expect(found?.session_count).toBe(1);
    });

    it("deletes a project and its dependents in one cascade", async () => {
      const p = await backend.createProject({
        slug: "gone",
        displayName: "Gone",
        rootPath: "/tmp/gone",
        encodedDir: "-tmp-gone",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s1",
        title: "S1",
        filename: "0001.md",
        createdAt: 1000,
      });
      await backend.addAlias("gone-alias", p.id);
      await backend.appendCompactionLog({
        projectId: p.id,
        sessionId: s.id,
        trigger: "manual",
        filesWritten: "a.md",
        tokenCount: null,
        createdAt: 1000,
      });

      await backend.deleteProjectCascade(p.id);

      expect(await backend.getProjectById(p.id)).toBeNull();
      expect(await backend.getSessionById(s.id)).toBeNull();
      expect(await backend.resolveAlias("gone-alias")).toBeNull();
      expect(await backend.countCompactionLogsForProject(p.id)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    it("creates a session and round-trips it by id and number", async () => {
      const p = await backend.createProject({
        slug: "sess",
        displayName: "Sess",
        rootPath: "/tmp/sess",
        encodedDir: "-tmp-sess",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "hello",
        title: "Hello",
        filename: "0001.md",
        createdAt: 1000,
      });
      expect(s.status).toBe("completed");

      const byNumber = await backend.getSessionByNumber(p.id, 1);
      expect(byNumber?.id).toBe(s.id);

      const latest = await backend.getLatestSessionForProject(p.id);
      expect(latest?.id).toBe(s.id);

      expect(await backend.getMaxSessionNumber(p.id)).toBe(1);
      expect(await backend.sessionNumberTaken(p.id, 1)).toBe(true);
      expect(await backend.sessionNumberTaken(p.id, 2)).toBe(false);
    });

    it("upsertSessionIfAbsent only inserts once for the same (project, number)", async () => {
      const p = await backend.createProject({
        slug: "upsert",
        displayName: "Upsert",
        rootPath: "/tmp/upsert",
        encodedDir: "-tmp-upsert",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const input = {
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      };
      expect(await backend.upsertSessionIfAbsent(input)).toBe(true);
      expect(await backend.upsertSessionIfAbsent(input)).toBe(false);
      expect(await backend.countSessionsForProject(p.id)).toBe(1);
    });

    it("moves a session to another project, with and without renumbering", async () => {
      const a = await backend.createProject({
        slug: "move-a",
        displayName: "A",
        rootPath: "/tmp/move-a",
        encodedDir: "-tmp-move-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const b = await backend.createProject({
        slug: "move-b",
        displayName: "B",
        rootPath: "/tmp/move-b",
        encodedDir: "-tmp-move-b",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: a.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      });

      await backend.moveSessionToProject(s.id, b.id, { number: 5 });
      const moved = await backend.getSessionById(s.id);
      expect(moved?.project_id).toBe(b.id);
      expect(moved?.number).toBe(5);
    });

    it("backfills a folded session's missing fields from the dropped row", async () => {
      const p = await backend.createProject({
        slug: "fold",
        displayName: "Fold",
        rootPath: "/tmp/fold",
        encodedDir: "-tmp-fold",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const keep = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "keep",
        title: "Keep",
        filename: "0001.md",
        createdAt: 1000,
      });
      const drop = await backend.createSession({
        projectId: p.id,
        number: 2,
        date: "2026-09-22",
        slug: "drop",
        title: "Drop",
        filename: "0002.md",
        createdAt: 1000,
      });

      await backend.backfillFoldedSession(keep.id, drop.id);
      await backend.deleteSession(drop.id);

      const survivor = await backend.getSessionById(keep.id);
      expect(survivor).not.toBeNull();
      expect(await backend.getSessionById(drop.id)).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Tags
    // -----------------------------------------------------------------------

    it("upserts a tag and attaches it to a project idempotently", async () => {
      const p = await backend.createProject({
        slug: "tagged",
        displayName: "Tagged",
        rootPath: "/tmp/tagged",
        encodedDir: "-tmp-tagged",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const tagId1 = await backend.upsertTag("work");
      const tagId2 = await backend.upsertTag("work");
      expect(tagId1).toBe(tagId2);

      expect(await backend.projectHasTag(p.id, tagId1)).toBe(false);
      await backend.addProjectTag(p.id, tagId1);
      expect(await backend.projectHasTag(p.id, tagId1)).toBe(true);

      const names = await backend.listTagsForProject(p.id);
      expect(names).toEqual(["work"]);
    });

    it("attaches a tag to a session", async () => {
      const p = await backend.createProject({
        slug: "sesstag",
        displayName: "SessTag",
        rootPath: "/tmp/sesstag",
        encodedDir: "-tmp-sesstag",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      });
      const tagId = await backend.upsertTag("bug");
      expect(await backend.sessionHasTag(s.id, tagId)).toBe(false);
      await backend.addSessionTag(s.id, tagId);
      expect(await backend.sessionHasTag(s.id, tagId)).toBe(true);
      expect(await backend.listTagsForSession(s.id)).toEqual(["bug"]);
    });

    // -----------------------------------------------------------------------
    // Aliases
    // -----------------------------------------------------------------------

    it("adds, resolves, and removes an alias", async () => {
      const p = await backend.createProject({
        slug: "aliased",
        displayName: "Aliased",
        rootPath: "/tmp/aliased",
        encodedDir: "-tmp-aliased",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.addAlias("al", p.id);
      expect(await backend.resolveAlias("al")).toBe(p.id);
      expect(await backend.listAliasesForProject(p.id)).toEqual(["al"]);

      const byAlias = await backend.getProjectByAlias("al");
      expect(byAlias?.id).toBe(p.id);

      await backend.removeAlias("al");
      expect(await backend.resolveAlias("al")).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Links
    // -----------------------------------------------------------------------

    it("adds a cross-project link and lists it from both ends", async () => {
      const source = await backend.createProject({
        slug: "link-src",
        displayName: "Src",
        rootPath: "/tmp/link-src",
        encodedDir: "-tmp-link-src",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const target = await backend.createProject({
        slug: "link-tgt",
        displayName: "Tgt",
        rootPath: "/tmp/link-tgt",
        encodedDir: "-tmp-link-tgt",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: source.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      });

      await backend.addLink({
        sessionId: s.id,
        targetProjectId: target.id,
        linkType: "related",
        createdAt: 1000,
      });

      expect(await backend.linkExists(s.id, target.id)).toBe(true);
      const fromSession = await backend.listLinksForSession(s.id);
      expect(fromSession).toHaveLength(1);
      const toTarget = await backend.listLinksForProject(target.id);
      expect(toTarget).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // Compaction log
    // -----------------------------------------------------------------------

    it("appends a compaction log entry", async () => {
      const p = await backend.createProject({
        slug: "compact",
        displayName: "Compact",
        rootPath: "/tmp/compact",
        encodedDir: "-tmp-compact",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.appendCompactionLog({
        projectId: p.id,
        sessionId: null,
        trigger: "precompact",
        filesWritten: "notes.md",
        tokenCount: 4200,
        createdAt: 1000,
      });
      expect(await backend.countCompactionLogsForProject(p.id)).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Merge
    // -----------------------------------------------------------------------

    it("plans and applies a project merge, moving sessions and renumbering on collision", async () => {
      const into = await backend.createProject({
        slug: "into",
        displayName: "Into",
        rootPath: "/tmp/into",
        encodedDir: "-tmp-into",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const from = await backend.createProject({
        slug: "from",
        displayName: "From",
        rootPath: "/tmp/from",
        encodedDir: "-tmp-from",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.createSession({
        projectId: into.id,
        number: 1,
        date: "2026-09-22",
        slug: "into-1",
        title: "Into 1",
        filename: "0001.md",
        createdAt: 1000,
      });
      const fromSession = await backend.createSession({
        projectId: from.id,
        number: 1,
        date: "2026-09-22",
        slug: "from-1",
        title: "From 1",
        filename: "0001.md",
        createdAt: 1000,
      });

      const plan = await backend.planProjectMerge("from", "into");
      expect(plan.sessions).toEqual([{ id: fromSession.id, from: 1, to: 2 }]);

      await backend.applyProjectMerge(plan);

      expect(await backend.getProjectBySlug("from")).toBeNull();
      const moved = await backend.getSessionById(fromSession.id);
      expect(moved?.project_id).toBe(into.id);
      expect(moved?.number).toBe(2);
      expect(await backend.resolveAlias("from")).toBe(into.id);
    });

    // -----------------------------------------------------------------------
    // Projects — additional reads
    // -----------------------------------------------------------------------

    it("finds a project by encoded dir and by cwd prefix", async () => {
      const p = await backend.createProject({
        slug: "cwd",
        displayName: "Cwd",
        rootPath: "/tmp/cwd/proj",
        encodedDir: "-tmp-cwd-proj",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const byEncoded = await backend.getProjectByEncodedDir("-tmp-cwd-proj");
      expect(byEncoded?.id).toBe(p.id);

      const byCwd = await backend.findProjectByCwdPrefix("/tmp/cwd/proj/sub/dir");
      expect(byCwd?.id).toBe(p.id);
    });

    it("lists, filters, and orders projects", async () => {
      const a = await backend.createProject({
        slug: "list-a",
        displayName: "List A",
        rootPath: "/tmp/list-a",
        encodedDir: "-tmp-list-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.updateProjectStatus(a.id, "archived", { archivedAt: 2000, updatedAt: 2000 });
      const b = await backend.createProject({
        slug: "list-b",
        displayName: "List B",
        rootPath: "/tmp/list-b",
        encodedDir: "-tmp-list-b",
        createdAt: 3000,
        updatedAt: 3000,
      });

      const active = await backend.listProjects({ status: "active" });
      expect(active.some((p) => p.id === b.id)).toBe(true);
      expect(active.some((p) => p.id === a.id)).toBe(false);

      const excludingArchived = await backend.listProjects({ excludeArchived: true, orderBy: "slug" });
      expect(excludingArchived.some((p) => p.id === a.id)).toBe(false);

      const byId = await backend.listProjects({ orderBy: "id", limit: 100 });
      expect(byId.some((p) => p.id === a.id)).toBe(true);

      const byLength = await backend.listProjectsByPathLengthDesc({ excludeArchived: true });
      expect(byLength[0].root_path.length).toBeGreaterThanOrEqual(
        byLength[byLength.length - 1]?.root_path.length ?? 0
      );

      const tagId = await backend.upsertTag("listed");
      await backend.addProjectTag(b.id, tagId);
      const byTag = await backend.listProjects({ tagName: "listed" });
      expect(byTag.map((p) => p.id)).toEqual([b.id]);
    });

    it("lists named projects and finds matches via search", async () => {
      const p = await backend.createProject({
        slug: "named",
        displayName: "Named Project",
        rootPath: "/tmp/named",
        encodedDir: "-tmp-named",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.addAlias("named-alias", p.id);

      const named = await backend.listNamedProjects();
      const found = named.find((r) => r.id === p.id);
      expect(found?.name).toBe("named-alias");

      const withUnnamed = await backend.listNamedProjects({ includeUnnamed: true });
      expect(withUnnamed.some((r) => r.id === p.id)).toBe(true);

      const results = await backend.searchProjects("Named Project");
      expect(results.some((r) => r.id === p.id)).toBe(true);
    });

    it("counts projects, tracks most-recent update, and counts children", async () => {
      const before = await backend.countProjects({ status: "active" });
      const parent = await backend.createProject({
        slug: "parent",
        displayName: "Parent",
        rootPath: "/tmp/parent",
        encodedDir: "-tmp-parent",
        createdAt: 1000,
        updatedAt: 5000,
      });
      const child = await backend.createProject({
        slug: "child",
        displayName: "Child",
        rootPath: "/tmp/child",
        encodedDir: "-tmp-child",
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(await backend.countProjects({ status: "active" })).toBe(before + 2);
      expect(await backend.getMostRecentProjectUpdatedAt()).toBe(5000);

      await backend.updateProjectPath(child.id, {}, undefined);
      const reassigned = await backend.reassignProjectParent(999999, parent.id);
      expect(reassigned).toBe(0);
      expect(await backend.countChildProjects(parent.id)).toBe(0);
    });

    it("finds sibling projects by slug pattern", async () => {
      const base = await backend.createProject({
        slug: "sib",
        displayName: "Sib",
        rootPath: "/tmp/sib",
        encodedDir: "-tmp-sib",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const sibling = await backend.createProject({
        slug: "sib-1",
        displayName: "Sib 1",
        rootPath: "/tmp/sib-1",
        encodedDir: "-tmp-sib-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.createSession({
        projectId: sibling.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      });

      const siblings = await backend.findSiblingProjectsBySlugPattern(base.id, "sib");
      expect(siblings.some((s) => s.slug === "sib-1")).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Projects — additional writes
    // -----------------------------------------------------------------------

    it("createProjectWithSlugRetry retries on slug collision, dedupes on root_path", async () => {
      const first = await backend.createProjectWithSlugRetry({
        baseSlug: "retry",
        displayName: "Retry",
        rootPath: "/tmp/retry",
        encodedDir: "-tmp-retry",
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(first.created).toBe(true);
      expect(first.slug).toBe("retry");

      const second = await backend.createProjectWithSlugRetry({
        baseSlug: "retry",
        displayName: "Retry Two",
        rootPath: "/tmp/retry-two",
        encodedDir: "-tmp-retry-two",
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(second.created).toBe(true);
      expect(second.slug).toBe("retry-1");

      const dupe = await backend.createProjectWithSlugRetry({
        baseSlug: "retry",
        displayName: "Retry Dupe",
        rootPath: "/tmp/retry",
        encodedDir: "-tmp-retry-dupe",
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(dupe.created).toBe(false);
      expect(dupe.id).toBe(first.id);
    });

    it("updates every mutable project field", async () => {
      const p = await backend.createProject({
        slug: "fields",
        displayName: "Fields",
        rootPath: "/tmp/fields",
        encodedDir: "-tmp-fields",
        createdAt: 1000,
        updatedAt: 1000,
      });

      await backend.updateProjectPath(p.id, { rootPath: "/tmp/fields2", encodedDir: "-tmp-fields2" }, 2000);
      await backend.updateProjectDisplayName(p.id, "Fields Two", 2000);
      await backend.updateProjectType(p.id, "central", 2000);
      await backend.updateProjectSessionConfig(p.id, '{"a":1}', 2000);
      await backend.updateProjectClaudeNotesDir(p.id, "/tmp/notes", 2000);
      await backend.updateProjectObsidianLink(p.id, "obsidian://vault", 2000);
      await backend.updateProjectSlug(p.id, "fields-renamed", 2000);

      const row = await backend.getProjectById(p.id);
      expect(row?.root_path).toBe("/tmp/fields2");
      expect(row?.encoded_dir).toBe("-tmp-fields2");
      expect(row?.display_name).toBe("Fields Two");
      expect(row?.type).toBe("central");
      expect(row?.session_config).toBe('{"a":1}');
      expect(row?.claude_notes_dir).toBe("/tmp/notes");
      expect(row?.obsidian_link).toBe("obsidian://vault");
      expect(row?.slug).toBe("fields-renamed");
    });

    it("deletes a bare project row without cascading", async () => {
      const p = await backend.createProject({
        slug: "bare",
        displayName: "Bare",
        rootPath: "/tmp/bare",
        encodedDir: "-tmp-bare",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.deleteProject(p.id);
      expect(await backend.getProjectById(p.id)).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Tags — additional coverage
    // -----------------------------------------------------------------------

    it("lists, deletes, reassigns, and copies project tags", async () => {
      const a = await backend.createProject({
        slug: "tags-a",
        displayName: "Tags A",
        rootPath: "/tmp/tags-a",
        encodedDir: "-tmp-tags-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const b = await backend.createProject({
        slug: "tags-b",
        displayName: "Tags B",
        rootPath: "/tmp/tags-b",
        encodedDir: "-tmp-tags-b",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const tagId = await backend.upsertTag("copyme");
      await backend.addProjectTag(a.id, tagId);

      const all = await backend.listAllTags();
      expect(all.some((t) => t.id === tagId)).toBe(true);

      expect(await backend.listProjectTagIds(a.id)).toEqual([tagId]);
      expect(await backend.countProjectTagsForProject(a.id)).toBe(1);

      await backend.copyProjectTags(a.id, b.id);
      expect(await backend.countProjectTagsForProject(b.id)).toBe(1);

      await backend.deleteProjectTag(b.id, tagId);
      expect(await backend.countProjectTagsForProject(b.id)).toBe(0);

      const tagId2 = await backend.upsertTag("reassignme");
      await backend.addProjectTag(a.id, tagId2);
      await backend.reassignProjectTag(a.id, b.id, tagId2);
      expect(await backend.projectHasTag(b.id, tagId2)).toBe(true);
      expect(await backend.projectHasTag(a.id, tagId2)).toBe(false);

      await backend.deleteProjectTagsForProject(a.id);
      expect(await backend.countProjectTagsForProject(a.id)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Aliases — additional coverage
    // -----------------------------------------------------------------------

    it("counts, moves, reassigns aliases, and lists the alias map", async () => {
      const a = await backend.createProject({
        slug: "alias-a",
        displayName: "Alias A",
        rootPath: "/tmp/alias-a",
        encodedDir: "-tmp-alias-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const b = await backend.createProject({
        slug: "alias-b",
        displayName: "Alias B",
        rootPath: "/tmp/alias-b",
        encodedDir: "-tmp-alias-b",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.addAlias("a1", a.id);
      await backend.addAlias("a2", a.id);
      expect(await backend.countAliasesForProject(a.id)).toBe(2);

      await backend.moveProjectAliases(a.id, b.id);
      expect(await backend.countAliasesForProject(a.id)).toBe(0);
      expect(await backend.countAliasesForProject(b.id)).toBe(2);

      await backend.reassignAlias("a1", a.id);
      expect(await backend.resolveAlias("a1")).toBe(a.id);

      const map = await backend.listAliasMap();
      expect(map.some((m) => m.alias === "a1" && m.slug === "alias-a")).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Sessions — additional coverage
    // -----------------------------------------------------------------------

    it("lists sessions for a project with ordering/limit, and finds by filename", async () => {
      const p = await backend.createProject({
        slug: "list-sess",
        displayName: "List Sess",
        rootPath: "/tmp/list-sess",
        encodedDir: "-tmp-list-sess",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s1",
        title: "S1",
        filename: "0001.md",
        createdAt: 1000,
      });
      const s2 = await backend.createSession({
        projectId: p.id,
        number: 2,
        date: "2026-09-22",
        slug: "s2",
        title: "S2",
        filename: "0002.md",
        createdAt: 2000,
      });

      const byNumber = await backend.listSessionsForProject(p.id);
      expect(byNumber.map((s) => s.number)).toEqual([1, 2]);

      const byCreated = await backend.listSessionsForProject(p.id, { orderBy: "created_desc", limit: 1 });
      expect(byCreated).toHaveLength(1);
      expect(byCreated[0].id).toBe(s2.id);

      const found = await backend.findSessionByFilename(p.id, "0002.md");
      expect(found?.id).toBe(s2.id);
    });

    it("lists sessions across projects joined to their project, filtered by status", async () => {
      const p = await backend.createProject({
        slug: "cross-sess",
        displayName: "Cross Sess",
        rootPath: "/tmp/cross-sess",
        encodedDir: "-tmp-cross-sess",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        status: "open",
        filename: "0001.md",
        createdAt: 1000,
      });

      const open = await backend.listSessions({ projectId: p.id, status: "open" });
      expect(open).toHaveLength(1);
      expect(open[0].project_slug).toBe("cross-sess");
      expect(open[0].project_name).toBe("Cross Sess");
    });

    it("updates session meta, number, and filename", async () => {
      const p = await backend.createProject({
        slug: "sess-update",
        displayName: "Sess Update",
        rootPath: "/tmp/sess-update",
        encodedDir: "-tmp-sess-update",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "orig",
        title: "Orig",
        filename: "0001.md",
        createdAt: 1000,
      });

      await backend.updateSessionMeta(s.id, { slug: "renamed", title: "Renamed" });
      await backend.updateSessionNumber(s.id, 9, { filename: "0009.md" });
      await backend.updateSessionFilename(s.id, "0009-final.md");

      const row = await backend.getSessionById(s.id);
      expect(row?.slug).toBe("renamed");
      expect(row?.title).toBe("Renamed");
      expect(row?.number).toBe(9);
      expect(row?.filename).toBe("0009-final.md");
    });

    it("updates session status, with and without closed_at", async () => {
      const p = await backend.createProject({
        slug: "sess-status",
        displayName: "Sess Status",
        rootPath: "/tmp/sess-status",
        encodedDir: "-tmp-sess-status",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "orig",
        title: "Orig",
        filename: "0001.md",
        status: "open",
        createdAt: 1000,
      });

      await backend.updateSessionStatus(s.id, "compacted");
      let row = await backend.getSessionById(s.id);
      expect(row?.status).toBe("compacted");
      expect(row?.closed_at).toBeNull();

      await backend.updateSessionStatus(s.id, "completed", { closedAt: 2000 });
      row = await backend.getSessionById(s.id);
      expect(row?.status).toBe("completed");
      expect(row?.closed_at).toBe(2000);
    });

    it("tracks the most recent session date and creation time", async () => {
      const p = await backend.createProject({
        slug: "recent",
        displayName: "Recent",
        rootPath: "/tmp/recent",
        encodedDir: "-tmp-recent",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-20",
        slug: "s1",
        title: "S1",
        filename: "0001.md",
        createdAt: 1000,
      });
      await backend.createSession({
        projectId: p.id,
        number: 2,
        date: "2026-09-22",
        slug: "s2",
        title: "S2",
        filename: "0002.md",
        createdAt: 9000,
      });

      expect(await backend.getMostRecentSessionDate(p.id)).toBe("2026-09-22");
      expect(await backend.getMostRecentSessionCreatedAt()).toBeGreaterThanOrEqual(9000);
    });

    // -----------------------------------------------------------------------
    // Session tags — additional coverage
    // -----------------------------------------------------------------------

    it("lists, deletes, and reassigns session tags", async () => {
      const p = await backend.createProject({
        slug: "sesstag2",
        displayName: "SessTag2",
        rootPath: "/tmp/sesstag2",
        encodedDir: "-tmp-sesstag2",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s1 = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s1",
        title: "S1",
        filename: "0001.md",
        createdAt: 1000,
      });
      const s2 = await backend.createSession({
        projectId: p.id,
        number: 2,
        date: "2026-09-22",
        slug: "s2",
        title: "S2",
        filename: "0002.md",
        createdAt: 1000,
      });
      const tagId = await backend.upsertTag("st");
      await backend.addSessionTag(s1.id, tagId);
      expect(await backend.listSessionTagIds(s1.id)).toEqual([tagId]);

      await backend.reassignSessionTag(s1.id, s2.id, tagId);
      expect(await backend.sessionHasTag(s2.id, tagId)).toBe(true);
      expect(await backend.sessionHasTag(s1.id, tagId)).toBe(false);

      await backend.deleteSessionTag(s2.id, tagId);
      expect(await backend.sessionHasTag(s2.id, tagId)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Links — additional coverage
    // -----------------------------------------------------------------------

    it("deletes, retargets, moves, reassigns, and counts links", async () => {
      const source = await backend.createProject({
        slug: "link2-src",
        displayName: "Src2",
        rootPath: "/tmp/link2-src",
        encodedDir: "-tmp-link2-src",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const targetA = await backend.createProject({
        slug: "link2-a",
        displayName: "A",
        rootPath: "/tmp/link2-a",
        encodedDir: "-tmp-link2-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const targetB = await backend.createProject({
        slug: "link2-b",
        displayName: "B",
        rootPath: "/tmp/link2-b",
        encodedDir: "-tmp-link2-b",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s1 = await backend.createSession({
        projectId: source.id,
        number: 1,
        date: "2026-09-22",
        slug: "s1",
        title: "S1",
        filename: "0001.md",
        createdAt: 1000,
      });
      const s2 = await backend.createSession({
        projectId: source.id,
        number: 2,
        date: "2026-09-22",
        slug: "s2",
        title: "S2",
        filename: "0002.md",
        createdAt: 1000,
      });

      await backend.addLink({ sessionId: s1.id, targetProjectId: targetA.id, linkType: "related", createdAt: 1000 });
      await backend.addLink({ sessionId: s2.id, targetProjectId: targetA.id, linkType: "related", createdAt: 1000 });

      expect(await backend.countLinksForProject(targetA.id)).toBe(2);

      const [linkOfS1] = await backend.listLinksForSession(s1.id);
      await backend.retargetLink(linkOfS1.id, targetB.id);
      const afterRetarget = await backend.listLinksForSession(s1.id);
      expect(afterRetarget[0].target_project_id).toBe(targetB.id);

      await backend.moveLinkToSession(linkOfS1.id, s2.id);
      const onS2 = await backend.listLinksForSession(s2.id);
      expect(onS2.some((l) => l.id === linkOfS1.id)).toBe(true);

      // s2 already has a link targeting B (moved above), so the s2->A link is
      // left in place by the collision guard — "OR IGNORE" semantics, not a
      // full reassignment.
      await backend.reassignLinksTarget(targetA.id, targetB.id);
      expect(await backend.countLinksForProject(targetA.id)).toBe(1);

      await backend.deleteLinksTargetingProject(targetB.id);
      expect(await backend.countLinksForProject(targetB.id)).toBe(0);

      await backend.addLink({ sessionId: s1.id, targetProjectId: source.id, linkType: "related", createdAt: 1000 });
      await backend.deleteSelfLinksForProject(source.id);
      expect(await backend.countLinksForProject(source.id)).toBe(0);

      await backend.addLink({ sessionId: s1.id, targetProjectId: targetA.id, linkType: "related", createdAt: 1000 });
      await backend.deleteLinksFromProjectSessions(source.id);
      expect(await backend.countLinksForProject(targetA.id)).toBe(0);

      await backend.addLink({ sessionId: s1.id, targetProjectId: targetA.id, linkType: "related", createdAt: 1000 });
      const [freshLink] = await backend.listLinksForSession(s1.id);
      await backend.deleteLink(freshLink.id);
      expect(await backend.listLinksForSession(s1.id)).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Compaction log — additional coverage
    // -----------------------------------------------------------------------

    it("moves and deletes compaction log entries", async () => {
      const a = await backend.createProject({
        slug: "clog-a",
        displayName: "Clog A",
        rootPath: "/tmp/clog-a",
        encodedDir: "-tmp-clog-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const b = await backend.createProject({
        slug: "clog-b",
        displayName: "Clog B",
        rootPath: "/tmp/clog-b",
        encodedDir: "-tmp-clog-b",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: a.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      });
      await backend.appendCompactionLog({
        projectId: a.id,
        sessionId: s.id,
        trigger: "manual",
        filesWritten: "x.md",
        tokenCount: 100,
        createdAt: 1000,
      });

      const moved = await backend.moveCompactionLogsByProject(a.id, b.id);
      expect(moved).toBe(1);
      expect(await backend.countCompactionLogsForProject(b.id)).toBe(1);

      await backend.moveCompactionLogsBySession(s.id, s.id);
      await backend.deleteCompactionLogsForProject(b.id);
      expect(await backend.countCompactionLogsForProject(b.id)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Global counts / reset
    // -----------------------------------------------------------------------

    it("counts sessions across all projects", async () => {
      const a = await backend.createProject({
        slug: "count-a",
        displayName: "Count A",
        rootPath: "/tmp/count-a",
        encodedDir: "-tmp-count-a",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const b = await backend.createProject({
        slug: "count-b",
        displayName: "Count B",
        rootPath: "/tmp/count-b",
        encodedDir: "-tmp-count-b",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const before = await backend.countSessions();
      await backend.createSession({
        projectId: a.id,
        number: 1,
        date: "2026-09-22",
        slug: "s1",
        title: "S1",
        filename: "0001.md",
        createdAt: 1000,
      });
      await backend.createSession({
        projectId: b.id,
        number: 1,
        date: "2026-09-22",
        slug: "s2",
        title: "S2",
        filename: "0001.md",
        createdAt: 1000,
      });
      expect(await backend.countSessions()).toBe(before + 2);
    });

    it("resetRegistry clears every table, including global tags and session_tags", async () => {
      const p = await backend.createProject({
        slug: "reset-me",
        displayName: "Reset Me",
        rootPath: "/tmp/reset-me",
        encodedDir: "-tmp-reset-me",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const s = await backend.createSession({
        projectId: p.id,
        number: 1,
        date: "2026-09-22",
        slug: "s",
        title: "S",
        filename: "0001.md",
        createdAt: 1000,
      });
      const tagId = await backend.upsertTag("reset-tag");
      await backend.addProjectTag(p.id, tagId);
      await backend.addSessionTag(s.id, tagId);
      await backend.addAlias("reset-alias", p.id);
      await backend.appendCompactionLog({
        projectId: p.id,
        sessionId: s.id,
        trigger: "manual",
        filesWritten: "x.md",
        tokenCount: 10,
        createdAt: 1000,
      });

      await backend.resetRegistry();

      expect(await backend.countProjects()).toBe(0);
      expect(await backend.countSessions()).toBe(0);
      expect(await backend.listAllTags()).toEqual([]);
      expect(await backend.resolveAlias("reset-alias")).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Coverage gate — must be the LAST test: closes the backend, then checks
    // every RegistryBackend method was exercised at least once above.
    // -----------------------------------------------------------------------

    it("exercises every RegistryBackend method at least once (coverage gate)", async () => {
      await backend.close();
      const missing = ALL_REGISTRY_METHODS.filter((m) => !calledMethods.has(m));
      expect(missing).toEqual([]);
    });
  });
}
