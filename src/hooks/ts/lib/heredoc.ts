/** The command without heredoc bodies (the lines between a heredoc start and its tag line): their text is prose or data, not commands. */
export function dropHeredocBodies(command: string): string {
  const start = /\x3c{2}(?!\x3c)-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/;
  const kept: string[] = [];
  let tag: string | null = null;
  for (const line of command.split("\n")) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    kept.push(line);
    const h = line.match(start);
    if (h) tag = h[1] ?? h[2] ?? h[3];
  }
  return kept.join("\n");
}