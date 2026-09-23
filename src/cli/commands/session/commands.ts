/**
 * Session CRUD commands: list, info, rename, slug, tag, route, active, auto-route.
 */

import {
  existsSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import {
  ok,
  warn,
  err,
  dim,
  bold,
  header,
  renderTable,
  fmtDate,
} from "../../utils.js";
import {
  findLatestTranscript,
  readLastMessages,
  generateSlug,
} from "../../../session/slug-generator.js";
import type { RegistryBackend } from "../../../storage/registry-interface.js";
import type { SessionRow, ProjectRow } from "./types.js";
import {
  getProject,
  statusColor,
  toTitleCase,
  getNotesDir,
  formatFilename,
  resolveSession,
  upsertTag,
  getSessionTags,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function cmdList(
  projectSlug: string | undefined,
  opts: { limit?: string; status?: string }
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const limit = parseInt(opts.limit ?? "20", 10);

  let project: ProjectRow | undefined;
  if (projectSlug) {
    project = await getProject(registryBackend, projectSlug);
    if (!project) {
      console.error(err(`Project not found: ${projectSlug}`));
      process.exitCode = 1;
      return;
    }
  }

  const rows = await registryBackend.listSessions({
    projectId: project?.id,
    status: opts.status,
    limit,
  });

  if (!rows.length) {
    console.log(warn("No sessions found."));
    return;
  }

  const showProject = !projectSlug;
  const headers = showProject
    ? ["#", "Project", "Date", "Title", "Status", "Tokens"]
    : ["#", "Date", "Title", "Status", "Tokens"];

  const tableRows = rows.map((r) => {
    const title = r.title.length > 45 ? r.title.slice(0, 42) + "..." : r.title;
    const tokens =
      r.token_count != null ? dim(r.token_count.toLocaleString()) : dim("—");
    if (showProject) {
      return [
        dim(`#${r.number}`),
        r.project_slug,
        r.date,
        title,
        statusColor(r.status),
        tokens,
      ];
    }
    return [dim(`#${r.number}`), r.date, title, statusColor(r.status), tokens];
  });

  console.log();
  if (project) {
    console.log(`  ${bold(project.display_name)} sessions:`);
    console.log();
  }
  console.log(renderTable(headers, tableRows));
  console.log();
  console.log(dim(`  ${rows.length} session(s) shown (limit: ${limit})`));
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

export async function cmdInfo(
  projectSlug: string,
  sessionNumber: string
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const project = await getProject(registryBackend, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exitCode = 1;
    return;
  }

  const session = await resolveSession(registryBackend, project, sessionNumber);

  console.log();
  console.log(header(`  Session #${session.number}: ${session.title}`));
  console.log();
  console.log(
    `  ${bold("Project:")}     ${project.display_name} (${project.slug})`
  );
  console.log(`  ${bold("Date:")}        ${session.date}`);
  console.log(`  ${bold("Status:")}      ${statusColor(session.status)}`);
  console.log(`  ${bold("Filename:")}    ${session.filename}`);
  console.log(`  ${bold("Slug:")}        ${session.slug}`);
  if (session.claude_session_id) {
    console.log(
      `  ${bold("Claude ID:")}   ${dim(session.claude_session_id)}`
    );
  }
  if (session.token_count != null) {
    console.log(
      `  ${bold("Tokens:")}      ${session.token_count.toLocaleString()}`
    );
  }
  console.log(`  ${bold("Created:")}     ${fmtDate(session.created_at)}`);
  if (session.closed_at) {
    console.log(`  ${bold("Closed:")}      ${fmtDate(session.closed_at)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

export async function cmdRename(
  projectSlug: string,
  numberOrLatest: string,
  newSlug: string
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();
  await cmdRenameWith(registryBackend, projectSlug, numberOrLatest, newSlug);
}

async function cmdRenameWith(
  registryBackend: RegistryBackend,
  projectSlug: string,
  numberOrLatest: string,
  newSlug: string
): Promise<void> {
  const project = await getProject(registryBackend, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exitCode = 1;
    return;
  }

  const session = await resolveSession(registryBackend, project, numberOrLatest);
  const notesDir = getNotesDir(project);

  if (!existsSync(notesDir)) {
    console.error(err(`Notes directory not found: ${notesDir}`));
    process.exitCode = 1;
    return;
  }

  const titleSlug = toTitleCase(newSlug);
  const newFilename = formatFilename(session.number, session.date, titleSlug);
  const oldPath = join(notesDir, session.filename);
  const newPath = join(notesDir, newFilename);

  if (existsSync(oldPath)) {
    if (oldPath !== newPath) {
      try {
        renameSync(oldPath, newPath);
      } catch (e) {
        console.error(err(`Failed to rename file: ${e}`));
        process.exitCode = 1;
        return;
      }
    }
  } else {
    console.log(
      warn(`  Note: file not found at expected path: ${session.filename}`)
    );
    console.log(warn(`  Skipping disk rename. Database will still be updated.`));
  }

  if (existsSync(newPath)) {
    try {
      const content = readFileSync(newPath, "utf8");
      const lines = content.split("\n");
      let h1Updated = false;
      const updated = lines.map((line) => {
        if (!h1Updated && line.startsWith("# ")) {
          h1Updated = true;
          return `# ${titleSlug}`;
        }
        return line;
      });
      if (!h1Updated) updated.unshift(`# ${titleSlug}`, "");
      writeFileSync(newPath, updated.join("\n"), "utf8");
    } catch (e) {
      console.error(err(`Failed to update H1 in file: ${e}`));
    }
  }

  const normalizedSlug = newSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  await registryBackend.updateSessionMeta(session.id, {
    slug: normalizedSlug,
    title: titleSlug,
    filename: newFilename,
  });

  console.log();
  console.log(ok(`  Session #${session.number} renamed.`));
  console.log(`  ${bold("Old:")}   ${session.filename}`);
  console.log(`  ${bold("New:")}   ${newFilename}`);
  console.log(`  ${bold("Slug:")}  ${normalizedSlug}`);
  console.log(`  ${bold("Title:")} ${titleSlug}`);
  console.log();
}

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

export async function cmdSlug(
  projectSlug: string,
  numberOrLatest: string,
  opts: { apply?: boolean }
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const project = await getProject(registryBackend, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exitCode = 1;
    return;
  }

  const session = await resolveSession(registryBackend, project, numberOrLatest);
  const transcriptPath = findLatestTranscript(project.encoded_dir);

  if (!transcriptPath) {
    console.log(warn(`  No JSONL transcripts found for project ${projectSlug}`));
    console.log("unnamed-session");
    return;
  }

  const messages = readLastMessages(transcriptPath);

  if (messages.length < 2) {
    console.log(
      warn(`  Too few messages found (${messages.length}) in transcript`)
    );
    console.log("unnamed-session");
    return;
  }

  const generatedSlug = generateSlug(messages);
  console.log(generatedSlug);

  if (opts.apply) {
    console.log();
    console.log(dim(`  Applying slug to session #${session.number}...`));
    await cmdRenameWith(registryBackend, projectSlug, String(session.number), generatedSlug);
  }
}

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

export async function cmdTag(
  projectSlug: string,
  sessionNumber: string,
  rawTags: string[]
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const project = await getProject(registryBackend, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exitCode = 1;
    return;
  }

  const session = await resolveSession(registryBackend, project, sessionNumber);

  if (rawTags.length === 0) {
    const current = await getSessionTags(registryBackend, session.id);
    console.log();
    if (current.length === 0) {
      console.log(dim(`  Session #${session.number} has no tags.`));
    } else {
      console.log(
        `  ${bold(`Session #${session.number}`)} tags: ${current
          .map((t) => chalk.cyan(t))
          .join(", ")}`
      );
    }
    console.log();
    return;
  }

  const tags = rawTags
    .flatMap((t) => t.split(","))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  if (tags.length === 0) {
    console.log(warn("No valid tags provided."));
    return;
  }

  const added: string[] = [];
  const skipped: string[] = [];

  for (const tagName of tags) {
    const tagId = await upsertTag(registryBackend, tagName);
    const exists = await registryBackend.sessionHasTag(session.id, tagId);
    if (exists) {
      skipped.push(tagName);
    } else {
      await registryBackend.addSessionTag(session.id, tagId);
      added.push(tagName);
    }
  }

  console.log();
  if (added.length) {
    console.log(
      ok(
        `  Tagged session #${session.number}: ${added
          .map((t) => chalk.cyan(t))
          .join(", ")}`
      )
    );
  }
  if (skipped.length) {
    console.log(dim(`  Already present: ${skipped.join(", ")}`));
  }

  const allTags = await getSessionTags(registryBackend, session.id);
  console.log(
    `  ${bold("All tags:")} ${allTags.map((t) => chalk.cyan(t)).join(", ")}`
  );
  console.log();
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

export async function cmdRoute(
  projectSlug: string,
  sessionNumber: string,
  targetProjectSlug: string,
  opts: { type?: string }
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const project = await getProject(registryBackend, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exitCode = 1;
    return;
  }

  const session = await resolveSession(registryBackend, project, sessionNumber);

  const targetProject = await getProject(registryBackend, targetProjectSlug);

  if (!targetProject) {
    console.error(err(`Target project not found: ${targetProjectSlug}`));
    process.exitCode = 1;
    return;
  }

  const validTypes = ["related", "follow-up", "reference"];
  const linkType = (opts.type ?? "related") as "related" | "follow-up" | "reference";
  if (!validTypes.includes(linkType)) {
    console.error(
      err(`Invalid link type "${linkType}". Valid: ${validTypes.join(", ")}`)
    );
    process.exitCode = 1;
    return;
  }

  if (await registryBackend.linkExists(session.id, targetProject.id)) {
    console.log(
      warn(
        `  Link already exists: session #${session.number} → ${targetProjectSlug}`
      )
    );
    return;
  }

  await registryBackend.addLink({
    sessionId: session.id,
    targetProjectId: targetProject.id,
    linkType,
    createdAt: Date.now(),
  });

  console.log();
  console.log(
    ok(
      `  Linked session #${session.number} (${project.slug}) → ${targetProject.display_name} (${targetProjectSlug})`
    )
  );
  console.log(dim(`  Link type: ${linkType}`));
  console.log();
}

// ---------------------------------------------------------------------------
// active
// ---------------------------------------------------------------------------

export async function cmdActive(
  opts: { minutes?: string; json?: boolean }
): Promise<void> {
  const { getRegistryBackend } = await import("../../../storage/factory.js");
  const registryBackend = await getRegistryBackend();

  const minutes = parseInt(opts.minutes ?? "60", 10);
  const cutoff = Date.now() - minutes * 60 * 1000;
  const claudeProjectsDir = join(homedir(), ".claude", "projects");

  if (!existsSync(claudeProjectsDir)) {
    console.log(err("Claude projects directory not found."));
    return;
  }

  interface ActiveSession {
    slug: string;
    displayName: string;
    rootPath: string;
    encodedDir: string;
    lastModified: Date;
    jsonlFile: string;
  }

  const active: ActiveSession[] = [];
  const entries = readdirSync(claudeProjectsDir);

  for (const entry of entries) {
    const projectDir = join(claudeProjectsDir, entry);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let latestJsonl: string | null = null;
    let latestMtime = 0;

    try {
      for (const file of readdirSync(projectDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(projectDir, file);
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latestJsonl = filePath;
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }

    if (!latestJsonl || latestMtime < cutoff) continue;

    const project = await registryBackend.getProjectByEncodedDir(entry);

    active.push({
      slug: project?.slug ?? entry,
      displayName: project?.display_name ?? project?.slug ?? entry,
      rootPath: project?.root_path ?? "",
      encodedDir: entry,
      lastModified: new Date(latestMtime),
      jsonlFile: latestJsonl,
    });
  }

  active.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  const seen = new Set<string>();
  const deduped = active.filter((a) => {
    const key = a.slug.replace(/-\d+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        deduped.map((a) => ({
          slug: a.slug,
          display_name: a.displayName,
          root_path: a.rootPath,
          last_modified: a.lastModified.toISOString(),
        })),
        null,
        2
      )
    );
    return;
  }

  if (deduped.length === 0) {
    console.log(dim(`No active sessions in the last ${minutes} minutes.`));
    return;
  }

  console.log(
    header(`Currently Active Sessions`) +
      dim(` (modified in last ${minutes}min)`)
  );
  console.log();

  const rows = deduped.map((a) => {
    const time = a.lastModified.toTimeString().slice(0, 5);
    const dirName = a.rootPath
      ? a.rootPath.replace(homedir(), "~").split("/").pop() ?? a.slug
      : a.slug;
    return [chalk.cyan(dirName), dim(a.slug), chalk.green(time)];
  });

  console.log(renderTable(["Directory", "Project", "Last Active"], rows));
}

// ---------------------------------------------------------------------------
// auto-route
// ---------------------------------------------------------------------------

export async function cmdAutoRoute(opts: {
  cwd?: string;
  context?: string;
  json?: boolean;
}): Promise<void> {
  const { autoRoute, formatAutoRouteJson } = await import(
    "../../../session/auto-route.js"
  );
  const { getRegistryBackend, createStorageBackend } = await import("../../../storage/factory.js");
  const { loadConfig } = await import("../../../daemon/config.js");

  const config = loadConfig();
  const registryBackend = await getRegistryBackend();
  const federation = await createStorageBackend(config);

  const targetCwd = opts.cwd ?? process.cwd();
  const result = await autoRoute(
    registryBackend,
    federation,
    targetCwd,
    opts.context
  );

  if (!result) {
    console.log();
    console.log(warn("  No project match found for: " + targetCwd));
    console.log();
    console.log(
      dim("  Tried: path match, PAI.md marker walk") +
        (opts.context ? dim(", topic detection") : "")
    );
    console.log();
    console.log(dim("  Run 'pai project add .' to register this directory."));
    console.log();
    return;
  }

  if (opts.json) {
    console.log(formatAutoRouteJson(result));
    return;
  }

  console.log();
  console.log(header("  PAI Auto-Route"));
  console.log();
  console.log(`  ${bold("Project:")}     ${result.display_name}`);
  console.log(`  ${bold("Slug:")}        ${result.slug}`);
  console.log(`  ${bold("Root path:")}   ${result.root_path}`);
  console.log(`  ${bold("Method:")}      ${result.method}`);
  console.log(
    `  ${bold("Confidence:")}  ${(result.confidence * 100).toFixed(0)}%`
  );
  console.log();
  console.log(ok("  Routed to: ") + bold(result.slug));
  console.log();
}
