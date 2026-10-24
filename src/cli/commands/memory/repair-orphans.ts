/** `pai memory repair-orphans`: re-attach chunks that a registry rebuild left under dead project ids. */

import { dim, bold, ok, warn } from "../../lib/utils.js";
import { getRegistryBackend } from "../../../storage/factory.js";

export async function memoryRepairOrphansCmd(opts: { execute: boolean; deleteTwins: boolean; includeStale?: boolean }): Promise<number> {
  const backend = await getRegistryBackend();
  const before = await backend.countOrphanedChunks();
  const r = await backend.repairOrphans({ dryRun: !opts.execute, deleteTwins: opts.deleteTwins, includeStale: opts.includeStale, log: (m) => console.log(dim(`  ${m}`)) });
  console.log(`\n  ${bold("Orphaned chunks")}  ${r.orphanChunks} (${before.total} chunks in all), ${r.orphanFiles} files`);
  console.log(`  ${bold("Old ids")}          ${r.mappedIds} map to a current project, ${r.unmappedIds} do not (left alone)`);
  if (opts.deleteTwins) {
    const v = r.dryRun ? "Would delete" : "Deleted";
    console.log(`  ${bold(v)}      ${r.deletedTwinChunks} mapped orphan chunks that have a vectored twin`);
    console.log(`  ${bold("Unmapped")}         ${r.unmappedTwinChunks} chunks with a hash twin, ${r.unmappedStaleChunks} stale (no twin${opts.includeStale ? ", included" : "; --include-stale to delete"})`);
    console.log(`  ${bold(v)}      ${r.deletedUnmappedChunks} unmapped chunks, ${r.deletedUnmappedFiles} files`);
    for (const f of r.backupFiles) console.log(dim(`  Backup           ${f}`));
  } else {
    console.log(`  ${bold(r.dryRun ? "Would re-point" : "Re-pointed")}   ${r.repointedChunks} chunks, ${r.repointedFiles} files`);
    console.log(`  ${bold(r.dryRun ? "Would drop" : "Dropped")}        ${r.droppedDuplicateChunks} vectorless duplicate chunks, ${r.droppedDuplicateFiles} files`);
  }
  if (r.dryRun) {
    console.log(dim("\n  Dry run: nothing changed. Add --execute to apply."));
  } else {
    const after = await backend.countOrphanedChunks();
    console.log((after.orphaned === 0 ? ok : warn)(`\n  Orphaned chunks now: ${after.orphaned}`));
  }
  console.log();
  return 0;
}
