/**
 * Session CRUD commands: list, info, rename, slug, tag, route, active, auto-route.
 */

import type { Database } from "better-sqlite3";
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

export function cmdList(
  db: Database,
  projectSlug: string | undefined,
  opts: { limit?: string; status?: string }
): void {
  const limit = parseInt(opts.limit ?? "20", 10);
  const params: unknown[] = [];

  let query = `
    SELECT s.*, p.slug AS project_slug, p.display_name AS project_name
    FROM sessions s
    JOIN projects p ON p.id = s.project_id
  `;

  const where: string[] = [];
  if (projectSlug) {
    const project = getProject(db, projectSlug);
    if (!project) {
      console.error(err(`Project not found: ${projectSlug}`));
      process.exit(1);
    }
    where.push("s.project_id = ?");
    params.push(project.id);
  }
  if (opts.status) {
    where.push("s.status = ?");
    params.push(opts.status);
  }

  if (where.length) query += " WHERE " + where.join(" AND ");
  query += " ORDER BY s.date DESC, s.number DESC";
  query += ` LIMIT ${limit}`;

  const rows = db.prepare(query).all(...params) as (SessionRow & {
    project_slug: string;
    project_name: string;
  })[];

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
  if (projectSlug) {
    const project = getProject(db, projectSlug)!;
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

export function cmdInfo(
  db: Database,
  projectSlug: string,
  sessionNumber: string
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, sessionNumber);

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

export function cmdRename(
  db: Database,
  projectSlug: string,
  numberOrLatest: string,
  newSlug: string
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, numberOrLatest);
  const notesDir = getNotesDir(project);

  if (!existsSync(notesDir)) {
    console.error(err(`Notes directory not found: ${notesDir}`));
    process.exit(1);
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
        process.exit(1);
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

  db.prepare(
    "UPDATE sessions SET slug = ?, title = ?, filename = ? WHERE id = ?"
  ).run(normalizedSlug, titleSlug, newFilename, session.id);

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

export function cmdSlug(
  db: Database,
  projectSlug: string,
  numberOrLatest: string,
  opts: { apply?: boolean }
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, numberOrLatest);
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
    cmdRename(db, projectSlug, String(session.number), generatedSlug);
  }
}

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

export function cmdTag(
  db: Database,
  projectSlug: string,
  sessionNumber: string,
  rawTags: string[]
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, sessionNumber);

  if (rawTags.length === 0) {
    const current = getSessionTags(db, session.id);
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
    const tagId = upsertTag(db, tagName);
    const exists = db
      .prepare("SELECT 1 FROM session_tags WHERE session_id = ? AND tag_id = ?")
      .get(session.id, tagId);
    if (exists) {
      skipped.push(tagName);
    } else {
      db.prepare(
        "INSERT INTO session_tags (session_id, tag_id) VALUES (?, ?)"
      ).run(session.id, tagId);
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

  const allTags = getSessionTags(db, session.id);
  console.log(
    `  ${bold("All tags:")} ${allTags.map((t) => chalk.cyan(t)).join(", ")}`
  );
  console.log();
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

export function cmdRoute(
  db: Database,
  projectSlug: string,
  sessionNumber: string,
  targetProjectSlug: string,
  opts: { type?: string }
): void {
  const project = getProject(db, projectSlug);
  if (!project) {
    console.error(err(`Project not found: ${projectSlug}`));
    process.exit(1);
  }

  const session = resolveSession(db, project, sessionNumber);

  const targetProject = db
    .prepare("SELECT id, slug, display_name FROM projects WHERE slug = ?")
    .get(targetProjectSlug) as
    | { id: number; slug: string; display_name: string }
    | undefined;

  if (!targetProject) {
    console.error(err(`Target project not found: ${targetProjectSlug}`));
    process.exit(1);
  }

  const validTypes = ["related", "follow-up", "reference"];
  const linkType = opts.type ?? "related";
  if (!validTypes.includes(linkType)) {
    console.error(
      err(`Invalid link type "${linkType}". Valid: ${validTypes.join(", ")}`)
    );
    process.exit(1);
  }

  try {
    db.prepare(
      `INSERT INTO links (session_id, target_project_id, link_type, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(session.id, targetProject.id, linkType, Date.now());
  } catch {
    console.log(
      warn(
        `  Link already exists: session #${session.number} → ${targetProjectSlug}`
      )
    );
    return;
  }

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

export function cmdActive(
  db: Database,
  opts: { minutes?: string; json?: boolean }
): void {
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

    const project = db
      .prepare(
        "SELECT slug, display_name, root_path FROM projects WHERE encoded_dir = ?"
      )
      .get(entry) as
      | { slug: string; display_name: string; root_path: string }
      | undefined;

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
  const { autoRoute, formatAutoRoute, formatAutoRouteJson } = await import(
    "../../../session/auto-route.js"
  );
  const { openRegistry } = await import("../../../registry/db.js");
  const { createStorageBackend } = await import("../../../storage/factory.js");
  const { loadConfig } = await import("../../../daemon/config.js");

  const config = loadConfig();
  const registryDb = openRegistry();
  const federation = await createStorageBackend(config);

  const targetCwd = opts.cwd ?? process.cwd();
  const result = await autoRoute(
    registryDb,
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
