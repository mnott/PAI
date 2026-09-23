/**
 * Commander registration for `pai session cleanup`.
 */

import type { Command } from "commander";
import { err, dim, ok, header } from "../../utils.js";
import { getAllProjects, getProject, analyzeProject } from "./scanner.js";
import { displayDryRun, executeCleanup } from "./executor.js";

export function registerSessionCleanupCommand(sessionCmd: Command): void {
  sessionCmd
    .command("cleanup [project-slug]")
    .description(
      "Clean up session notes: delete empties, auto-name unnamed, move into YYYY/MM/ hierarchy, renumber"
    )
    .option("--execute", "Actually perform the cleanup (default is dry-run)")
    .option("--no-renumber", "Skip renumbering sessions after deletions")
    .option("--no-reindex", "Skip triggering memory re-index after moves")
    .action(
      async (
        projectSlug: string | undefined,
        opts: { execute?: boolean; renumber?: boolean; reindex?: boolean }
      ) => {
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
            p.notesDirs.some(
              (d) =>
                d.toDelete.length > 0 ||
                d.toRename.length > 0 ||
                d.toMove.length > 0
            ) || p.renumberMap.size > 0
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
    );
}
