/**
 * Terminal tab title escape sequences (OSC 0/2/30), written directly to
 * stderr. No shell involved, so untrusted title text (derived from user
 * prompts) can't reach a shell for interpolation.
 */

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

export function setTabTitle(title: string): void {
  const sanitized = title.replace(CONTROL_CHARS_RE, '');
  try {
    process.stderr.write(`\x1b]0;${sanitized}\x07`);
    process.stderr.write(`\x1b]2;${sanitized}\x07`);
    process.stderr.write(`\x1b]30;${sanitized}\x07`);
  } catch {
    // Silently fail - don't interrupt Claude's work
  }
}
