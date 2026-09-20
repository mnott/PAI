/**
 * Strip a leading YAML frontmatter block (`---` ... `---` at the very top of
 * the file) and trim surrounding blank lines. A `---` that appears later in
 * the body (not at the top) is left untouched.
 */
export function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = match ? md.slice(match[0].length) : md;
  return body.replace(/^\s+|\s+$/g, '');
}
