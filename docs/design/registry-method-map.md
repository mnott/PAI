# Registry method map — unit 3 → unit 5

`RegistryBackend` (`src/storage/registry-interface.ts`) enumerates every distinct
registry query used by the 64 caller files inventoried in `postgres-only.md` §1e.
This table is the mechanical checklist for unit 5: for each file, the methods it
will call once its `db.prepare(...)` calls are replaced with
`await registryBackend.method(...)`.

Method naming matches `registry-interface.ts` exactly. A file listed with
"(no direct registry access)" either takes an already-resolved row as a
parameter or only touches `federation.db` — out of scope for the registry
conversion.

## Method list (82 methods)

**Projects — reads:** `getProjectById`, `getProjectBySlug`, `getProjectByAlias`,
`getProjectByRootPath`, `getProjectByEncodedDir`, `findProjectByCwdPrefix`,
`listProjects`, `listProjectsByPathLengthDesc`, `listProjectsWithSessionStats`,
`listNamedProjects`, `searchProjects`, `countProjects`,
`getMostRecentProjectUpdatedAt`, `countChildProjects`,
`findSiblingProjectsBySlugPattern`

**Projects — writes:** `createProject`, `createProjectWithSlugRetry`,
`updateProjectPath`, `updateProjectStatus`, `updateProjectDisplayName`,
`updateProjectType`, `updateProjectSessionConfig`, `updateProjectClaudeNotesDir`,
`updateProjectObsidianLink`, `updateProjectSlug`, `reassignProjectParent`,
`deleteProject`, `deleteProjectCascade`

**Tags:** `listTagsForProject`, `listAllTags`, `upsertTag`, `addProjectTag`,
`projectHasTag`, `deleteProjectTag`, `reassignProjectTag`, `listProjectTagIds`,
`countProjectTagsForProject`, `copyProjectTags`, `deleteProjectTagsForProject`

**Aliases:** `resolveAlias`, `listAliasesForProject`, `addAlias`, `removeAlias`,
`countAliasesForProject`, `moveProjectAliases`, `reassignAlias`, `listAliasMap`

**Sessions:** `getSessionById`, `getSessionByNumber`, `getLatestSessionForProject`,
`getMaxSessionNumber`, `listSessionsForProject`, `listSessions`,
`findSessionByFilename`, `sessionNumberTaken`, `createSession`,
`upsertSessionIfAbsent`, `updateSessionMeta`, `updateSessionNumber`,
`updateSessionFilename`, `moveSessionToProject`, `deleteSession`,
`backfillFoldedSession`, `countSessionsForProject`, `getMostRecentSessionDate`,
`getMostRecentSessionCreatedAt`

**Session tags:** `listSessionTagIds`, `sessionHasTag`, `addSessionTag`,
`deleteSessionTag`, `reassignSessionTag`, `listTagsForSession`

**Links:** `addLink`, `listLinksForSession`, `listLinksForProject`, `linkExists`,
`deleteLink`, `deleteLinksTargetingProject`, `deleteLinksFromProjectSessions`,
`retargetLink`, `moveLinkToSession`, `reassignLinksTarget`,
`countLinksForProject`, `deleteSelfLinksForProject`

**Compaction log:** `appendCompactionLog`, `countCompactionLogsForProject`,
`moveCompactionLogsByProject`, `moveCompactionLogsBySession`,
`deleteCompactionLogsForProject`

**Merge:** `planProjectMerge`, `applyProjectMerge` (wrap `src/registry/merge.ts`
unchanged)

## Per-caller mapping

### CLI project commands

| File | Methods |
|---|---|
| `src/cli/commands/project/index.ts` | (no direct registry access) |
| `src/cli/commands/project/commands.ts` | `getProjectBySlug`(conflict check), `listProjects`, `createProject`, `listProjectsWithSessionStats`, `countProjects`, `listSessionsForProject`, `updateProjectStatus`, `updateProjectPath`, `projectHasTag`, `addProjectTag`, `getProjectBySlug`(alias conflict), `addAlias`, `updateProjectDisplayName`, `updateProjectType`, `getProjectByEncodedDir` |
| `src/cli/commands/project/here.ts` | `listProjects`, `getProjectByEncodedDir`, `updateProjectPath`, `getProjectBySlug`, `createProject` |
| `src/cli/commands/project/helpers.ts` | `getProjectBySlug`, `getProjectByAlias`, `listProjects`, `listTagsForProject`, `listAliasesForProject`, `countSessionsForProject`, `getMostRecentSessionDate`, `upsertTag` |
| `src/cli/commands/project/health.ts` | `listProjectsWithSessionStats`, `updateProjectPath`, `updateProjectStatus` |
| `src/cli/commands/project/merge.ts` | `planProjectMerge`, `getProjectById`, `applyProjectMerge` |
| `src/cli/commands/project/unregister.ts` | `getProjectBySlug`+`countSessionsForProject` (or a dedicated read), `deleteProjectCascade` |
| `src/cli/commands/project/projects-index.ts` | delegates to `main-resolver.ts`/`helpers.ts`; direct: `updateProjectPath` |
| `src/cli/commands/project/session-config.ts` | `updateProjectSessionConfig`, `getProjectBySlug`(conflict), `resolveAlias`, `addAlias`, `removeAlias`, `countAliasesForProject`, `listNamedProjects` |
| `src/cli/commands/main-resolver.ts` | `listProjectsWithSessionStats` |
| `src/cli/commands/pick.ts` | `listProjectsWithSessionStats`, `updateProjectStatus` (resolve slug→id first) |
| `src/cli/commands/detect.ts` | `listProjectsByPathLengthDesc`, `countSessionsForProject`+`getMostRecentSessionDate` (or new combined read) |

### CLI session commands

| File | Methods |
|---|---|
| `src/cli/commands/session/index.ts` | (no direct registry access) |
| `src/cli/commands/session/commands.ts` | `listSessions`, `updateSessionMeta`, `sessionHasTag`, `addSessionTag`, `getProjectBySlug`, `addLink`, `getProjectByEncodedDir` |
| `src/cli/commands/session/autosave.ts` | `getLatestSessionForProject` |
| `src/cli/commands/session/pause.ts` | `findProjectByCwdPrefix`, `getLatestSessionForProject`, `findSiblingProjectsBySlugPattern` |
| `src/cli/commands/session/handover.ts` | `getProjectBySlug`, `getLatestSessionForProject`, `getSessionByNumber` |
| `src/cli/commands/session/goto.ts` | via `session-scan.ts`: `listProjects` |
| `src/cli/commands/session/end.ts` | `findProjectByCwdPrefix` |
| `src/cli/commands/session/helpers.ts` | `getProjectBySlug`, `getLatestSessionForProject`, `getSessionByNumber`, `upsertTag`, `listTagsForSession` |
| `src/cli/commands/session/sessions-index.ts` | (no direct registry access) |
| `src/cli/commands/session-cleanup/index.ts` | via `scanner.ts`: `getProjectBySlug`, `listProjects` |
| `src/cli/commands/session-cleanup/scanner.ts` | `listProjects`, `getProjectBySlug`, `listSessionsForProject` |
| `src/cli/commands/session-cleanup/executor.ts` | `deleteSession`, `updateSessionMeta`, `updateSessionNumber`, `updateSessionFilename` |
| `src/cli/lib/session-scan.ts` | `listProjects` |
| `src/cli/lib/dedup-sessions.ts` | (no direct registry access) |

### CLI registry commands + registry/merge.ts + registry/migrate.ts

| File | Methods |
|---|---|
| `src/cli/commands/registry/index.ts` | `countProjects`, `countSessionsForProject`(overall — new use of general count with no filter is `SELECT COUNT(*) FROM sessions`, map to a plain count call), `listAllTags`(count), `getMostRecentProjectUpdatedAt`, `getMostRecentSessionCreatedAt`, full wipe (`db.exec` of 8 DELETEs — stays a raw backend-level `resetRegistry()` composite if unit 5 needs it, not yet in the interface — flag for unit 5), `getProjectByRootPath` |
| `src/cli/commands/registry/scan.ts` | `updateProjectClaudeNotesDir`, `listProjects`, `getProjectByRootPath`, `getProjectBySlug`, `getProjectByEncodedDir`, `updateProjectPath`, `listProjects`(display_name=slug legacy — filter client-side), `updateProjectDisplayName`; plus `createProjectWithSlugRetry`/`upsertProjectByPath`-shaped calls via `utils.ts` |
| `src/cli/commands/registry/reconnect.ts` | `listProjectsWithSessionStats`, `updateProjectPath`(encoded_dir only) |
| `src/cli/commands/registry/dedupe.ts` | `countSessionsForProject`, `countCompactionLogsForProject`, `countAliasesForProject`, `countLinksForProject`, `countProjectTagsForProject`, `countChildProjects`, `listProjects`(all columns, order id), `listSessionTagIds`, `sessionHasTag`, `deleteSessionTag`, `reassignSessionTag`, `listLinksForSession`, `linkExists`, `deleteLink`, `moveLinkToSession`, `moveCompactionLogsBySession`, `backfillFoldedSession`, `deleteSession`, `getMaxSessionNumber`, `listSessionsForProject`, `findSessionByFilename`, `sessionNumberTaken`, `moveSessionToProject`, `moveCompactionLogsByProject`, `listAliasesForProject`, `resolveAlias`, `reassignAlias`, `listLinksForProject`, `deleteLink`, `retargetLink`, `listProjectTagIds`, `projectHasTag`, `deleteProjectTag`, `reassignProjectTag`, `reassignProjectParent`, `updateProjectClaudeNotesDir`, `updateProjectSessionConfig`, `deleteProject`, `updateProjectStatus`, `getProjectBySlug`(candidate check), `updateProjectSlug`, `getProjectByRootPath`, `updateProjectPath`, `listProjects` |
| `src/cli/commands/registry/migrate.ts` | via `utils.ts` upsert helpers |
| `src/cli/commands/registry/utils.ts` | `getProjectByEncodedDir`, `getProjectByRootPath`, `updateProjectPath`, `createProjectWithSlugRetry`, `getSessionByNumber`(existence via `sessionNumberTaken`), `createSession` |
| `src/registry/merge.ts` | internals of `planProjectMerge`/`applyProjectMerge` — not converted; called by `registry-sqlite.ts` directly |
| `src/registry/migrate.ts` | `createProjectWithSlugRetry`(slug-retry insert), `getProjectBySlug`, `getProjectByRootPath`, `upsertSessionIfAbsent` |

### CLI memory/obsidian/backup/config

| File | Methods |
|---|---|
| `src/cli/commands/memory/stats.ts` | `getProjectBySlug`, `getProjectById`(batch — loop or new `getProjectsByIds`, flag for unit 5) |
| `src/cli/commands/memory/search.ts` | `getProjectBySlug` |
| `src/cli/commands/memory/index-cmd.ts` | `getProjectBySlug`(status filter via opts) |
| `src/cli/commands/memory/embed.ts` | `getProjectBySlug` |
| `src/cli/commands/backup.ts` | (no direct registry access) |
| `src/cli/commands/restore.ts` | (no direct registry access) |
| `src/cli/commands/config.ts` | (no direct registry access) |
| `src/cli/commands/obsidian.ts` | (no direct registry access — delegates) |
| `src/obsidian/sync/generate.ts` | `listProjectsWithSessionStats`, `listTagsForProject`, `listAllTags`, `listProjectsWithSessionStats`(tagId) |
| `src/obsidian/sync/master.ts` | `listProjects`(status active, order slug) ×2 |
| `src/obsidian/sync/symlinks.ts` | `listProjects`(order status,slug), `updateProjectObsidianLink` |
| `src/obsidian/status.ts` | `listProjects`(status active) |
| `src/obsidian/vault-fixer.ts` | (no direct registry access — federation.db only) |

### MCP tools

| File | Methods |
|---|---|
| `src/mcp/tools/registry.ts` | `searchProjects` |
| `src/mcp/tools/projects.ts` | `getProjectById`, `listProjects`(status/tag/limit), `listProjectsWithSessionStats` |
| `src/mcp/tools/sessions.ts` | `listSessions`(projectId/status/limit, no join needed — trim columns client-side) |
| `src/mcp/tools/wakeup.ts` | `getProjectBySlug` |
| `src/mcp/tools/types.ts` | `getProjectBySlug`(id lookup), `resolveAlias`, `getProjectByRootPath`, `listProjectsByPathLengthDesc`, `countSessionsForProject`, `getMostRecentSessionDate`, `listTagsForProject`, `listAliasesForProject` |

### Daemon

| File | Methods |
|---|---|
| `src/daemon/daemon/dispatcher.ts` | (no direct registry access) |
| `src/daemon/daemon/handler.ts` | `countProjects`, `findProjectByCwdPrefix`, `getProjectBySlug` |
| `src/daemon/daemon/scheduler.ts` | `getProjectByRootPath`, `listProjects`(status active) |
| `src/daemon/daemon/server.ts` | `openRegistry`/`getRegistryBackend` only (no table queries) |
| `src/daemon/daemon/state.ts` | `openRegistry`/`getRegistryBackend` only |
| `src/daemon/daemon/types.ts` | (no direct registry access) |
| `src/daemon/session-summary-worker.ts` | `getProjectBySlug` |

### Session/task/topic routing + workers

| File | Methods |
|---|---|
| `src/session/auto-route.ts` | `getProjectBySlug`(status filter) ×2 |
| `src/session/promote.ts` | `getProjectBySlug`+`getProjectByRootPath`+`getProjectByEncodedDir`(conflict check), `createProject` |
| `src/tasks/resolver.ts` | `listAliasMap` |
| `src/topics/detector.ts` | (no direct registry access — takes `StorageBackend`) |
| `src/workers/project-config.ts` | `listProjectsByPathLengthDesc`(excludeArchived) |

## Gaps found during mapping (flag for unit 5, not fixed here)

- `registry/index.ts`'s full-wipe (`db.exec` of 8 `DELETE`s for `pai registry
  rebuild`) has no single interface method yet — it is a rare, deliberately
  destructive whole-table operation and does not belong next to the granular
  CRUD methods above. Unit 5 should add one explicit `resetRegistry()` method
  when it converts that file, not before.
- `memory/stats.ts`'s batch "project ids → slugs" lookup (`WHERE id IN (...)`)
  is not in the interface; unit 5 can loop `getProjectById` (small N — global
  stats span a handful of projects) or add a batch method if profiling shows
  it matters.
- `unregister.ts` and `dedupe.ts` currently read `session_count` via a
  correlated subquery in the same `SELECT`; the mapping above splits that into
  a separate `countSessionsForProject` call. Behaviourally identical, one more
  round trip per call site.
