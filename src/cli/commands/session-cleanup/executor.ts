/**
 * Dry-run display, Postgres vector DB path updates, and cleanup execution.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import chalk from "chalk";
import { ok, warn, err, dim, bold, header } from "../../utils.js";
import type { CleanupPlan, SessionCandidate } from "./types.js";
import { padNum } from "./rename.js";

// ---------------------------------------------------------------------------
// Vector DB (StorageBackend) helpers
// ---------------------------------------------------------------------------

async function countVectorDbPaths(oldPaths: string[]): Promise<number> {
  if (oldPaths.length === 0) return 0;
  try {
    const { loadConfig } = await import("../../../daemon/config.js");
    const { createStorageBackend } = await import("../../../storage/factory.js");
    const config = loadConfig();
    if (config.storageBackend !== "postgres") return 0;
    const backend = await createStorageBackend(config);
    try {
      if (!backend.supportsPostgresFeatures) return 0;
      return await backend.countFilesWithPaths(oldPaths);
    } finally {
      await backend.close();
    }
  } catch {
    return 0;
  }
}

async function updateVectorDbPaths(
  moves: Array<{ oldPath: string; newPath: string }>
): Promise<number> {
  if (moves.length === 0) return 0;
  try {
    const { loadConfig } = await import("../../../daemon/config.js");
    const { createStorageBackend } = await import("../../../storage/factory.js");
    const config = loadConfig();
    if (config.storageBackend !== "postgres") return 0;
    const backend = await createStorageBackend(config);
    try {
      if (!backend.supportsPostgresFeatures) {
        process.stderr.write("[session-cleanup] Postgres unavailable. Skipping vector DB path update.\n");
        return 0;
      }
      return await backend.renameFilePaths(moves);
    } finally {
      await backend.close();
    }
  } catch (e) {
    process.stderr.write(`[session-cleanup] Failed to update vector DB paths: ${e}\n`);
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Dry-run display
// ---------------------------------------------------------------------------

export async function displayDryRun(plans: CleanupPlan[]): Promise<void> {
  let totalDelete = 0;
  let totalRename = 0;
  let totalMove = 0;
  let totalRenumber = 0;

  for (const plan of plans) {
    const hasWork =
      plan.notesDirs.some(
        (d) => d.toDelete.length > 0 || d.toRename.length > 0 || d.toMove.length > 0
      ) || plan.renumberMap.size > 0;
    if (!hasWork) continue;

    console.log();
    console.log(
      header(`  Project: ${plan.project.display_name} (${plan.project.slug})`)
    );

    for (const dirPlan of plan.notesDirs) {
      console.log(dim(`  Notes: ${dirPlan.notesDir}`));

      if (dirPlan.toDelete.length > 0) {
        console.log(bold("  ARCHIVE (empty/template-only sessions → .archive/):"));
        for (const c of dirPlan.toDelete) {
          console.log(
            `    ${chalk.yellow("ARCH")} ${dim(padNum(c.number))} - ${c.date} - ${
              c.filename.split(" - ").slice(2).join(" - ")
            } ${dim(`(${c.sizeBytes}b)`)}`
          );
          totalDelete++;
        }
        console.log();
      }

      if (dirPlan.toRename.length > 0) {
        console.log(bold("  RENAME (unnamed or legacy-format sessions):"));
        for (const c of dirPlan.toRename) {
          const autoName = c.autoName ?? "Unnamed Session";
          console.log(`    ${chalk.yellow("REN")}  ${c.filename}`);
          console.log(`         → ${padNum(c.number)} - ${c.date} - ${autoName}.md`);
          totalRename++;
        }
        console.log();
      }

      if (dirPlan.toMove.length > 0) {
        console.log(bold("  MOVE TO YYYY/MM/ hierarchy:"));
        for (const c of dirPlan.toMove) {
          const [year, month] = c.date.split("-");
          console.log(`    ${chalk.cyan("MOV")}  ${c.filename}`);
          console.log(`         → ${year}/${month}/${c.filename}`);
          totalMove++;
        }
        console.log();
      }
    }

    if (plan.renumberMap.size > 0) {
      console.log(
        bold("  RENUMBER (after deletions, global across all Notes/ dirs):")
      );
      for (const [oldN, newN] of plan.renumberMap) {
        console.log(
          `    ${chalk.blue("NUM")}  #${padNum(oldN)} → #${padNum(newN)}`
        );
        totalRenumber++;
      }
      console.log();
    }
  }

  const wouldMovePaths: string[] = [];
  for (const plan of plans) {
    for (const dirPlan of plan.notesDirs) {
      for (const c of dirPlan.toMove) {
        const [year, month] = c.date.split("-");
        const targetPath = join(dirPlan.notesDir, year, month, c.filename);
        if (c.filepath !== targetPath) wouldMovePaths.push(c.filepath);
      }
    }
  }

  const vectorDbCount = await countVectorDbPaths(wouldMovePaths);

  console.log();
  console.log(bold("  Summary (dry-run):"));
  console.log(`    ${chalk.yellow("ARCH")} ${totalDelete} empty sessions to archive (moved, not deleted)`);
  console.log(`    ${chalk.yellow("REN")}  ${totalRename} unnamed sessions to rename`);
  console.log(`    ${chalk.blue("NUM")}  ${totalRenumber} sessions to renumber`);
  console.log(`    ${chalk.cyan("MOV")}  ${totalMove} sessions to move into YYYY/MM/ dirs`);
  if (vectorDbCount > 0) {
    console.log(
      `    ${chalk.magenta("VEC")}  ${vectorDbCount} file path(s) will be updated in the vector DB (embeddings preserved)`
    );
  } else if (wouldMovePaths.length > 0) {
    console.log(
      `    ${chalk.magenta("VEC")}  0 file path(s) found in vector DB for moved files (no embeddings to preserve)`
    );
  }
  console.log();
  console.log(warn("  This is a dry-run. Add --execute to apply changes."));
  console.log();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeCleanup(
  plans: CleanupPlan[],
  skipReindex: boolean
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  let deleted = 0;
  let renamed = 0;
  let moved = 0;
  let renumbered = 0;
  let dbUpdated = 0;
  const vectorDbMoves: Array<{ oldPath: string; newPath: string }> = [];

  for (const plan of plans) {
    console.log();
    console.log(
      header(`  Project: ${plan.project.display_name} (${plan.project.slug})`)
    );

    for (const dirPlan of plan.notesDirs) {
      const { notesDir } = dirPlan;
      if (plan.notesDirs.length > 1) console.log(dim(`  Directory: ${notesDir}`));

      // Step 1: Retire "empty" sessions — by moving them, never by unlinking.
      //
      // This deleted four titled notes from Youdrill on 2026-08-03 ("Cocoapods
      // Bootstrap", "Youdrill Tools Pipeline Review", and two more), and they
      // were only recoverable because that session inspected the diff before
      // committing. Anywhere this ran and was committed, the notes are gone.
      //
      // The classifier is the root problem: EMPTY is `sizeBytes < 400 ||
      // isTemplateOnly`. Size is a proxy for worthlessness and a bad one — a
      // real session that produced three lines and a good title is under 400
      // bytes. But no threshold is worth trusting with an irreversible
      // operation, so the fix is not a better number: it is that a cleanup tool
      // has no business destroying anything a human might want back.
      //
      // Moving to .archive/ still achieves the actual goal (the note leaves the
      // working listing and the numbering respreads) while keeping the file.
      for (const c of dirPlan.toDelete) {
        try {
          const archiveDir = join(dirname(c.filepath), ".archive");
          mkdirSync(archiveDir, { recursive: true });
          let dest = join(archiveDir, c.filename);
          // Never clobber an earlier archived note with the same name.
          if (existsSync(dest)) {
            const stamp = statSync(c.filepath).mtimeMs.toString(36);
            dest = join(archiveDir, `${c.filename.replace(/\.md$/, "")} (${stamp}).md`);
          }
          renameSync(c.filepath, dest);
          console.log(ok(`  ARCH ${c.filename}`) + dim(" → .archive/"));
          deleted++;
        } catch (e) {
          console.log(err(`  FAIL to archive ${c.filename}: ${e}`));
        }
        if (c.session) {
          try {
            await registryBackend.deleteSession(c.session.id);
            dbUpdated++;
          } catch (e) {
            console.log(err(`  FAIL to remove session #${c.number} from DB: ${e}`));
          }
        }
      }

      // Step 2: Rename unnamed/legacy sessions
      for (const c of dirPlan.toRename) {
        const autoName = c.autoName ?? "Unnamed Session";
        const newFilename = `${padNum(c.number)} - ${c.date} - ${autoName}.md`;
        const newPath = join(notesDir, newFilename);

        if (c.filepath !== newPath) {
          try {
            renameSync(c.filepath, newPath);
            console.log(ok(`  REN  ${c.filename}`));
            console.log(dim(`       → ${newFilename}`));
            renamed++;
            (c as { filename: string }).filename = newFilename;
            (c as { filepath: string }).filepath = newPath;
          } catch (e) {
            console.log(err(`  FAIL rename ${c.filename}: ${e}`));
            continue;
          }
        }

        try {
          const content = readFileSync(newPath, "utf8");
          const lines = content.split("\n");
          let h1Updated = false;
          const updated = lines.map((line) => {
            if (!h1Updated && line.startsWith("# ")) {
              h1Updated = true;
              return `# ${autoName}`;
            }
            return line;
          });
          if (!h1Updated) updated.unshift(`# ${autoName}`, "");
          writeFileSync(newPath, updated.join("\n"), "utf8");
        } catch {
          // Non-fatal
        }

        if (c.session) {
          const normalizedSlug = autoName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
          try {
            await registryBackend.updateSessionMeta(c.session.id, {
              slug: normalizedSlug,
              title: autoName,
              filename: newFilename,
            });
            dbUpdated++;
          } catch (e) {
            console.log(err(`  FAIL DB update for session #${c.number}: ${e}`));
          }
        }
      }

      // Step 3a: Renumber survivors
      if (plan.renumberMap.size > 0) {
        const toRenumber = dirPlan.toMove.filter((c) =>
          plan.renumberMap.has(c.number)
        );

        const tempFiles: {
          candidate: SessionCandidate;
          tempPath: string;
          newNum: number;
        }[] = [];
        for (const c of toRenumber) {
          const newNum = plan.renumberMap.get(c.number)!;
          const tempFilename = `__tmp_${padNum(c.number)}_${c.filename}`;
          const tempPath = join(notesDir, tempFilename);
          try {
            if (existsSync(c.filepath)) {
              renameSync(c.filepath, tempPath);
              tempFiles.push({ candidate: c, tempPath, newNum });
            }
          } catch (e) {
            console.log(err(`  FAIL temp-rename #${c.number}: ${e}`));
          }
        }

        for (const { candidate: c, tempPath, newNum } of tempFiles) {
          const newFilename = c.filename.replace(/^\d{4}/, padNum(newNum));
          const newPath = join(notesDir, newFilename);
          try {
            renameSync(tempPath, newPath);
            console.log(
              ok(`  NUM  #${padNum(c.number)} → #${padNum(newNum)}: ${newFilename}`)
            );
            renumbered++;
            (c as { filename: string }).filename = newFilename;
            (c as { filepath: string }).filepath = newPath;
            (c as { number: number }).number = newNum;
          } catch (e) {
            console.log(err(`  FAIL final-rename #${newNum}: ${e}`));
          }

          if (existsSync(newPath)) {
            try {
              const content = readFileSync(newPath, "utf8");
              const lines = content.split("\n");
              const updated = lines.map((line) => {
                if (line.match(/^# Session \d{4}:/)) {
                  return line.replace(
                    /^# Session \d{4}:/,
                    `# Session ${padNum(newNum)}:`
                  );
                }
                return line;
              });
              writeFileSync(newPath, updated.join("\n"), "utf8");
            } catch {
              // Non-fatal
            }
          }
        }

        const dbRenumbers = tempFiles
          .filter(({ candidate: c }) => c.session != null)
          .map(({ candidate: c, newNum }) => ({
            session: c.session!,
            newNum,
            newFilename: c.filename,
          }));

        if (dbRenumbers.length > 0) {
          try {
            // Negate first, then set final numbers — same two-pass order as the
            // old single SQL transaction, so mid-loop UNIQUE(project_id, number)
            // collisions between swapping sessions are still avoided.
            for (const { session, newNum } of dbRenumbers) {
              await registryBackend.updateSessionNumber(session.id, -newNum);
            }
            for (const { session, newNum, newFilename } of dbRenumbers) {
              await registryBackend.updateSessionNumber(session.id, newNum, {
                filename: newFilename,
              });
            }
            dbUpdated += dbRenumbers.length;
          } catch (e) {
            console.log(err(`  FAIL DB renumber transaction: ${e}`));
          }
        }
      }

      // Step 3b: Move to YYYY/MM/
      for (const c of dirPlan.toMove) {
        const [year, month] = c.date.split("-");
        const targetDir = join(notesDir, year, month);
        const targetPath = join(targetDir, c.filename);
        if (c.filepath === targetPath) continue;

        try {
          mkdirSync(targetDir, { recursive: true });
        } catch (e) {
          console.log(err(`  FAIL mkdir ${targetDir}: ${e}`));
          continue;
        }

        const oldAbsPath = c.filepath;
        try {
          if (existsSync(c.filepath)) {
            renameSync(c.filepath, targetPath);
            console.log(ok(`  MOV  ${c.filename}`));
            console.log(dim(`       → ${year}/${month}/${c.filename}`));
            moved++;
            vectorDbMoves.push({ oldPath: oldAbsPath, newPath: targetPath });
          }
        } catch (e) {
          console.log(err(`  FAIL move ${c.filename}: ${e}`));
          continue;
        }

        const newFilenameInDb = `${year}/${month}/${c.filename}`;
        if (c.session) {
          try {
            await registryBackend.updateSessionFilename(c.session.id, newFilenameInDb);
            dbUpdated++;
          } catch (e) {
            console.log(err(`  FAIL DB update path for ${c.filename}: ${e}`));
          }
        }
      }
    }
  }

  // Step 5: Update Postgres vector DB paths
  let vectorDbUpdated = 0;
  if (vectorDbMoves.length > 0) {
    console.log();
    console.log(
      dim(
        `  Updating ${vectorDbMoves.length} file path(s) in vector DB to preserve embeddings...`
      )
    );
    const result = await updateVectorDbPaths(vectorDbMoves);
    if (result >= 0) {
      vectorDbUpdated = result;
      console.log(
        ok(`  Updated ${vectorDbUpdated} file path(s) in Postgres (embeddings preserved)`)
      );
    } else {
      console.log(
        warn(
          "  Vector DB path update failed — embeddings may be orphaned (check logs)"
        )
      );
    }
  }

  console.log();
  console.log(bold("  Cleanup complete:"));
  console.log(ok(`    ${deleted} session(s) deleted`));
  console.log(ok(`    ${renamed} session(s) renamed`));
  console.log(ok(`    ${renumbered} session(s) renumbered`));
  console.log(ok(`    ${moved} session(s) moved to YYYY/MM/ hierarchy`));
  console.log(ok(`    ${dbUpdated} registry DB record(s) updated`));
  if (vectorDbMoves.length > 0) {
    console.log(
      ok(
        `    ${vectorDbUpdated} vector DB file path(s) updated (embeddings preserved)`
      )
    );
  }

  if (!skipReindex) {
    console.log();
    console.log(
      dim("  Memory re-index: the PAI daemon will pick up changes within 5 minutes.")
    );
    console.log(dim("  To force immediate re-index: pai memory index --all"));
  }

  console.log();
}
