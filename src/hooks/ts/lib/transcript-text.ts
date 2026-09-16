/**
 * transcript-text.ts — small, pure pieces of transcript parsing that are
 * worth testing in isolation.
 *
 * Split out of context-compression-hook.ts (a hook entrypoint that calls
 * `main()` and `process.exit()` at import time, which makes it unsafe to
 * import directly from a test) so the two bug fixes that live here can be
 * covered by a real regression test rather than only a manual before/after
 * digest.
 */

/**
 * Turn Claude content (string or content block array) into plain text.
 *
 * BUG (found in ~1 in 4 injected digests on this machine): a "user" turn is
 * not always something the user typed — a tool_result is also delivered as a
 * user-role message, and its `content` block looks like
 * `{ type: "tool_result", content: [...] }` where the inner `content` is
 * itself an array of blocks, not a string. The old code fell back to
 * `String(c.content)` for anything without a `.text` field, and `String()`
 * on an array of objects produces literal `"[object Object],[object
 * Object]"` — which is exactly what showed up under "Recent user requests".
 * Only ever take the `.text` of a `type: "text"` block; everything else
 * (tool_use, tool_result, image, and any nested content) is ignored rather
 * than stringified.
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') {
          return c.text;
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * True for a modified-file path that is noise for a handover, not signal.
 *
 * BUG: a real digest showed 8 of 10 "Files modified" slots filled with
 * throwaway paths under a jobs/<id>/tmp/ directory (msg8.txt, msg9.txt …),
 * crowding out the two real source files also edited that session. Anything
 * under a `tmp/`, `jobs/`, or `scratchpad/` path segment is excluded — those
 * are working scratch space, not the codebase the next session needs to
 * remember it touched.
 */
export function isNoiseFilePath(filePath: string, scratchpadDir?: string): boolean {
  if (scratchpadDir && filePath.startsWith(scratchpadDir)) return true;
  const segments = filePath.split('/');
  return segments.includes('tmp') || segments.includes('jobs') || segments.includes('scratchpad');
}

/**
 * Order a modified-file list so entries inside `cwd` are preferred when a
 * caller has to truncate to a fixed slot count — an unrelated repo touched
 * in passing should not crowd out the files that actually matter for this
 * session's working directory.
 */
export function preferCwdFiles(files: string[], cwd?: string): string[] {
  if (!cwd) return files;
  const inCwd = files.filter((f) => f.startsWith(cwd));
  const outCwd = files.filter((f) => !f.startsWith(cwd));
  return [...inCwd, ...outCwd];
}
