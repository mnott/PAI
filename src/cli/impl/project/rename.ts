/**
 * pai project rename OLD NEW — change a project's slug in the registry.
 *
 * The folder is not touched. Sessions, tags, notes, aliases and the launch config
 * hang off the project row id, so they follow the slug change by themselves; what
 * is keyed by the slug string itself is re-keyed here: the old slug becomes an
 * alias, session-routing.json project_paths, session-profiles.yaml, and the
 * AIBroker manage brief. Idempotent: a rerun after success changes nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok, warn, err, dim, bold, now } from "../../lib/utils.js";
import { paiHomePath } from "../../../config/pai-home.js";
import { getRegistryBackend } from "../../../storage/factory.js";
import type { RegistryBackend } from "../../../storage/registry-interface.js";
import { readProfiles, renameProfile } from "../../../workers/session-profile-store.js";
import { findProject } from "./helpers.js";

export interface RenameOpts {
  displayName?: string;
  dryRun?: boolean;
  /** Directory holding <slug>.md manage briefs; default ~/.aibroker/manage-briefs (AIBROKER_HOME overrides). */
  briefsDir?: string;
  /** Runs `aibroker owner rename`; injectable for tests. */
  ownerRename?: (from: string, to: string) => void;
}

export interface RenameResult {
  status: "renamed" | "noop" | "refused";
  message: string;
  changes: string[];
}

function defaultBriefsDir(): string {
  return join(process.env.AIBROKER_HOME ?? join(homedir(), ".aibroker"), "manage-briefs");
}

function routingFile(): string {
  return paiHomePath("session-routing.json");
}

/** project_paths key in session-routing.json (exact match), or null when absent. */
function routingHasKey(file: string, key: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { project_paths?: Record<string, string> };
    return !!data.project_paths && key in data.project_paths;
  } catch {
    return false;
  }
}

function renameRoutingKey(file: string, from: string, to: string): boolean {
  if (!routingHasKey(file, from)) return false;
  const data = JSON.parse(readFileSync(file, "utf8")) as { project_paths: Record<string, string> };
  if (to in data.project_paths) return false;
  data.project_paths[to] = data.project_paths[from];
  delete data.project_paths[from];
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
  return true;
}

function defaultOwnerRename(from: string, to: string): void {
  execFileSync("aibroker", ["owner", "rename", from, to], { stdio: "pipe", timeout: 30_000 });
}

export async function renameProject(
  backend: RegistryBackend,
  oldSlug: string,
  newSlug: string,
  opts: RenameOpts = {}
): Promise<RenameResult> {
  const changes: string[] = [];
  const refuse = (message: string): RenameResult => ({ status: "refused", message, changes });

  if (!newSlug || oldSlug === newSlug) return refuse("OLD and NEW must differ.");

  const project = await backend.getProjectBySlug(oldSlug);
  if (!project) {
    const current = await backend.getProjectBySlug(newSlug);
    const viaAlias = await backend.getProjectByAlias(oldSlug);
    if (current && viaAlias && current.id === viaAlias.id) {
      return { status: "noop", message: `Already renamed: "${oldSlug}" is an alias of ${newSlug}. Nothing to do.`, changes };
    }
    const any = await findProject(backend, oldSlug);
    return refuse(any ? `"${oldSlug}" is an alias of ${any.slug}, not a slug; rename ${any.slug} instead.` : `Project not found: ${oldSlug}`);
  }

  const clash = await backend.getProjectBySlug(newSlug);
  if (clash) return refuse(`"${newSlug}" is already the slug of project ${clash.slug} (${clash.root_path}).`);
  const aliasOwner = await backend.getProjectByAlias(newSlug);
  const dropAlias = !!aliasOwner && aliasOwner.id === project.id;
  if (aliasOwner && !dropAlias) return refuse(`"${newSlug}" is an alias of a different project (${aliasOwner.slug}).`);

  const oldDisplay = project.display_name;
  const newDisplay = opts.displayName && opts.displayName !== oldDisplay ? opts.displayName : undefined;
  const dry = opts.dryRun === true;

  changes.push(`slug ${oldSlug} -> ${newSlug} (folder ${project.root_path} unchanged)`);
  if (dropAlias) changes.push(`alias "${newSlug}" dropped (it becomes the slug)`);
  changes.push(`"${oldSlug}" kept as alias`);
  if (newDisplay) changes.push(`display name "${oldDisplay}" -> "${newDisplay}"`);

  const routing = routingFile();
  const hasRouting = routingHasKey(routing, oldSlug);
  if (hasRouting) changes.push(`session-routing.json project_paths: ${oldSlug} -> ${newSlug}`);
  const profiles = readProfiles();
  const hasProfile = oldSlug in profiles && !(newSlug in profiles);
  if (hasProfile) changes.push(`session-profiles.yaml: ${oldSlug} -> ${newSlug}`);
  const briefs = opts.briefsDir ?? defaultBriefsDir();
  const briefOld = join(briefs, `${oldSlug}.md`);
  const briefNew = join(briefs, `${newSlug}.md`);
  const hasBrief = existsSync(briefOld) && !existsSync(briefNew);
  if (hasBrief) changes.push(`manage brief ${oldSlug}.md -> ${newSlug}.md`);
  if (newDisplay) changes.push(`aibroker owner rename "${oldDisplay}" "${newDisplay}"`);

  if (dry) return { status: "renamed", message: "Dry run: nothing was changed.", changes };

  const ts = now();
  if (dropAlias) await backend.removeAlias(newSlug);
  await backend.updateProjectSlug(project.id, newSlug, ts);
  await backend.addAlias(oldSlug, project.id);
  if (newDisplay) await backend.updateProjectDisplayName(project.id, newDisplay, ts);
  if (hasRouting) renameRoutingKey(routing, oldSlug, newSlug);
  if (hasProfile) renameProfile(oldSlug, newSlug);
  if (hasBrief) renameSync(briefOld, briefNew);
  if (newDisplay) {
    try {
      (opts.ownerRename ?? defaultOwnerRename)(oldDisplay, newDisplay);
    } catch {
      changes.push(`WARNING: owner rename not applied; run: aibroker owner rename "${oldDisplay}" "${newDisplay}"`);
    }
  }
  return { status: "renamed", message: `Renamed ${oldSlug} to ${newSlug}.`, changes };
}

export async function cmdRename(oldSlug: string, newSlug: string, opts: RenameOpts = {}): Promise<void> {
  const backend = await getRegistryBackend();
  const r = await renameProject(backend, oldSlug, newSlug, opts);
  console.log();
  for (const c of r.changes) {
    console.log(c.startsWith("WARNING") ? warn(`  ${c}`) : dim(`  ${opts.dryRun ? "would: " : ""}${c}`));
  }
  if (r.status === "refused") {
    console.error(err(`  ${r.message}`));
    process.exitCode = 1;
  } else if (r.status === "noop") {
    console.log(ok(`  ${r.message}`));
  } else {
    console.log(opts.dryRun ? dim(`  ${r.message}`) : ok(`  ${bold(r.message)}`));
  }
  console.log();
}
