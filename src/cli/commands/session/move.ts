/**
 * pai session move — reattribute one registry session to another project.
 */

import { getRegistryBackend } from "../../../storage/factory.js";
import type { RegistryBackend } from "../../../storage/registry-interface.js";
import { ok, dim } from "../../lib/utils.js";

export interface MoveResult {
  id8: string;
  title: string;
  from: string;
  to: string;
  number: number;
}

/** Move the session whose Claude id starts with `prefix` to project `toSlug`. Throws on no/ambiguous match. */
export async function moveSession(
  backend: RegistryBackend,
  prefix: string,
  toSlug: string,
  dryRun = false
): Promise<MoveResult> {
  const p = prefix.toLowerCase();
  if (!p) throw new Error("session id is required");

  const all = await backend.listSessions({ limit: 1_000_000 });
  const matches = all.filter((s) => s.claude_session_id?.toLowerCase().startsWith(p));
  if (matches.length === 0) throw new Error(`No session matches "${prefix}"`);
  if (matches.length > 1) {
    const lines = matches.map((s) => `  ${s.claude_session_id!.slice(0, 8)}  ${s.project_slug}  "${s.title}"`);
    throw new Error(`Ambiguous session prefix "${prefix}" — ${matches.length} candidates:\n${lines.join("\n")}`);
  }
  const s = matches[0];

  const target =
    (await backend.getProjectBySlug(toSlug)) ??
    (await backend.getProjectBySlug(toSlug, { caseInsensitive: true })) ??
    (await backend.getProjectByAlias(toSlug, { caseInsensitive: true }));
  if (!target) throw new Error(`Project not found: ${toSlug}`);
  if (target.id === s.project_id) throw new Error(`Session already belongs to ${target.slug}`);

  const number = (await backend.getMaxSessionNumber(target.id)) + 1;
  if (!dryRun) await backend.moveSessionToProject(s.id, target.id, { number });

  return { id8: s.claude_session_id!.slice(0, 8), title: s.title, from: s.project_slug, to: target.slug, number };
}

export async function cmdMove(opts: { id: string; to?: string; dryRun?: boolean }): Promise<void> {
  if (!opts.to) throw new Error("--to <project-slug> is required");
  const r = await moveSession(await getRegistryBackend(), opts.id, opts.to, opts.dryRun);
  const line = `moved ${r.id8} "${r.title}" from ${r.from} to ${r.to}`;
  console.log(opts.dryRun ? dim(`(dry run) would have ${line}`) : ok(line));
}
