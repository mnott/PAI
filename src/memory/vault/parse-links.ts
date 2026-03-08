/**
 * Markdown link parser for vault files.
 *
 * Handles wikilinks ([[target]]), markdown links ([text](path)),
 * embeds (![[target]]), and frontmatter wikilinks.
 */

import type { ParsedLink } from "./types.js";

/**
 * Parse all links from markdown content.
 *
 * Handles:
 *  - Standard wikilinks: [[Target Note]]
 *  - Aliased wikilinks: [[Target Note|Display Text]]
 *  - Heading anchors: [[Target Note#Heading]] (stripped for resolution)
 *  - Embeds: ![[Target Note]]
 *  - Frontmatter wikilinks (YAML between --- delimiters)
 *  - Markdown links: [text](path/to/note.md)
 *  - Markdown embeds: ![alt](image.png)
 *
 * External URLs (http://, https://, mailto:, etc.) are excluded — only
 * relative paths are treated as vault links.
 *
 * @param content  Raw markdown file content.
 * @returns        Array of parsed links in document order.
 */
export function parseLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const lines = content.split("\n");

  // Determine frontmatter range (YAML between opening and closing ---)
  let frontmatterEnd = 0;
  if (content.startsWith("---")) {
    const closingIdx = content.indexOf("\n---", 3);
    if (closingIdx !== -1) {
      frontmatterEnd = content.slice(0, closingIdx + 4).split("\n").length - 1;
    }
  }

  // Regex for [[wikilinks]] and ![[embeds]]
  const wikilinkRe = /(!?)\[\[([^\]]+?)\]\]/g;

  // Regex for markdown links [text](target) and embeds ![alt](target)
  const mdLinkRe = /(!)?\[([^\]]*)\]\(([^)]+)\)/g;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const lineNumber = lineIdx + 1; // 1-indexed
    const isFrontmatter = lineIdx < frontmatterEnd;

    // --- Wikilinks ---
    wikilinkRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = wikilinkRe.exec(line)) !== null) {
      const isEmbed = match[1] === "!";
      const inner = match[2]!;

      // Split on first | for alias
      const pipeIdx = inner.indexOf("|");
      const beforePipe = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
      const alias = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1);

      // Strip heading anchor (everything after #)
      const hashIdx = beforePipe.indexOf("#");
      const raw = hashIdx === -1 ? beforePipe.trim() : beforePipe.slice(0, hashIdx).trim();

      if (!raw) continue; // Skip links with empty targets (e.g. [[#Heading]])

      links.push({
        raw,
        alias: alias?.trim() ?? null,
        lineNumber,
        isEmbed: isEmbed && !isFrontmatter,
        isMdLink: false,
      });
    }

    // --- Markdown links --- (skip inside frontmatter)
    if (!isFrontmatter) {
      mdLinkRe.lastIndex = 0;
      while ((match = mdLinkRe.exec(line)) !== null) {
        const isEmbed = match[1] === "!";
        const displayText = match[2]!;
        let target = match[3]!.trim();

        // Skip external URLs
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

        // Skip pure anchor links (#heading)
        if (target.startsWith("#")) continue;

        // Strip heading anchor from target
        const hashIdx = target.indexOf("#");
        if (hashIdx !== -1) target = target.slice(0, hashIdx);

        // URL-decode (Obsidian encodes spaces as %20 in md links)
        try {
          target = decodeURIComponent(target);
        } catch {
          // Malformed encoding — use as-is
        }

        // Strip .md extension for resolution (resolveWikilink adds it back)
        const raw = target.replace(/\.md$/i, "").trim();
        if (!raw) continue;

        links.push({
          raw,
          alias: displayText || null,
          lineNumber,
          isEmbed,
          isMdLink: true,
        });
      }
    }
  }

  return links;
}

/** @deprecated Use {@link parseLinks} instead. */
export const parseWikilinks = parseLinks;
