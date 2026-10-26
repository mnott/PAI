const START = /\x3c{2}(?!\x3c)-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/;

/** Drops the body of every heredoc whose start line `keep` rejects (the lines between the start and its tag line). */
function dropBodies(command: string, drop: (startLine: string) => boolean): string {
  const kept: string[] = [];
  let tag: string | null = null;
  for (const line of command.split("\n")) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    kept.push(line);
    const h = line.match(START);
    if (h && drop(line)) tag = h[1] ?? h[2] ?? h[3];
  }
  return kept.join("\n");
}

/** The command without heredoc bodies (the lines between a heredoc start and its tag line): their text is prose or data, not commands. */
export function dropHeredocBodies(command: string): string {
  return dropBodies(command, () => true);
}

// a shell as the consumer: `bash <<EOF`, `sh -s <<EOF`, `cat <<EOF | bash`, `sudo sh <<EOF`
const SHELL_CONSUMER = /(?:^|[|;&(]|\b(?:sudo|exec|env|command))\s*(?:\S*\/)?(?:ba|z|da|k|c|tc|fi)?sh(?![\w.-])/;
// a redirect into a file (not `2>&1`, `>/dev/null`) or `tee <file>`
const FILE_SINK = />>?\s*(?!&|\/dev\/(?:null|stdout|stderr)\b)[^\s|&;<>]|\btee\s+(?:-\w+\s+)*[^\s|;&<>-]/;

/**
 * The command without the bodies of heredocs that only write data to a file (`cat > f <<'EOF'`, `tee f <<EOF`, `> f <<EOF`):
 * their text is file content, not commands, so shell rules and gates must not scan it. A heredoc piped into a shell
 * (`bash <<EOF`, `sh -s <<EOF`, `... | bash`) or into any other consumer keeps its body: that text runs.
 */
export function dropDataHeredocBodies(command: string): string {
  if (!command.includes("<<")) return command;
  return dropBodies(command, (line) => FILE_SINK.test(line) && !SHELL_CONSUMER.test(line));
}
