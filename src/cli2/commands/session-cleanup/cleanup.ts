/**
 * `pai session cleanup`: delete empty session notes, name unnamed ones, move
 * them into YYYY/MM/ folders and renumber. Dry run unless `execute` is set.
 */

import { err, dim, ok, header } from "../../lib/utils.js";
import { getAllProjects, getProject, analyzeProject } from "./scanner.js";
import { displayDryRun, executeCleanup } from "./executor.js";

export async function runCleanup(
  projectSlug: string | undefined,
  opts: { execute?: boolean; renumber?: boolean; reindex?: boolean }
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const dryRun = !opts.execute;
  const skipReindex = opts.reindex === false;

  let projects;
  if (projectSlug) {
    const p = await getProject(registryBackend, projectSlug);
    if (!p) {
      console.error(err(`Project not found: ${projectSlug}`));
      process.exitCode = 1;
      return;
    }
    projects = [p];
  } else {
    projects = await getAllProjects(registryBackend);
  }

  console.log();
  console.log(
    header(
      dryRun
        ? "  pai session cleanup — DRY RUN (no changes will be made)"
        : "  pai session cleanup — EXECUTING"
    )
  );
  console.log(dim(`  Analyzing ${projects.length} project(s)...`));

  const plans = [];
  for (const project of projects) {
    const plan = await analyzeProject(registryBackend, project);
    if (plan) plans.push(plan);
  }

  const activePlans = plans.filter(
    (p) =>
      p.notesDirs.some((d) => d.toDelete.length > 0 || d.toRename.length > 0 || d.toMove.length > 0) ||
      p.renumberMap.size > 0
  );

  if (activePlans.length === 0) {
    console.log();
    console.log(ok("  Nothing to do — all session notes are clean!"));
    console.log();
    return;
  }

  if (dryRun) {
    await displayDryRun(activePlans);
  } else {
    await executeCleanup(activePlans, skipReindex);
  }
}
