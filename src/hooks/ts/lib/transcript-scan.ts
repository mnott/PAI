/**
 * transcript-scan.ts — read a Claude Code transcript (.jsonl) without paying
 * for the whole file on every call.
 *
 * Transcripts only grow by appending, and the hooks that read them run every
 * few minutes for the life of a session. Two primitives keep that cost
 * proportional to what is new (or to what is asked for):
 *
 *   scanIncremental — folds lines into a running state, remembering the byte
 *     offset it stopped at, so the next call parses only the appended lines.
 *   readTailLines   — the last lines of the file, reading backwards from the
 *     end, for callers that only care about the most recent entries.
 *
 * Both fail soft: unreadable file → empty/initial result, never a throw.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bytes read per syscall while scanning forward. Bounds peak memory. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Leading bytes used to tell "same file, grown" from "different file". */
const FINGERPRINT_BYTES = 256;

interface ScanCache<S> {
  version: 1;
  /** Byte offset just past the last complete line folded into `state`. */
  offset: number;
  head: string;
  ino: number;
  state: S;
}

export interface ScanStats {
  /** Bytes actually read from the transcript this call. */
  bytesRead: number;
  /** Lines handed to the folder this call. */
  linesParsed: number;
  /** True when the cache was unusable (absent, shrunk, replaced) and the file was read from byte 0. */
  full: boolean;
}

export interface ScanOptions {
  /** Directory for the cache file. Defaults to the OS temp dir. */
  cacheDir?: string;
  stats?: ScanStats;
}

function cachePath(path: string, kind: string, dir: string): string {
  const key = createHash("sha1").update(`${kind}\0${path}`).digest("hex").slice(0, 16);
  return join(dir, `pai-transcript-scan-${kind}-${key}.json`);
}

function readBytes(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * Fold every complete line of `path` into a state, reading only what was
 * appended since the previous call with the same `kind`.
 *
 * `fold` must mutate/return a JSON-serialisable state; the state is persisted
 * beside the offset. A trailing line without a newline is left for the next
 * call, so a half-written entry is never parsed. If the file shrank, was
 * replaced, or the cache is unreadable, the scan restarts from byte 0 with a
 * fresh `init()`.
 */
export function scanIncremental<S>(
  path: string,
  kind: string,
  init: () => S,
  fold: (state: S, line: string) => S,
  opts: ScanOptions = {}
): S {
  const stats = opts.stats;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return init();
  }

  try {
    const st = statSync(path);
    const size = st.size;
    const ino = st.ino;
    const headLen = Math.min(FINGERPRINT_BYTES, size);
    const head = readBytes(fd, 0, headLen).toString("latin1");

    const dir = opts.cacheDir ?? tmpdir();
    const cfile = cachePath(path, kind, dir);

    let state: S | null = null;
    let offset = 0;
    try {
      if (existsSync(cfile)) {
        const c = JSON.parse(readFileSync(cfile, "utf-8")) as ScanCache<S>;
        if (
          c.version === 1 &&
          c.offset <= size &&
          c.ino === ino &&
          head.startsWith(c.head)
        ) {
          state = c.state;
          offset = c.offset;
        }
      }
    } catch {
      state = null;
    }
    const full = state === null;
    if (state === null) {
      state = init();
      offset = 0;
    }
    if (stats) stats.full = full;

    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const chunk = readBytes(fd, pos, Math.min(CHUNK_BYTES, size - pos));
      if (chunk.length === 0) break;
      if (stats) stats.bytesRead += chunk.length;
      pos += chunk.length;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0) break;
        const line = buf.toString("utf8", start, nl);
        start = nl + 1;
        if (line.trim()) {
          if (stats) stats.linesParsed++;
          state = fold(state, line);
        }
      }
      carry = Buffer.from(buf.subarray(start));
    }
    // Everything except the unterminated tail has been folded.
    const consumed = pos - carry.length;

    try {
      const out: ScanCache<S> = {
        version: 1,
        offset: consumed,
        head: head.slice(0, Math.min(headLen, consumed)),
        ino,
        state,
      };
      mkdirSync(dir, { recursive: true });
      const tmp = `${cfile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), "utf-8");
      renameSync(tmp, cfile);
    } catch {
      // Best-effort — a missing cache only costs a full rescan next time.
    }
    return state;
  } catch {
    return init();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * The last complete lines of a file, oldest first, reading backwards from the
 * end in growing windows until `minLines` lines are available (or the whole
 * file has been read). `wantMore` lets a caller that is searching keep
 * extending the window: it receives the lines read so far and returns true to
 * read further back.
 */
export function readTailLines(
  path: string,
  minLines: number,
  wantMore: (lines: string[]) => boolean = () => false
): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = statSync(path).size;
    let window = 256 * 1024;
    for (;;) {
      const start = Math.max(0, size - window);
      const buf = readBytes(fd, start, size - start);
      let text = buf.toString("utf8");
      // The first line of a mid-file window is probably cut — drop it.
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl < 0 ? "" : text.slice(nl + 1);
      }
      const lines = text.split("\n").filter((l) => l.trim());
      const more = lines.length < minLines || wantMore(lines);
      if (start === 0 || !more) return lines;
      window *= 4;
    }
  } catch {
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}
