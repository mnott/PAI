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

/** Which registry row to move: a Claude id prefix, a bare row id (all digits), or a project slug + note number. */
export type MoveSelector = string | { project: string; number: number };

type SessionRow = Awaited<ReturnType<RegistryBackend["listSessions"]>>[number];

async function findSession(backend: RegistryBackend, sel: MoveSelector): Promise<SessionRow> {
  const all = await backend.listSessions({ limit: 1_000_000 });
  if (typeof sel !== "string") {
    const slug = sel.project.toLowerCase();
    const hits = all.filter((s) => s.project_slug.toLowerCase() === slug && s.number === sel.number);
    if (hits.length === 0) throw new Error(`No session #${sel.number} in project ${sel.project}`);
    if (hits.length > 1) throw new Error(`Session #${sel.number} in ${sel.project} is ambiguous (${hits.length} rows, ids ${hits.map((h) => h.id).join(", ")})`);
    return hits[0];
  }
  const p = sel.toLowerCase();
  if (!p) throw new Error("session id is required");
  if (/^\d+$/.test(p)) {
    const row = all.find((s) => s.id === Number(p));
    if (row) return row;
  }
  const matches = all.filter((s) => s.claude_session_id?.toLowerCase().startsWith(p));
  if (matches.length === 0) throw new Error(`No session matches "${sel}"`);
  if (matches.length > 1) {
    const lines = matches.map((s) => `  ${s.claude_session_id!.slice(0, 8)}  ${s.project_slug}  "${s.title}"`);
    throw new Error(`Ambiguous session prefix "${sel}" — ${matches.length} candidates:\n${lines.join("\n")}`);
  }
  return matches[0];
}

/** Move one registry session to project `toSlug`. Throws on no/ambiguous match. */
export async function moveSession(
  backend: RegistryBackend,
  selector: MoveSelector,
  toSlug: string,
  dryRun = false
): Promise<MoveResult> {
  const s = await findSession(backend, selector);

  const target =
    (await backend.getProjectBySlug(toSlug)) ??
    (await backend.getProjectBySlug(toSlug, { caseInsensitive: true })) ??
    (await backend.getProjectByAlias(toSlug, { caseInsensitive: true }));
  if (!target) throw new Error(`Project not found: ${toSlug}`);
  if (target.id === s.project_id) throw new Error(`Session already belongs to ${target.slug}`);

  const number = (await backend.getMaxSessionNumber(target.id)) + 1;
  if (!dryRun) await backend.moveSessionToProject(s.id, target.id, { number });

  return { id8: s.claude_session_id ? s.claude_session_id.slice(0, 8) : `#${s.number}`, title: s.title, from: s.project_slug, to: target.slug, number };
}

export async function cmdMove(opts: { id?: string; project?: string; number?: number; numbers?: string; to?: string; dryRun?: boolean }): Promise<void> {
  if (!opts.to) throw new Error("--to <project-slug> is required");
  const backend = await getRegistryBackend();
  const selectors: MoveSelector[] = [];
  if (opts.numbers !== undefined || opts.number !== undefined) {
    if (!opts.project) throw new Error("--project <slug> is required with --number/--numbers");
    const list = opts.numbers !== undefined ? opts.numbers.split(",").map((x) => x.trim()).filter(Boolean) : [String(opts.number)];
    for (const x of list) {
      if (!/^\d+$/.test(x)) throw new Error(`Not a session number: "${x}"`);
      selectors.push({ project: opts.project, number: Number(x) });
    }
    if (selectors.length === 0) throw new Error("--numbers is empty");
  } else {
    if (!opts.id) throw new Error("SESSION_ID, or --project with --number/--numbers, is required");
    selectors.push(opts.id);
  }
  let failed = 0;
  for (const sel of selectors) {
    try {
      const r = await moveSession(backend, sel, opts.to, opts.dryRun);
      const line = `moved ${r.id8} "${r.title}" from ${r.from} to ${r.to} as #${r.number}`;
      console.log(opts.dryRun ? dim(`(dry run) would have ${line}`) : ok(line));
    } catch (e) {
      failed++;
      console.error(`failed ${typeof sel === "string" ? sel : `${sel.project} #${sel.number}`}: ${(e as Error).message}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${selectors.length} moves failed`);
}
