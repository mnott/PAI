/**
 * The model that actually served a worker's last turn, read from the worker's
 * Claude Code transcript. The status file only holds the model the run asked
 * for; when the router fails over to the local model the transcript shows it.
 */
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { claudeSessionTranscript } from "./scan.js";
import { shortModel } from "./render.js";

const TAIL_BYTES = 256 * 1024;

/** Model of the last assistant turn in a transcript, null when none is readable. */
export function lastServedModel(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"model"')) continue;
      try {
        const j = JSON.parse(l) as { type?: string; message?: { model?: string } };
        const m = j.message?.model;
        if (m && m !== "<synthetic>") return m;
      } catch {
        /* partial line at the cut */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Serving model of a worker's last turn; null when it has no transcript yet. */
export function servedModelOf(s: { claudeSession?: string | null; cwd: string }, home?: string): string | null {
  if (!s.claudeSession) return null;
  const f = claudeSessionTranscript(s.claudeSession, s.cwd, home);
  return f ? lastServedModel(f) : null;
}

/** True when the serving model differs from the one the run asked for (dates and punctuation ignored). */
export function servedMismatch(asked: string | null | undefined, served: string | null | undefined): boolean {
  if (!asked || !served) return false;
  const n = (m: string) => shortModel(m).toLowerCase().replace(/[^a-z0-9]/g, "");
  return n(asked) !== n(served);
}
