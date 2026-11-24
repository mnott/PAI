/**
 * log-rotate.ts — size-based rotation for the unbounded process logs.
 *
 * daemon.log and scheduler.log are the launchd StandardOutPath, router.log is
 * the stdout/stderr of the detached router (spawnRouter opens it with "a"). In
 * all three the file descriptor belongs to another process, so a rename would
 * leave the writer appending to the renamed file. Rotation is therefore
 * copytruncate: gzip the current content into <name>.1.gz (older archives shift
 * up, the one beyond `keep` is dropped), then cut the live file down to its
 * newest TAIL_KEEP_BYTES so the writer keeps its fd and the recent lines stay.
 */

import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, ftruncateSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { paiHomePath } from "../config/pai-home.js";

export const DEFAULT_LOG_MAX_MB = 50;
export const DEFAULT_LOG_KEEP = 3;
/** The newest part that always stays in the live file. */
export const TAIL_KEEP_BYTES = 10 * 1024 * 1024;
export const LOG_ROTATE_TICK_MS = 60 * 60 * 1000;
export const ROTATED_LOGS = ["daemon.log", "router.log", "scheduler.log"];

export interface LogsConfig { maxMB?: number; keep?: number }

/** Rotates `file` when it is over maxBytes. Returns true when it rotated. */
export async function rotateLog(file: string, maxBytes: number, keep: number, tailBytes = TAIL_KEEP_BYTES): Promise<boolean> {
  if (!existsSync(file) || statSync(file).size <= maxBytes) return false;
  const size = statSync(file).size;
  const n = Math.max(1, Math.floor(keep));
  const rm = (p: string) => { try { unlinkSync(p); } catch { /* absent */ } };
  rm(`${file}.${n}.gz`);
  for (let i = n - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}.gz`)) renameSync(`${file}.${i}.gz`, `${file}.${i + 1}.gz`);
  }
  const tmp = `${file}.1.gz.tmp`;
  await pipeline(createReadStream(file, { start: 0, end: size - 1 }), createGzip(), createWriteStream(tmp));
  renameSync(tmp, `${file}.1.gz`);
  // Cut the live file to its newest part, in place: the writer's fd stays valid.
  const fd = openSync(file, "r+");
  try {
    const cur = fstatSync(fd).size;
    const keepLen = Math.min(tailBytes, cur);
    const buf = Buffer.alloc(keepLen);
    let got = 0;
    while (got < keepLen) {
      const r = readSync(fd, buf, got, keepLen - got, cur - keepLen + got);
      if (r <= 0) break;
      got += r;
    }
    // start at a line boundary
    let off = 0;
    if (keepLen < cur) { const nl = buf.indexOf(10); if (nl >= 0 && nl < got - 1) off = nl + 1; }
    ftruncateSync(fd, 0);
    writeSync(fd, buf, off, got - off, 0);
  } finally { closeSync(fd); }
  return true;
}

export async function rotateLogsIn(dir: string, cfg: LogsConfig = {}, names = ROTATED_LOGS): Promise<string[]> {
  const maxBytes = (cfg.maxMB ?? DEFAULT_LOG_MAX_MB) * 1024 * 1024;
  const keep = cfg.keep ?? DEFAULT_LOG_KEEP;
  const done: string[] = [];
  for (const n of names) {
    try { if (await rotateLog(join(dir, n), maxBytes, keep)) done.push(n); } catch { /* next hour */ }
  }
  return done;
}

export function startLogRotation(cfg: () => LogsConfig, log: (l: string) => void): void {
  const tick = () => void rotateLogsIn(paiHomePath("logs"), cfg()).then((d) => { if (d.length) log(`rotated ${d.join(", ")}`); });
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, LOG_ROTATE_TICK_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
}
