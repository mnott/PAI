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

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreTopLevel, hasConversation } from "../../lib/launch.js";
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

/*
 * Stub detection lives in launch.ts, imported above, and this is the second time
 * today that duplicating a helper cost real work — so it stays imported.
 *
 * The version that was here read a bounded 256 KB head and looked only for an
 * assistant marker. AIBroker refuted it with measurements and both causes are
 * confirmed on this machine:
 *
 *   b3462801, 867 KB, a session we had BOTH verified claude --resume accepts:
 *     line 1 is 762,976 bytes — one hook-context attachment blob
 *     first "type":"user" at byte 766,830
 *   so any head shorter than 766 KB reports a working session as an empty stub.
 *
 *   b8cd4a5d, 2,626 bytes, 3 user lines and ZERO assistant lines: restored and
 *   probed, claude FINDS it. A user-only transcript is resumable, so requiring an
 *   assistant marker is simply the wrong test.
 *
 * Measured over this project's 52 archived transcripts: head+assistant-only said
 * 20 real / 32 stubs, chunked-full-scan + user-OR-assistant says 33 real / 19
 * stubs. Thirteen disagreements, every one of them head=stub / full=real — a 41%
 * false-stub rate, all in the direction that talks the user out of a recovery.
 * The "745 KB stub" I reported was one of these.
 *
 * Cost is not the tradeoff it looked like: a full scan short-circuits at the
 * first marker, so a real session stops early, and a genuine stub is small
 * enough to read whole. The head read paid 256 KB on every file including the
 * ones it then got wrong.
 */

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
  /**
   * Also restore transcripts with no conversation in them.
   *
   * Off by default because it is pointless work, and because the raw count
   * misrepresents the damage: of 2869 displaced transcripts measured 2026-08-04,
   * 2240 were stubs and only 629 held an actual conversation. 1493 of those stubs
   * came from one probe tool spawning sessions that were never used. Skipping
   * them is what turns "450 MB displaced" into the honest "417 MB recoverable"
   * without a special case for anybody's tooling.
   */
  includeStubs?: boolean;
}

/** How many to list before the report stops being readable. */
const LIST_LIMIT = 20;

/**
 * Which of the displaced sessions a run is about, and which of those to link.
 *
 * Pure, and separate from the printing, for two reasons. The obvious one is that
 * it can be tested without pointing a test at the developer's real
 * `~/.claude/projects` — an earlier draft of the test did exactly that and would
 * have relinked live files. The other is that the report and the action must
 * agree: `--json` originally restored everything in scope while the formatted
 * path skipped stubs, so the two modes did different things with the same flags.
 */
export function selectTargets(
  everything: DisplacedSession[],
  opts: RestoreOptions
): { inScope: DisplacedSession[]; toRestore: DisplacedSession[] } {
  const inScope = everything.filter((d) => {
    if (opts.promised && d.promisedBy.length === 0) return false;
    if (opts.cwd && d.cwd !== opts.cwd) return false;
    return true;
  });

  const toRestore = opts.includeStubs
    ? inScope
    : inScope.filter((d) => d.hasConversation);

  return { inScope, toRestore };
}

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
  const { inScope: displaced, toRestore } = selectTargets(everything, opts);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          displaced,
          // Named so a script can see that stubs were held back, rather than
          // inferring it from a count that does not match.
          wouldRestore: toRestore.map((d) => d.uuid),
          executed: Boolean(opts.execute),
        },
        null,
        2
      )
    );
    if (opts.execute) for (const d of toRestore) restoreTopLevel(d.uuid, d.projectDir);
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

  // Report everything in scope, restore only what restoring can help. A stub is
  // listed above with its label so the picture stays complete, but linking it
  // would be work with a guaranteed null result.
  const target = toRestore;
  const skipped = displaced.length - target.length;

  let restored = 0;
  const failed: string[] = [];
  for (const d of target) {
    if (restoreTopLevel(d.uuid, d.projectDir)) restored++;
    else failed.push(d.uuid);
  }

  console.log(ok(`  Restored ${restored} of ${target.length} recoverable.`));
  if (skipped > 0) {
    console.log(
      dim(`  Skipped ${skipped} stub(s) — nothing in them to resume. --include-stubs overrides.`)
    );
  }
  if (failed.length > 0) {
    console.log(warn(`  Could not restore ${failed.length}:`));
    for (const uuid of failed) console.log(dim(`    ${uuid}`));
  }
  console.log();
}
