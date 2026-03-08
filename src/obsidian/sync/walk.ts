/** Directory walking and session file discovery for vault note generation. */

import {
  existsSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { SessionFile } from "./types.js";

export const SESSION_FILENAME_RE = /^(\d{4}) - (\d{4}-\d{2})-\d{2} - .+\.md$/;

/**
 * Walk a directory (non-recursive root level, then one level of YYYY/MM subdirs).
 * Returns absolute paths to all .md files found, skipping master note files.
 */
export function walkNotesDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    // Skip any master note file (pattern: _{slug}-master.md or legacy _master.md)
    if (entry === "_master.md" || /^_[^/]+-master\.md$/.test(entry)) continue;
    const full = join(dir, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (/^\d{4}$/.test(entry)) {
        let monthEntries: string[];
        try {
          monthEntries = readdirSync(full);
        } catch {
          continue;
        }
        for (const month of monthEntries) {
          const monthPath = join(full, month);
          if (/^\d{2}$/.test(month) && existsSync(monthPath)) {
            let monthFiles: string[];
            try {
              monthFiles = readdirSync(monthPath);
            } catch {
              continue;
            }
            for (const f of monthFiles) {
              if (f.endsWith(".md") && !f.startsWith(".")) {
                results.push(join(monthPath, f));
              }
            }
          }
        }
      }
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract YYYY/MM from a session file path.
 * Tries the path first (/YYYY/MM/ pattern), then falls back to filename date.
 */
export function extractYearMonth(filePath: string): string {
  const pathMatch = filePath.match(/\/(\d{4})\/(\d{2})\//);
  if (pathMatch) return `${pathMatch[1]}/${pathMatch[2]}`;

  const basename = filePath.split("/").pop() ?? "";
  const nameMatch = basename.match(/^\d{4} - (\d{4})-(\d{2})-\d{2}/);
  if (nameMatch) return `${nameMatch[1]}/${nameMatch[2]}`;

  return "unknown";
}

/**
 * Collect all session .md files from the notes and sessions symlinks
 * inside a vault project directory.
 */
export function collectSessionFiles(slugPath: string): SessionFile[] {
  const sessionFiles: SessionFile[] = [];
  const subLinks = ["notes", "sessions"];

  for (const subLink of subLinks) {
    const linkPath = join(slugPath, subLink);
    if (!existsSync(linkPath)) continue;

    let realDir: string;
    try {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        realDir = readlinkSync(linkPath);
      } else if (stat.isDirectory()) {
        realDir = linkPath;
      } else {
        continue;
      }
    } catch {
      continue;
    }

    const files = walkNotesDir(realDir);
    for (const absPath of files) {
      const basename = absPath.split("/").pop() ?? "";
      if (!SESSION_FILENAME_RE.test(basename)) continue;

      const relFromReal = relative(realDir, absPath);
      const vaultRelPath = `${subLink}/${relFromReal}`;
      const wikilinkTarget = vaultRelPath.replace(/\.md$/, "");

      sessionFiles.push({
        absPath,
        vaultRelPath,
        wikilinkTarget,
        yearMonth: extractYearMonth(absPath),
        basename: basename.replace(/\.md$/, ""),
      });
    }
  }

  return sessionFiles;
}
