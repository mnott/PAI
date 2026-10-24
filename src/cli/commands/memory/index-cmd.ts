/** Memory index command: index one or all projects into the memory store. */

import type { StorageBackend } from "../../../storage/interface.js";
import type { IndexResult } from "../../../memory/indexer-backend.js";
import { indexProjectWithBackend } from "../../../memory/indexer-backend.js";
import { getStorageBackend, getRegistryBackend } from "../../../storage/factory.js";
import { dim, bold, ok, err } from "../../lib/utils.js";
import { PaiClient } from "../../../daemon/ipc-client.js";
import { loadConfig } from "../../../daemon/config.js";
import { runEmbed } from "./embed.js";
import { acquireRun, readRun } from "../../../memory/run-state.js";
import { reexecBackground } from "../../../daemon/pass-priority.js";
import { jobProgressFromEnv } from "../../../memory/job-progress.js";

/**
 * Index every active project through the StorageBackend. Loops
 * indexProjectWithBackend() per project rather than the sync indexer's
 * indexAll(), since that one still takes a raw registry Database handle.
 */
async function indexAllProjects(
  backend: StorageBackend,
): Promise<{ projects: number; result: IndexResult }> {
  const registry = await getRegistryBackend();
  const projects = await registry.listProjects({ status: "active" });

  const totals: IndexResult = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0 };
  // progress into the cockpit job (PAI_COCKPIT_JOB), fed from the same totals the final line prints
  const progress = jobProgressFromEnv("index");
  const report = (done: number, current: string, part?: IndexResult): void =>
    progress?.update({ phase: "index", unit: "projects", done, total: projects.length, files: totals.filesProcessed + (part?.filesProcessed ?? 0), chunks: totals.chunksCreated + (part?.chunksCreated ?? 0), skipped: totals.filesSkipped + (part?.filesSkipped ?? 0), current });
  report(0, "");
  let n = 0;
  for (const project of projects) {
    report(n, project.display_name);
    const r = await indexProjectWithBackend(backend, project.id, project.root_path, project.claude_notes_dir, (part) => report(n, project.display_name, part));
    totals.filesProcessed += r.filesProcessed;
    totals.chunksCreated += r.chunksCreated;
    totals.filesSkipped += r.filesSkipped;
    report(++n, project.display_name);
  }
  progress?.finish();
  return { projects: projects.length, result: totals };
}

export async function memoryIndexCmd(
  projectSlug: string | undefined,
  opts: { all?: boolean; embed?: boolean; direct?: boolean; background?: boolean }
): Promise<number> {
  if (opts.background) {
    opts.direct = true;
    reexecBackground();
  }
  // If daemon is running and no --direct flag, trigger via IPC (non-blocking)
  if (!opts.direct && !projectSlug) {
    try {
      const config = loadConfig();
      const client = new PaiClient(config.socketPath);
      await client.triggerIndex();
      console.log(ok("Index triggered in daemon.") + dim("  Check daemon logs for progress."));
      console.log(dim("  Run `pai daemon logs` to watch progress."));
      return 0;
    } catch {
      console.log(dim("Daemon not running. Running direct index..."));
    }
  }

  let backend: StorageBackend;
  try {
    backend = await getStorageBackend();
  } catch (e) {
    console.error(err(`Failed to open storage backend: ${e}`));
    process.exitCode = 1;
    return 1;
  }

  const held = readRun();
  if (held) {
    console.error(err(`${held.kind} already running (started by ${held.by}, pid ${held.pid})`));
    process.exitCode = 1;
    return 1;
  }
  const run = acquireRun("index");
  if (!run) {
    console.error(err("another memory run just started"));
    process.exitCode = 1;
    return 1;
  }
  let finished = false;
  try {
    if (projectSlug) {
      const registry = await getRegistryBackend();
      const project = await registry.getProjectBySlug(projectSlug);

      if (!project || project.status !== "active") {
        console.error(err(`Project not found or not active: ${projectSlug}`));
        process.exitCode = 1;
        return 1;
      }

      console.log(dim(`Indexing ${project.display_name} (${project.slug})...`));
      const result = await indexProjectWithBackend(backend, project.id, project.root_path, project.claude_notes_dir);

      console.log(
        ok(`Done.`) +
        `  ${bold(String(result.filesProcessed))} files indexed` +
        `, ${bold(String(result.chunksCreated))} chunks created` +
        `, ${dim(String(result.filesSkipped) + " skipped (unchanged)")}`,
      );

      if (opts.embed) {
        await runEmbed(backend, project.id, project.slug);
      }

    } else if (opts.all || !projectSlug) {
      console.log(dim("Indexing all active projects..."));

      const { projects, result } = await indexAllProjects(backend);

      console.log(
        ok(`Done.`) +
        `  ${bold(String(projects))} projects` +
        `, ${bold(String(result.filesProcessed))} files indexed` +
        `, ${bold(String(result.chunksCreated))} chunks created` +
        `, ${dim(String(result.filesSkipped) + " skipped (unchanged)")}`,
      );

      if (opts.embed) {
        await runEmbed(backend);
      }
    }

    finished = true;
  } finally {
    run.release(finished ? { outcome: "done" } : { outcome: "failed", reason: "index did not complete" });
  }

  return 0;
}
