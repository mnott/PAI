/** Master note generation and session tag fixing for vault projects. */

import {
  existsSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RegistryBackend } from "../../storage/registry-interface.js";
import { collectSessionFiles, walkNotesDir } from "./walk.js";
import { worktreeReason } from "../../registry/registrable.js";
import { writeIfChanged } from "./write-if-changed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the per-project master note filename. */
export function masterFilename(slug: string): string {
  return `_${slug}-master.md`;
}

/** Strip any old/broken backlink footer from note content. */
function stripOldBacklink(content: string): string {
  const oldPattern = /\n---\n\[\[\.\.\/[^\]]+\]\]\n?$/;
  const newPattern = /\n---\n\[\[_[^\]]*-master\|[^\]]*\]\]\n?$/;
  return content.replace(oldPattern, "").replace(newPattern, "");
}

/**
 * Return true if the note has a meaningful body — i.e. content beyond blank
 * lines, horizontal rules, and an existing master-note footer.
 *
 * Guards against stamping a "← Master" backlink onto an empty note, which
 * produces a misleading dangling stub (empty body + footer only). Whatever
 * emptied the note, we must not decorate it as if it were a real session.
 */
function hasMeaningfulBody(content: string): boolean {
  const body = content
    .replace(/\n---\n\[\[_[^\]]*-master\|[^\]]*\]\]\n?$/, "") // drop existing master footer
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== "" && t !== "---";
    })
    .join("");
  return body.length > 0;
}

/**
 * Bring a session file's master backlink footer to its canonical form: old or
 * broken footers stripped, the current one present (never on an empty note —
 * that is the dangling-stub signature). Computed in memory and written once,
 * and not at all when the file already matches, so a no-op sync leaves the
 * file untouched. Returns true if the file was modified.
 */
function syncBacklink(filePath: string, slug: string, displayName: string): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  const masterName = masterFilename(slug).replace(/\.md$/, "");
  const sentinel = `[[${masterName}|`;
  let next = stripOldBacklink(content);
  if (hasMeaningfulBody(next) && !next.includes(sentinel)) {
    next += `\n---\n[[${masterName}|← ${displayName} Master]]\n`;
  }
  try {
    return writeIfChanged(filePath, next);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: generateMasterNotes
// ---------------------------------------------------------------------------

/**
 * Generate _master.md files for projects that have >= threshold session files.
 *
 * For each qualifying project, writes a {vaultPath}/{slug}/_master.md containing:
 *   - Project title, session count + date range
 *   - Sessions grouped by YYYY/MM with Obsidian [[wikilinks]]
 *
 * Also appends a backlink footer to each session file (idempotently).
 *
 * @param vaultPath  Absolute path to the PAI Obsidian vault
 * @param registry   Registry backend
 * @param threshold  Minimum session count to generate a master note (default: 5)
 * @returns          Number of master notes written
 */
export async function generateMasterNotes(
  vaultPath: string,
  registry: RegistryBackend,
  threshold = 5
): Promise<number> {
  if (!existsSync(vaultPath)) return 0;

  const projects = await registry.listProjects({ status: "active", orderBy: "slug" });

  let written = 0;

  for (const project of projects) {
    // A row rooted in a worktree must not stamp its slug (the worker id) into
    // notes it shares with the main repo; the merge would publish the footer.
    if (worktreeReason(project.root_path)) continue;
    const slugPath = join(vaultPath, project.slug);
    if (!existsSync(slugPath)) continue;

    // Remove legacy _master.md if present
    const legacyMaster = join(slugPath, "_master.md");
    if (existsSync(legacyMaster)) {
      try { unlinkSync(legacyMaster); } catch { /* Non-fatal */ }
    }

    const sessionFiles = collectSessionFiles(slugPath);
    if (sessionFiles.length < threshold) continue;

    // Sort by yearMonth then basename
    sessionFiles.sort((a, b) => {
      if (a.yearMonth !== b.yearMonth) return a.yearMonth.localeCompare(b.yearMonth);
      return a.basename.localeCompare(b.basename);
    });

    const byMonth = new Map<string, typeof sessionFiles>();
    for (const sf of sessionFiles) {
      if (!byMonth.has(sf.yearMonth)) byMonth.set(sf.yearMonth, []);
      byMonth.get(sf.yearMonth)!.push(sf);
    }

    const firstDate = sessionFiles[0]?.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown";
    const lastDate = sessionFiles[sessionFiles.length - 1]?.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown";

    const lines: string[] = [
      `# Project: ${project.display_name}`,
      "",
      `> Auto-generated by PAI Knowledge OS — ${new Date().toISOString()}`,
      "",
      "## Overview",
      "",
      `- **Sessions:** ${sessionFiles.length}`,
      `- **Date range:** ${firstDate} to ${lastDate}`,
      `- **Tags:** #${project.slug} #project`,
      "",
      "## Sessions by Month",
      "",
    ];

    for (const [ym, files] of byMonth) {
      lines.push(`### ${ym}`, "");
      for (const sf of files) {
        lines.push(`- [[${sf.wikilinkTarget}|${sf.basename}]]`);
      }
      lines.push("");
    }

    lines.push("## Topics", "", `#${project.slug} #project`, "");

    const masterPath = join(slugPath, masterFilename(project.slug));
    try {
      if (writeIfChanged(masterPath, lines.join("\n"))) written++;
    } catch {
      continue;
    }

    for (const sf of sessionFiles) {
      syncBacklink(sf.absPath, project.slug, project.display_name);
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Public: fixSessionTags
// ---------------------------------------------------------------------------

/**
 * Remove the generic #Session tag from session note files across all projects.
 *
 * Scans all session and notes directories for every active project and removes
 * #Session (with or without a trailing space) from any `**Tags:**` line.
 *
 * @param registry  Registry backend
 * @returns   Object with counts: { filesScanned, filesModified, errors }
 */
export async function fixSessionTags(
  registry: RegistryBackend
): Promise<{ filesScanned: number; filesModified: number; errors: string[] }> {
  const results = { filesScanned: 0, filesModified: 0, errors: [] as string[] };

  const projects = await registry.listProjects({ status: "active", orderBy: "slug" });

  for (const project of projects) {
    const dirsToScan: string[] = [];

    // Inline findNotesDir to avoid a circular dependency with symlinks.ts
    const canonical = join(project.root_path, "Notes");
    const alt = join(project.root_path, ".claude", "Notes");
    const notesDir = existsSync(canonical) ? canonical : existsSync(alt) ? alt : null;

    if (notesDir) dirsToScan.push(notesDir);

    if (
      project.claude_notes_dir &&
      existsSync(project.claude_notes_dir) &&
      project.claude_notes_dir !== notesDir
    ) {
      dirsToScan.push(project.claude_notes_dir);
    }

    for (const dir of dirsToScan) {
      const files = walkNotesDir(dir);
      for (const filePath of files) {
        results.filesScanned++;
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch (e) {
          results.errors.push(`${filePath}: read error — ${e}`);
          continue;
        }

        if (!content.includes("#Session")) continue;

        const updated = content.replace(
          /(\*\*Tags:\*\*[^\n]*)#Session ?/g,
          "$1"
        );

        if (updated === content) continue;

        const cleaned = updated.replace(/(\*\*Tags:\*\*) *\n/g, "$1\n");

        try {
          writeIfChanged(filePath, cleaned);
          results.filesModified++;
        } catch (e) {
          results.errors.push(`${filePath}: write error — ${e}`);
        }
      }
    }
  }

  return results;
}
