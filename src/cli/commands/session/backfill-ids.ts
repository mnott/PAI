/**
 * pai session backfill-ids — write `sessions: [...]` into the frontmatter of existing session notes.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectsDir } from "../../../config/pai-home.js";
import { backfillProjectDir, type BackfillReport } from "../../../session/note-sessions-backfill.js";

/** Claude Code's directory name for a cwd: every non-alphanumeric character becomes "-". */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export async function cmdBackfillIds(opts: { dryRun?: boolean; all?: boolean; dir?: string; projectsDir?: string }): Promise<void> {
  const root = opts.projectsDir ?? claudeProjectsDir();
  const cwd = opts.dir ?? process.cwd();
  const dirs = opts.all ? readdirSync(root) : [encodeCwd(cwd)];
  const total: BackfillReport = { notes: 0, mapped: 0, ambiguous: 0, none: 0, already: 0, plan: [] };
  for (const d of dirs) {
    const r = await backfillProjectDir(join(root, d), opts.dryRun === true, [join(root, d, "Notes"), ...(opts.all ? [] : [join(cwd, "Notes")])]);
    for (const k of ["notes", "mapped", "ambiguous", "none", "already"] as const) total[k] += r[k];
    total.plan.push(...r.plan);
  }
  const verb = opts.dryRun ? "would map" : "mapped";
  console.log(`notes ${total.notes}: ${verb} ${total.mapped}, ambiguous ${total.ambiguous}, none ${total.none}, already had ids ${total.already}`);
  if (opts.dryRun) for (const p of total.plan.slice(0, 20)) console.log(`  ${p.note.split("/").pop()} -> ${p.ids.map((i) => i.slice(0, 8)).join(", ")}`);
}
