/**
 * pai session restore — put displaced transcripts back where resume looks.
 *
 * PAI moved session transcripts out of `~/.claude/projects/<dir>/` into
 * `<dir>/sessions/`, and `claude --resume <uuid>` reads only the former. The
 * archiver no longer does that (it hardlinks), but the sessions already moved
 * stayed moved — and every checkpoint PAI ever wrote ends with
 * "Resume with: claude --resume <uuid>". For a displaced session that line is an
 * instruction that cannot work, and nothing says so.
 *
 * One project measured 1 transcript at the project root against 52 underneath.
 *
 * So this is a repair, and it is deliberately a COMMAND rather than another hook.
 * Silently relinking dozens of a user's files during an unrelated session start is
 * the same class of mistake as silently moving them was. Dry run is the default;
 * `--execute` is the only thing that touches disk.
 *
 * The link logic itself is imported, not rewritten. Today's other bug was a fix
 * that landed in one of three copies of `probeResume`, so `restoreTopLevel` stays
 * the single implementation.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { restoreTopLevel } from "../../lib/launch.js";
import { claudeProjectsDir } from "../../../registry/moved.js";
import { smartDecodeDir, ok, warn, err, dim, bold } from "../../utils.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DisplacedSession {
  uuid: string;
  /** The `~/.claude/projects/<encoded>` directory holding it. */
  projectDir: string;
  encodedDir: string;
  /** Decoded working directory, when it can be recovered. */
  cwd: string | null;
  bytes: number;
  mtime: number;
  /** Files that tell the user to resume this id — the lie being repaired. */
  promisedBy: string[];
  /**
   * Whether the transcript contains an actual exchange.
   *
   * False means restoring it changes nothing: `claude --resume` answers
   * "No conversation found" for a file with no conversation in it, wherever it
   * sits. Measured 2026-08-04 on 046bb712 — 537 bytes of `last-prompt`,
   * `custom-title`, `agent-name`, `mode`, `permission-mode` and nothing else. It
   * was restored, correctly hardlinked, and still would not resume.
   *
   * Worth reporting rather than hiding, because that id is named in a checkpoint
   * telling the user to resume it. The honest answer is that the session was
   * never there, not that the repair failed.
   */
  hasConversation: boolean;
}

/**
 * Does this transcript hold an exchange, or only session metadata?
 *
 * Reads a bounded head rather than the file: a real session's first assistant
 * line lands within the first few KB, and the alternative is reading 450 MB to
 * print a report. A stub is small by construction, so the whole file is read
 * anyway in the case that matters.
 */
function hasConversation(path: string, maxBytes = 256 * 1024): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    const head = buf.subarray(0, read).toString("utf8");
    return head.includes('"type":"assistant"') || head.includes('"type": "assistant"');
  } catch {
    // Unreadable — assume it is real. Claiming a session is empty when it cannot
    // be inspected would talk the user out of a restore that might work.
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Transcripts that exist under `sessions/` with no twin at the project root.
 *
 * A twin means nothing needs doing: the archiver hardlinks now, so the normal
 * state is both names pointing at one inode. Only the ones missing upstairs were
 * displaced by the old rename.
 */
export function findDisplaced(projectsDir = claudeProjectsDir()): DisplacedSession[] {
  const out: DisplacedSession[] = [];

  let encodedDirs: string[];
  try {
    encodedDirs = readdirSync(projectsDir);
  } catch {
    return out; // no projects dir at all — nothing to repair, not an error
  }

  for (const encodedDir of encodedDirs) {
    const projectDir = join(projectsDir, encodedDir);
    const sessionsDir = join(projectDir, "sessions");
    if (!existsSync(sessionsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(sessionsDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const uuid = file.slice(0, -6);
      if (!UUID_RE.test(uuid)) continue;
      if (existsSync(join(projectDir, file))) continue; // already has its twin

      let bytes = 0;
      let mtime = 0;
      try {
        const st = statSync(join(sessionsDir, file));
        bytes = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue; // vanished under us — nothing to restore
      }

      out.push({
        uuid,
        projectDir,
        encodedDir,
        cwd: smartDecodeDir(encodedDir),
        bytes,
        mtime,
        promisedBy: [],
        hasConversation: hasConversation(join(sessionsDir, file)),
      });
    }
  }

  // Biggest first: transcript size is the best available proxy for how much work
  // is currently unreachable, and it is what makes the report worth reading.
  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Notes that instruct the user to resume this id.
 *
 * Bounded on purpose — the project's own TODO.md and note files, never a search
 * from the home directory. The point is to name the specific promise each
 * restore makes true, so a count of files is not enough.
 */
export function findResumePromises(uuid: string, cwd: string | null): string[] {
  if (!cwd) return [];

  const candidates: string[] = [];
  for (const notesDir of [cwd, join(cwd, "Notes"), join(cwd, "notes")]) {
    try {
      for (const entry of readdirSync(notesDir)) {
        if (entry.endsWith(".md")) candidates.push(join(notesDir, entry));
      }
    } catch {
      /* not a directory here — try the next */
    }
  }

  // Deduplicate by INODE, not by path text and not by realpath.
  //
  // macOS is case-insensitive, so `Notes` and `notes` above are the same
  // directory and every note was reported twice, once per spelling. The obvious
  // fix — resolve with realpathSync and compare — works under Bun and does NOT
  // work under Node, whose non-native realpathSync leaves case alone; the tests
  // caught exactly that split. Identity by (device, inode) is filesystem truth
  // in either runtime, and it collapses symlinks for free, which matters because
  // PAI symlinks note directories into the Obsidian vault.
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const file of candidates) {
    let key: string;
    try {
      const st = statSync(file);
      key = `${st.dev}:${st.ino}`;
    } catch {
      key = file.toLowerCase(); // cannot stat — path text is all that is left
    }
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      if (readFileSync(file, "utf8").includes(uuid)) hits.push(file);
    } catch {
      /* unreadable — silence is right, this is a report not a gate */
    }
  }
  return hits;
}

function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export interface RestoreOptions {
  execute?: boolean;
  json?: boolean;
  /** Only sessions a checkpoint tells the user to resume. */
  promised?: boolean;
  /** Only sessions belonging to this working directory. */
  cwd?: string;
  /** List every displaced session instead of the largest few. */
  all?: boolean;
}

/** How many to list before the report stops being readable. */
const LIST_LIMIT = 20;

export function cmdRestore(opts: RestoreOptions = {}): void {
  const everything = findDisplaced();
  for (const d of everything) {
    d.promisedBy = findResumePromises(d.uuid, d.cwd);
  }

  // Scoping exists because the first real dry run reported 2874 transcripts and
  // 450 MB, machine-wide — not the ~52 of one project we had been reasoning
  // about. Restoring is non-destructive and costs no disk (hardlinks), but
  // relinking 2874 files across every project a user has ever opened is not
  // something to do because they typed a command once, and an unscoped list of
  // 2874 lines is not a report anyone can act on.
  const displaced = everything.filter((d) => {
    if (opts.promised && d.promisedBy.length === 0) return false;
    if (opts.cwd && d.cwd !== opts.cwd) return false;
    return true;
  });

  if (opts.json) {
    console.log(JSON.stringify({ displaced, executed: Boolean(opts.execute) }, null, 2));
    if (opts.execute) for (const d of displaced) restoreTopLevel(d.uuid, d.projectDir);
    return;
  }

  console.log();
  console.log(bold("  Displaced session transcripts"));
  console.log();

  if (displaced.length === 0) {
    if (everything.length > 0) {
      console.log(ok(`  Nothing displaced in this scope.`));
      console.log(dim(`  ${everything.length} displaced elsewhere — drop the filters to see them.`));
    } else {
      console.log(ok("  Nothing displaced — every archived transcript has its twin at the"));
      console.log(dim("  project root, which is where claude --resume looks."));
    }
    console.log();
    return;
  }

  const promised = displaced.filter((d) => d.promisedBy.length > 0);
  const totalBytes = displaced.reduce((n, d) => n + d.bytes, 0);

  console.log(
    warn(
      `  ${displaced.length} transcript(s), ${human(totalBytes)}, currently unresumable.`
    )
  );
  if (displaced.length !== everything.length) {
    console.log(dim(`  (filtered from ${everything.length} machine-wide)`));
  }
  if (promised.length > 0) {
    console.log(
      err(
        `  ${promised.length} named in a checkpoint that tells you to resume them — those lines are lies today.`
      )
    );
  }
  const stubs = displaced.filter((d) => !d.hasConversation);
  if (stubs.length > 0) {
    // Restoring these is harmless and pointless. Saying so is the difference
    // between a report and a sales pitch: `claude --resume` answers
    // "No conversation found" for an empty transcript wherever it sits.
    console.log(
      dim(
        `  ${stubs.length} of them hold no conversation at all — restoring those changes nothing.`
      )
    );
  }
  console.log();

  // Promised ones first regardless of size: a checkpoint pointing at a dead id is
  // the concrete harm, and it is what --promised restores on its own.
  const ordered = [...promised, ...displaced.filter((d) => d.promisedBy.length === 0)];
  const shown = opts.all ? ordered : ordered.slice(0, LIST_LIMIT);

  for (const d of shown) {
    const where = d.cwd ?? dim(`(undecodable: ${d.encodedDir})`);
    const stub = d.hasConversation ? "" : warn("  [stub — no conversation]");
    console.log(
      `  ${bold(d.uuid.slice(0, 8))}  ${human(d.bytes).padStart(8)}  ${where}${stub}`
    );
    for (const file of d.promisedBy) {
      // This is the line the repair makes true again — unless there is nothing
      // in the file, in which case say so rather than implying a recovery.
      console.log(
        d.hasConversation
          ? err(`      promised by  ${file}`)
          : dim(`      promised by  ${file}  (promise cannot be kept: empty transcript)`)
      );
    }
  }

  if (shown.length < ordered.length) {
    console.log();
    console.log(
      dim(`  … and ${ordered.length - shown.length} more. --all lists every one.`)
    );
  }

  console.log();

  if (!opts.execute) {
    console.log(dim("  Dry run — nothing was touched."));
    console.log(dim("  Restore hardlinks each transcript back to the project root: same inode,"));
    console.log(dim("  no copy, and the sessions/ archive is left exactly where it is."));
    console.log();
    console.log(dim("    --promised --execute   just the ones a checkpoint promises (start here)"));
    console.log(dim("    --cwd <path> --execute one project"));
    console.log(dim("    --execute              everything in scope"));
    console.log();
    return;
  }

  let restored = 0;
  const failed: string[] = [];
  for (const d of displaced) {
    if (restoreTopLevel(d.uuid, d.projectDir)) restored++;
    else failed.push(d.uuid);
  }

  console.log(ok(`  Restored ${restored} of ${displaced.length}.`));
  if (failed.length > 0) {
    console.log(warn(`  Could not restore ${failed.length}:`));
    for (const uuid of failed) console.log(dim(`    ${uuid}`));
  }
  console.log();
}
