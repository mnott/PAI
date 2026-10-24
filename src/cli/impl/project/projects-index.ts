/**
 * Implementations for all `pai projects` sub-commands (plural namespace).
 *
 * This is the canonical namespace. `pai project <subcmd>` (singular) is a
 * deprecated alias that forwards here with a stderr notice.
 */

import { cmdPromote } from "../../../session/promote.js";
import {
  cmdAdd,
  cmdList,
  cmdInfo,
  cmdArchive,
  cmdUnarchive,
  cmdMove,
  cmdTag,
  cmdAlias,
  cmdEdit,
  cmdDetect,
  cmdConsolidate,
  cmdGo,
  cmdRebind,
  tryRecoverMovedProject,
} from "./commands.js";
import { existsSync } from "node:fs";
import { cmdName, cmdUnname, cmdNames, cmdConfig, cmdMcp, cmdTools } from "./session-config.js";
import { cmdHealth } from "./health.js";
import { cmdInit } from "./init.js";
import { cmdMerge } from "./merge.js";
import { cmdHere } from "./here.js";
import { cmdUnregister } from "./unregister.js";
import { resolveIdentifier } from "./helpers.js";
import { pinNotices, projectLaunchConfig } from "../../../workers/project-config.js";

export { cmdGo };

// New functions for converted commands
export async function projectListCmd(opts: { all?: boolean; workers?: boolean; n?: string }): Promise<number> {
  const { cmdMain } = await import("../../lib/main-resolver.js");
  await cmdMain(undefined, undefined, opts);
  return 0;
}

export async function projectListRawCmd(opts: { all?: boolean; status?: string; tag?: string; type?: string }): Promise<number> {
  await cmdList(opts);
  return 0;
}

export async function projectCdCmd(identifier: string): Promise<number> {
  const project = await resolveIdentifier(identifier);
  if (!project) {
    console.error(`Project not found: ${identifier}`);
    return 1;
  }

  if (existsSync(project.root_path)) {
    process.stdout.write(project.root_path + "\n");
    return 0;
  }

  // Path missing — search for moved location
  const recovered = await tryRecoverMovedProject(project);
  if (!recovered) return 1;
  process.stdout.write(recovered + "\n");
  return 0;
}

export async function projectAddCmd(rawPath: string, opts: { slug?: string; type?: string; displayName?: string; trust?: boolean }): Promise<number> {
  await cmdAdd(rawPath, opts);
  return 0;
}

export async function projectInfoCmd(slug: string): Promise<number> {
  await cmdInfo(slug);
  return 0;
}

export async function projectArchiveCmd(slug: string): Promise<number> {
  await cmdArchive(slug);
  return 0;
}

export async function projectMergeCmd(from: string, into: string, opts: { execute?: boolean }): Promise<number> {
  await cmdMerge(from, into, opts);
  return 0;
}

// New functions for remaining converted commands
export async function projectUnregisterCmd(slug: string, opts: { execute?: boolean; force?: boolean }): Promise<number> {
  await cmdUnregister(slug, opts);
  return 0;
}

export async function projectUnarchiveCmd(slug: string): Promise<number> {
  await cmdUnarchive(slug);
  return 0;
}

export async function projectMoveCmd(slug: string, newPath: string): Promise<number> {
  await cmdMove(slug, newPath);
  return 0;
}

export async function projectRebindCmd(slug: string, newPath: string): Promise<number> {
  await cmdRebind(slug, newPath);
  return 0;
}

export async function projectHereCmd(name: string, opts: { dryRun?: boolean }): Promise<number> {
  await cmdHere(name, { dryRun: opts.dryRun });
  return 0;
}

export async function projectTagCmd(slug: string, tags: string[]): Promise<number> {
  await cmdTag(slug, tags);
  return 0;
}

export async function projectAliasCmd(slug: string, alias: string): Promise<number> {
  await cmdAlias(slug, alias);
  return 0;
}

export async function projectEditCmd(slug: string, opts: { displayName?: string; type?: string }): Promise<number> {
  await cmdEdit(slug, opts);
  return 0;
}

export async function projectDetectCmd(pathArg: string | undefined, opts: { json?: boolean }): Promise<number> {
  await cmdDetect(pathArg, opts);
  return 0;
}

export async function projectHealthCmd(opts: { fix?: boolean; json?: boolean; status?: string }): Promise<number> {
  await cmdHealth(opts);
  return 0;
}

export async function projectInitCmd(opts: { anchor?: number; marker?: string; force?: boolean; dryRun?: boolean }): Promise<number> {
  await cmdInit(opts);
  return 0;
}

export async function projectConsolidateCmd(identifier: string, opts: { yes?: boolean; dryRun?: boolean }): Promise<number> {
  await cmdConsolidate(identifier, opts);
  return 0;
}

export async function projectPromoteCmd(opts: { fromSession: string; to: string; name?: string }): Promise<number> {
  // Ensure required fields are present (they are required in the function signature)
  const promoteOpts = {
    fromSession: opts.fromSession,
    to: opts.to,
    name: opts.name
  };
  await cmdPromote(promoteOpts);
  return 0;
}

export async function projectGoCmd(query: string): Promise<number> {
  await cmdGo(query);
  return 0;
}

export async function projectNameCmd(identifier: string, shortname: string, opts: { permission?: string }): Promise<number> {
  await cmdName(identifier, shortname, opts);
  return 0;
}

export async function projectUnnameCmd(shortname: string): Promise<number> {
  await cmdUnname(shortname);
  return 0;
}

export async function projectNamesCmd(opts: { json?: boolean; all?: boolean }): Promise<number> {
  await cmdNames(opts);
  return 0;
}

export async function projectConfigCmd(identifier: string | undefined, opts: { set?: string[]; unset?: string[]; preset?: string; defaults?: boolean; options?: boolean; json?: boolean; reset?: boolean }): Promise<number> {
  await cmdConfig(identifier, opts);
  return 0;
}

export async function projectMcpCmd(names: string[], opts: { clear?: boolean; set?: string }): Promise<number> {
  await cmdMcp(names, opts);
  return 0;
}

export async function projectPinsCmd(): Promise<number> {
  for (const line of pinNotices(await projectLaunchConfig(process.cwd()))) console.log(line);
  return 0;
}

export async function projectToolsCmd(names: string[], opts: { clear?: boolean; set?: string }): Promise<number> {
  await cmdTools(names, opts);
  return 0;
}
