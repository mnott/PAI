/**
 * pai hooks-db <sub-command>
 *
 * Backing implementation for the session-stop and pre-compact shell hooks
 * (src/hooks/session-stop.sh, src/hooks/pre-compact.sh). Each hook used to
 * shell out to the `sqlite3` CLI directly against the registry database; this
 * subcommand replaces those calls with one `pai` process that goes through
 * RegistryBackend, so hooks work against either SQLite or Postgres
 * (docs/design/postgres-only.md §6/§8, unit 8).
 *
 * Never throws to the caller's shell: exits 0 regardless of outcome — the
 * hooks already run detached/best-effort and must never block a session.
 *
 *   pai hooks-db session-stop <projectSlug>
 *   pai hooks-db pre-compact  <projectSlug>
 */

import type { Command } from "commander";
import { getRegistryBackend } from "../../storage/factory.js";
import type { RegistryBackend, Session } from "../../storage/registry-interface.js";

// ---------------------------------------------------------------------------
// Shared lookup
// ---------------------------------------------------------------------------

/** Latest session for the project whose status is one of `statuses`, newest created_at first — mirrors the old `ORDER BY created_at DESC LIMIT 1` SQL. */
async function findLatestSessionByStatus(
  backend: RegistryBackend,
  projectId: number,
  statuses: Session["status"][]
): Promise<Session | null> {
  const sessions = await backend.listSessionsForProject(projectId, { orderBy: "created_desc" });
  return sessions.find((s) => statuses.includes(s.status)) ?? null;
}

// ---------------------------------------------------------------------------
// session-stop: mark the latest open/compacted session completed
// ---------------------------------------------------------------------------

export async function runSessionStopHook(backend: RegistryBackend, projectSlug: string): Promise<void> {
  const project = await backend.getProjectBySlug(projectSlug);
  if (!project) return;

  const session = await findLatestSessionByStatus(backend, project.id, ["open", "compacted"]);
  if (!session) return;

  await backend.updateSessionStatus(session.id, "completed", { closedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// pre-compact: mark the latest open session compacted, log the event
// ---------------------------------------------------------------------------

export async function runPreCompactHook(backend: RegistryBackend, projectSlug: string): Promise<void> {
  const project = await backend.getProjectBySlug(projectSlug);
  if (!project) return;

  const session = await findLatestSessionByStatus(backend, project.id, ["open"]);
  if (session) {
    await backend.updateSessionStatus(session.id, "compacted");
  }

  await backend.appendCompactionLog({
    projectId: project.id,
    sessionId: session ? session.id : null,
    trigger: "precompact",
    filesWritten: "",
    tokenCount: null,
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerHooksDbCommands(hooksDbCmd: Command): void {
  hooksDbCmd
    .command("session-stop <projectSlug>")
    .description("Internal: session-stop hook registry update (called by src/hooks/session-stop.sh)")
    .action(async (projectSlug: string) => {
      try {
        const backend = await getRegistryBackend();
        await runSessionStopHook(backend, projectSlug);
      } catch {
        // never surface a failure to the calling hook script
      }
    });

  hooksDbCmd
    .command("pre-compact <projectSlug>")
    .description("Internal: pre-compact hook registry update (called by src/hooks/pre-compact.sh)")
    .action(async (projectSlug: string) => {
      try {
        const backend = await getRegistryBackend();
        await runPreCompactHook(backend, projectSlug);
      } catch {
        // never surface a failure to the calling hook script
      }
    });
}
