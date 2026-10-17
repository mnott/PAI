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

import { getRegistryBackend } from "../../storage/factory.js";
import type { RegistryBackend, Session } from "../../storage/registry-interface.js";
import type { CommandDef } from "../define.js";

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
// Command
// ---------------------------------------------------------------------------

async function hook(run: (backend: RegistryBackend, slug: string) => Promise<void>, slug: string): Promise<number> {
  try {
    await run(await getRegistryBackend(), slug);
  } catch {
    // never surface a failure to the calling hook script
  }
  return 0;
}

export const hooksDbCommand: CommandDef = {
  name: "hooks-db",
  summary: "Registry updates for the stop and pre-compact hooks",
  description:
    "Called by the shell hooks, not by hand. Marks the latest session of a project completed (session-stop) or compacted (pre-compact). Always exits 0 so a hook can never block a session.",
  examples: ["pai hooks-db session-stop my-project", "pai hooks-db pre-compact my-project"],
  seeAlso: ["pai session handover"],
  subcommands: [
    {
      name: "session-stop",
      summary: "Mark the project's latest session completed",
      description: "Used by the stop hook. Exits 0 whatever happens.",
      args: [{ name: "PROJECT_SLUG", required: true, summary: "Project slug" }],
      examples: ["pai hooks-db session-stop my-project", "pai hooks-db session-stop \"$PROJECT_SLUG\""],
      run: (c) => hook(runSessionStopHook, c.args.PROJECT_SLUG as string),
    },
    {
      name: "pre-compact",
      summary: "Mark the project's open session compacted and log it",
      description: "Used by the pre-compact hook. Exits 0 whatever happens.",
      args: [{ name: "PROJECT_SLUG", required: true, summary: "Project slug" }],
      examples: ["pai hooks-db pre-compact my-project", "pai hooks-db pre-compact \"$PROJECT_SLUG\""],
      run: (c) => hook(runPreCompactHook, c.args.PROJECT_SLUG as string),
    },
  ],
};
