/**
 * parking.ts — park an idle local conversation to disk while its worker waits on a long build.
 *
 * Strata keeps ONE live conversation (slot 0): the one the engine ran last. `POST /slots/0?action=save`
 * writes exactly that conversation to <slot-save-path>/<filename>, `action=restore` loads a file back into
 * slot 0 (63k tokens: save 0.7 s, restore 0.9 s, against ~0.9 s per 1k tokens to re-read an evicted one). The API
 * cannot address any other conversation, so a save is only right in the window between a worker's last response
 * and the next request of anyone else: the scheduler calls maybePark() from release() while it still holds the
 * engine. At that moment the gate ticket does not exist yet (the response is the tool call that will create it),
 * so the router tells the scheduler a response ended in a `pai build` call and the expected duration is the p50 of
 * the worker's previous gate key (a ticket naming it, if already there), else the median over all keys.
 *
 * Needs the engine started with --slot-save-path; checkParking() reports when it was not. Nothing here throws
 * into a request: every failure is logged and the request goes on as a normal (re-reading) one.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { buildsDir, listBuildsSync, type BuildTicket } from "../builds/queue.js";
import { durationP50, overallP50 } from "../builds/durations.js";
import { paiHomeDir } from "../config/pai-home.js";

export interface ParkConfig {
  enabled: boolean;
  /** park only when the expected build wait exceeds this */
  parkAfterSec: number;
}

/**
 * The fallback used when the config cannot be read. The policy values live in
 * the shipped defaults file (src/config/defaults/config.yaml, `router.parking`)
 * and reach the parker through `loadConfig().router.parking` → `parkConfigFrom`.
 */
export const DEFAULT_PARK: ParkConfig = { enabled: false, parkAfterSec: 120 };
export const NO_SAVE_PATH = "parking unavailable: engine has no slot save path";
const PROBE_FILE = "pai-park-probe-none.bin";

export function parkConfigFrom(raw: unknown): ParkConfig {
  const out = { ...DEFAULT_PARK };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.parkAfterSec === "number" && Number.isFinite(r.parkAfterSec) && r.parkAfterSec >= 0) out.parkAfterSec = r.parkAfterSec;
  return out;
}

export const slotsDir = (): string => join(paiHomeDir(), "state", "strata-slots");

export interface ParkDeps {
  dir: string;
  buildsDir: string;
  tickets: () => BuildTicket[];
  /** the engine's conversation cache is at capacity (waiting workers count regardless) */
  cachePressure: (engine: string) => boolean;
  post: (url: string, body: unknown) => Promise<{ status: number; ms: number }>;
  log: (line: string) => void;
}

async function httpPost(url: string, body: unknown): Promise<{ status: number; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  await r.arrayBuffer().catch(() => undefined);
  return { status: r.status, ms: Date.now() - t0 };
}

export interface Parked {
  file: string;
  engine: string;
  at: number;
}

export class Parker {
  private origins = new Map<string, string>();
  private parked = new Map<string, Parked>();
  private lastKey = new Map<string, string>();
  private avail = new Map<string, { at: number; reason?: string }>();

  constructor(private cfg: () => ParkConfig = () => DEFAULT_PARK, private d: ParkDeps = defaultDeps()) {}

  noteEngine(engine: string, origin: string): void {
    this.origins.set(engine, origin);
  }

  parkedWorkers(): Record<string, Parked> {
    return Object.fromEntries(this.parked);
  }

  /** null when the engine can save and restore slots, else why not (cached 60 s). Never throws. */
  async checkParking(origin: string, now = Date.now()): Promise<string | null> {
    const hit = this.avail.get(origin);
    if (hit && now - hit.at < 60_000) return hit.reason ?? null;
    let reason: string | undefined;
    try {
      const r = await this.d.post(`${origin}/slots/0?action=restore`, { filename: PROBE_FILE }); // 404: save path set, file absent
      if (r.status === 501) reason = NO_SAVE_PATH;
      else if (r.status !== 404 && r.status !== 400) reason = `parking unavailable: engine answered ${r.status} to a slot probe`;
    } catch (e) {
      reason = `parking unavailable: ${(e as Error).message}`;
    }
    if (reason && reason !== hit?.reason) this.d.log(`${new Date().toISOString()} ${reason}`);
    this.avail.set(origin, { at: now, reason });
    return reason ?? null;
  }

  private expectedSec(worker: string): number | undefined {
    const mine = this.d.tickets().find((t) => t.worker === worker && t.key);
    const key = mine?.key ?? this.lastKey.get(worker);
    if (mine?.key) this.lastKey.set(worker, mine.key);
    return (key ? durationP50(this.d.buildsDir, key) : undefined) ?? overallP50(this.d.buildsDir);
  }

  /**
   * Called by the scheduler while it still holds the engine after `worker`'s response ended in a build-gate
   * call. Saves the engine's conversation (still `worker`'s) when the build is long and the engine is under pressure.
   */
  async maybePark(engine: string, worker: string, waiting: number): Promise<void> {
    try {
      const cfg = this.cfg();
      const origin = this.origins.get(engine);
      if (!cfg.enabled || !origin) return;
      if (!waiting && !this.d.cachePressure(engine)) return;
      const sec = this.expectedSec(worker);
      if (sec === undefined || sec <= cfg.parkAfterSec) return;
      if (await this.checkParking(origin)) return;
      mkdirSync(this.d.dir, { recursive: true });
      const file = `${worker.replace(/[^A-Za-z0-9_.-]/g, "_")}.bin`;
      const r = await this.d.post(`${origin}/slots/0?action=save`, { filename: file });
      if (r.status >= 300) return this.d.log(`${new Date().toISOString()} park ${worker}: save answered ${r.status}; not parked`);
      this.parked.set(worker, { file, engine, at: Date.now() });
      this.d.log(`${new Date().toISOString()} parked ${worker} to ${file} in ${r.ms}ms (build ~${Math.round(sec)}s)`);
    } catch (e) {
      this.d.log(`${new Date().toISOString()} park ${worker} failed: ${(e as Error).message}`);
    }
  }

  /** Before forwarding a parked worker's request (engine held): put its conversation back unless the slot still has it. */
  async restoreIfParked(engine: string, worker: string, slotHolder: string | undefined): Promise<void> {
    const p = this.parked.get(worker);
    if (!p) return;
    this.parked.delete(worker);
    const origin = this.origins.get(p.engine);
    try {
      if (slotHolder === worker || !origin) return;
      const r = await this.d.post(`${origin}/slots/0?action=restore`, { filename: p.file });
      if (r.status >= 300) this.d.log(`${new Date().toISOString()} restore ${worker}: answered ${r.status}; re-reading instead`);
      else this.d.log(`${new Date().toISOString()} restored ${worker} from ${p.file} in ${r.ms}ms`);
    } catch (e) {
      this.d.log(`${new Date().toISOString()} restore ${worker} failed (${(e as Error).message}); re-reading instead`);
    } finally {
      try {
        unlinkSync(join(this.d.dir, p.file));
      } catch {
        /* the engine writes under its own path; ours may differ */
      }
    }
  }

  /** Drop leftover session files of a previous router run (they are 1 GB-class). */
  sweep(): void {
    try {
      if (existsSync(this.d.dir)) for (const f of readdirSync(this.d.dir)) if (f.endsWith(".bin")) unlinkSync(join(this.d.dir, f));
    } catch {
      /* best effort */
    }
  }
}

function defaultDeps(): ParkDeps {
  return {
    dir: slotsDir(),
    buildsDir: buildsDir(),
    tickets: () => {
      try {
        return listBuildsSync(buildsDir());
      } catch {
        return [];
      }
    },
    cachePressure: () => false,
    post: httpPost,
    log: (l) => process.stderr.write(l + "\n"),
  };
}

let shared: Parker | null = null;
let parkCfg: () => ParkConfig = () => DEFAULT_PARK;

export function sharedParker(): Parker {
  if (!shared) shared = new Parker(() => parkCfg());
  return shared;
}

export function setParkConfigSource(src: () => ParkConfig): void {
  parkCfg = src;
}
