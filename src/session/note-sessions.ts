/**
 * note-sessions.ts — which Claude session ids a session note covers.
 *
 * Notes carry them in a minimal YAML frontmatter block (`sessions: [<uuid>, ...]`). A note can span a
 * resumed or continued session, so ids are only ever appended. Notes without frontmatter get a block
 * holding just this key; any other frontmatter keys are left as they are. The memory indexer, the
 * wikilink parser and Obsidian all accept a leading `---` block.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
const KEY = /^sessions:[ \t]*\[([^\]]*)\][ \t]*$/m;

/** Session ids named in the note's frontmatter, in recorded order. */
export function parseNoteSessions(content: string): string[] {
  const fm = content.match(FM);
  const m = fm?.[1].match(KEY);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter((s) => UUID.test(s));
}

/** `content` with `id` appended to the frontmatter sessions list; unchanged when already there or not a UUID. */
export function withNoteSession(content: string, id: string): string {
  id = id.trim().toLowerCase();
  if (!UUID.test(id) || id.length !== 36) return content;
  const have = parseNoteSessions(content);
  if (have.includes(id)) return content;
  const line = `sessions: [${[...have, id].join(", ")}]`;
  const fm = content.match(FM);
  if (!fm) return `---\n${line}\n---\n${content}`;
  const body = KEY.test(fm[1]) ? fm[1].replace(KEY, line) : `${fm[1]}\n${line}`;
  return `---\n${body}\n---${fm[2] || "\n"}${content.slice(fm[0].length)}`;
}

/** Record `id` in the note file. Returns true when the file changed. Never throws. */
export function addNoteSession(notePath: string, id: string | undefined): boolean {
  if (!id) return false;
  try {
    const cur = readFileSync(notePath, "utf8");
    const next = withNoteSession(cur, id);
    if (next === cur) return false;
    const tmp = `${notePath}.sessions.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, notePath);
    return true;
  } catch {
    return false;
  }
}
