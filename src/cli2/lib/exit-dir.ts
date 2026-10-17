/**
 * Print the working directory of a `claude` session that pai launched, right
 * after it exits. This lets the user cd back into the same directory and
 * restart claude to continue — Claude Code's own `--resume` hint is unreliable
 * for this workflow.
 *
 * Why here and not a SessionEnd hook: a hook inside Claude Code is cancelled
 * during teardown (anthropics/claude-code#41577) and races the terminal
 * restore, so it can't reliably print anything. pai spawns the `claude` binary
 * directly (no shell), so the `claude()` shell wrapper never sees pai-launched
 * sessions either. Printing here — after spawnSync has returned and claude has
 * fully exited — is the one place that reliably reaches the terminal.
 */
export function printExitDir(dir: string): void {
  process.stdout.write(
    `\n\x1b[2m📂 Working directory:\x1b[0m ${dir}\n` +
      `\x1b[2m   cd "${dir}"\x1b[0m\n`,
  );
}
