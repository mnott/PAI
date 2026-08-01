/**
 * projects.ts — reconcile sessions against the tracker projects that address them.
 *
 * A session can only be given work from a phone if something in the tracker
 * names it. That mapping drifts constantly and invisibly: sessions get renamed,
 * new ones appear, old ones stop being used, and nothing anywhere says "these
 * five can receive work and these thirteen cannot". The failure is silent in the
 * worst direction — filing a task for a session with no project looks exactly
 * like filing one that will be picked up.
 *
 * So this reports the mapping in both directions rather than just listing what
 * exists: sessions with no project (cannot be addressed) and projects with no
 * session (will queue until one launches, which is legitimate and worth
 * distinguishing from a mistake).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SessionEntry {
  name: string;
  directory: string;
}

export interface ProjectEntry {
  id: string;
  name: string;
}

export type MappingState = "mapped" | "session-only" | "project-only";

export interface MappingRow {
  name: string;
  state: MappingState;
  directory?: string;
  projectId?: string;
}

/**
 * Read the session manifest from AIBroker.
 *
 * The manifest rather than a live enumeration, deliberately: it is the set of
 * sessions the user actually works with, which is the right unit for "should
 * this have an inbox". A live list would drop everything not open at this
 * instant and churn a permanent decision on a transient signal.
 *
 * Returns an empty list when AIBroker is absent — this command degrades to
 * "here are your tracker projects" rather than failing, in keeping with the
 * rest of the bus being optional.
 */
export async function readSessionManifest(bin = "aibroker"): Promise<SessionEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(bin, ["sessions", "list"], { timeout: 20_000 }));
  } catch {
    return [];
  }

  const entries: SessionEntry[] = [];
  for (const line of stdout.split("\n")) {
    // Manifest rows are indented "  Name<spaces>/absolute/path". Anything
    // without a leading absolute path is a header or a log line.
    const m = line.match(/^\s{2}(\S.*?)\s{2,}(\/.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    const directory = m[2].trim();
    if (!name || !directory) continue;
    entries.push({ name, directory });
  }
  return entries;
}

/** Compare names the way a person scanning two lists would. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Join sessions and tracker projects into one ordered view.
 *
 * Sorted mapped-first then by name, so the actionable rows — sessions that
 * cannot yet be addressed — sit together rather than scattered through a list
 * of things that already work.
 */
export function reconcile(
  sessions: SessionEntry[],
  projects: ProjectEntry[]
): MappingRow[] {
  const byName = new Map<string, ProjectEntry>();
  for (const p of projects) byName.set(normalizeName(p.name), p);

  const seen = new Set<string>();
  const rows: MappingRow[] = [];

  for (const s of sessions) {
    const key = normalizeName(s.name);
    const project = byName.get(key);
    if (project) seen.add(key);
    rows.push({
      name: s.name,
      state: project ? "mapped" : "session-only",
      directory: s.directory,
      projectId: project?.id,
    });
  }

  for (const p of projects) {
    const key = normalizeName(p.name);
    if (seen.has(key)) continue;
    rows.push({ name: p.name, state: "project-only", projectId: p.id });
  }

  const rank: Record<MappingState, number> = {
    mapped: 0,
    "session-only": 1,
    "project-only": 2,
  };
  return rows.sort(
    (a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name)
  );
}
