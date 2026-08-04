/**
 * registrable.ts — directories that must never become registered projects.
 *
 * A project is a durable thing. The registry, however, has been accepting
 * whatever directory a session happened to start in, and some of those
 * directories are disposable by construction. Measured on the real registry,
 * 2026-08-04:
 *
 *   08 - Others/MDF/Infrastruktur/.claude/worktrees/cool-haibt      1 session
 *   08 - Others/MDF/Infrastruktur/.claude/worktrees/strange-haibt   7 sessions
 *   /private/tmp/ops-webui                                          dead
 *   /private/tmp/claude-501/-Users-…-AIBroker/aae854c6-…            dead
 *
 * The worktrees are agent isolation directories, created to be removed. The temp
 * paths are exactly what their name says. Registering them attributes session
 * history to a location with no future, and lets `pai <name>` route someone into
 * a directory a cleanup can delete underneath them.
 *
 * So this refuses at the point of registration rather than reclassifying
 * afterwards. It is a guard, not a policy about what health should call things —
 * it stops the set growing while the vocabulary question (dead vs duplicate vs
 * misnamed vs ephemeral) is decided separately.
 *
 * Found by the AIBroker session while we were dividing up the dead-path work.
 */

import { sep } from "node:path";

/** Path fragments that mark a location as disposable, with why. */
const EPHEMERAL: ReadonlyArray<{ fragment: string; because: string }> = [
  {
    // Agent worktrees. `.claude/worktrees/<name>` is created for isolation during
    // one task and removed afterwards.
    fragment: `${sep}.claude${sep}worktrees${sep}`,
    because: "a git worktree created for agent isolation — it is meant to be removed",
  },
  {
    fragment: `${sep}private${sep}tmp${sep}`,
    because: "a system temp directory",
  },
  {
    fragment: `${sep}var${sep}folders${sep}`,
    because: "a macOS per-user temp directory",
  },
];

/**
 * Why this path cannot be a project, or undefined if it can.
 *
 * Returns the reason rather than a boolean so the caller can tell the user which
 * rule caught them — "refused" without a reason invites someone to work around it
 * rather than move their project somewhere durable.
 */
export function unregistrableReason(rootPath: string): string | undefined {
  // Compare with trailing separators so a fragment cannot match a partial
  // directory name: `/tmp/` must not match `/tmpdir/`.
  const padded = rootPath.endsWith(sep) ? rootPath : rootPath + sep;

  for (const { fragment, because } of EPHEMERAL) {
    if (padded.includes(fragment)) return because;
  }

  // A bare `/tmp/...` too. Kept separate from the list above because on macOS
  // /tmp is a symlink to /private/tmp, so both spellings reach the same place and
  // only one of them contains "private".
  if (padded.startsWith(`${sep}tmp${sep}`)) return "a system temp directory";

  return undefined;
}
