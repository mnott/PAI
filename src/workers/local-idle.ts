/**
 * local-idle.ts — the local model must not sit idle while workers build.
 * Incident 2026-10-20: both workers of the local engine were inside build-gate jobs, the GPU read 0 %,
 * two slots were free and nothing was queued. The daemon samples every 30 s (GPU utilisation, what each
 * running local worker is doing, free slots, queued local work); when the GPU stays under the threshold
 * for `minutes`, every running local worker is blocked in a build/test (or none runs), a slot is free and
 * nothing local is queued, it nudges each owning session (every backoff while the spell lasts, max 6 per hour) and writes LOCAL-IDLE to the
 * ledger. The latest sample is persisted for `pai worker ps` and the cockpit. Read-only towards the engine.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBuildsSync, ticketKind, buildsDir, type BuildTicket } from "../builds/queue.js";
import { providerCap, queueRows } from "./capacity.js";
import { defaultWorkersConfig, isLocalProvider, type WorkersConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { eventLine, type Messenger } from "./run-events.js";
import { isLocalCandidate, tierProviderNames } from "./local-candidate.js";
import { readLocalStatus, type LocalStatus } from "./local-status.js";
import { holdsSlot, isChatPane, isLive, pausedFree, loadStatusesCached, ownsPidCached, type WorkerStatus } from "./status.js";
import { packageRoot } from "../module-paths.js";

export interface LocalIdleConfig {
  enabled: boolean;
  /** GPU "Device Utilization %" under which the engine counts as idle. */
  gpuBelowPct: number;
  /** Minutes the GPU must stay idle before the nudge. */
  minutes: number;
  /** Minutes before the same provider may nudge again. */
  backoffMinutes: number;
}


export type Activity = "build" | "test" | "generating";

export interface LocalWorker {
  id: string;
  activity: Activity;
  /** Where a nudge goes: the owning session. */
  iterm?: string;
  name?: string;
  /** Claude Code session of the orchestrator that spawned the worker (fallback owner). */
  claudeSession?: string;
}

/** AIBroker targets the bare iTerm session uuid; a status `term` is ITERM_SESSION_ID ("w8t0p0:<uuid>"). */
export const itermUuid = (term: string | undefined | null): string | undefined => term?.split(":").pop() || undefined;

/** The owning session of a worker status: its terminal uuid, its session name, its spawning Claude session. */
export function ownerOf(s: Pick<WorkerStatus, "term" | "session" | "spawnerSession" | "claudeSession">): { iterm?: string; name?: string; claudeSession?: string } {
  return { iterm: itermUuid(s.term), name: s.session?.name || undefined, claudeSession: s.spawnerSession || undefined };
}

export interface LocalProviderSample {
  provider: string;
  cap: number;
  workers: LocalWorker[];
  queued: number;
  /** Running but parked by pause (slot not held): shown apart from the slot count. */
  paused?: number;
  /** Started jobs without a slot: waiting on a long tool run, or in line for a slot back. holders + lent = the running rows. */
  lent?: number;
  /** Tickets of started jobs (they hold a ticket to get a slot back): counted apart from `queued`, which counts not-started jobs only (the table's waiting rows). */
  startedHoldingTicket?: number;
}

export interface LocalSample {
  at: number;
  /** null: not measurable (other platform, ioreg failed). */
  gpuPct: number | null;
  providers: LocalProviderSample[];
}

export interface LocalIdleState {
  /** Epoch ms since which the GPU has read idle without a break; null = not idle. */
  idleSince: number | null;
  /** provider -> epoch ms of the last nudge. */
  lastNudge: Record<string, number>;
  /** session key -> epoch ms of the nudges sent in the last hour (cap per session). */
  sent?: Record<string, number[]>;
}

export const MAX_NUDGES_PER_HOUR = 6;

export interface Nudge {
  provider: string;
  free: number;
  workers: LocalWorker[];
  /** One entry per owning session. */
  targets: Array<{ iterm?: string; name?: string; claudeSession?: string; ids: string[] }>;
}

/** "Device Utilization %"=N out of `ioreg -r -d 1 -c IOAccelerator`; null when absent. */
export function parseGpuUtilization(out: string): number | null {
  const m = /"Device Utilization %"\s*=\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export function readGpuUtilization(): Promise<number | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], { timeout: 5000 }, (err, stdout) => resolve(err ? null : parseGpuUtilization(stdout)));
  });
}

// ---------------------------------------------------------------------------
// the fast GPU sampler: one ioreg every ~5 s, kept in a window of instants
// ---------------------------------------------------------------------------

/** One instant read with its timestamp. */
export interface GpuInstant {
  t: number;
  pct: number;
}

/** Keep at most this many instants (~2 min at the 5 s cadence). */
const GPU_WINDOW_MAX = 30;
let gpuWindow: GpuInstant[] = [];
let gpuSamplerTimer: ReturnType<typeof setInterval> | null = null;

/** Record one instant read (a failed read records nothing); returns the window size. */
export function recordGpuInstant(t: number, pct: number | null): number {
  if (pct !== null) {
    gpuWindow.push({ t, pct });
    if (gpuWindow.length > GPU_WINDOW_MAX) gpuWindow = gpuWindow.slice(-GPU_WINDOW_MAX);
  }
  return gpuWindow.length;
}

/** The recorded instants, oldest first. */
export function gpuInstants(): GpuInstant[] {
  return [...gpuWindow];
}

/** Avg and peak percent over the instants in [now-windowMs, now]; null values with no sample in the window. */
export function gpuStats(now: number, windowMs: number): { avg: number | null; peak: number | null } {
  const inWin = gpuWindow.filter((x) => x.t >= now - windowMs);
  if (!inWin.length) return { avg: null, peak: null };
  let s = 0;
  let p = 0;
  for (const x of inWin) {
    s += x.pct;
    if (x.pct > p) p = x.pct;
  }
  return { avg: Math.round((s / inWin.length) * 10) / 10, peak: p };
}

/** Drop instants older than ~2 min; the window is empty when the sampler stopped. */
export function resetGpuWindow(): void {
  gpuWindow = [];
}

/**
 * The daemon's fast GPU sampler: one `ioreg -r -d 1 -c IOAccelerator` every
 * intervalMs (default 5 s) into the window above. A single subprocess for the
 * whole daemon — the cockpit and the local-model line read the window, never ioreg.
 * Returns the stop function.
 */
export function startGpuSampler(intervalMs = 5_000, read: () => Promise<number | null> = readGpuUtilization, now: () => number = Date.now): () => void {
  if (gpuSamplerTimer) clearInterval(gpuSamplerTimer);
  const tick = async () => {
    try {
      recordGpuInstant(now(), await read());
    } catch {
      /* a failed read just thins the window */
    }
  };
  void tick();
  gpuSamplerTimer = setInterval(() => void tick(), intervalMs);
  gpuSamplerTimer.unref();
  return () => {
    if (gpuSamplerTimer) clearInterval(gpuSamplerTimer);
    gpuSamplerTimer = null;
  };
}

// ---------------------------------------------------------------------------
// the SoC temperature sampler: tools/pai-sensors once per 30 s, no retry loop
// ---------------------------------------------------------------------------

/** One SoC temperature reading with its timestamp (°C). */
export interface SocTempReading {
  at: number;
  maxC: number;
  avgC: number;
  sensors: number;
}

/** Why the last helper run produced nothing, beside the last good value. */
let socTempError = "";
let socTempLast: SocTempReading | null = null;
let socTempTimer: ReturnType<typeof setInterval> | null = null;

/** The one-shot helper binary (built like tools/apple-fm-bridge: `swift build -c release`). */
export const paiSensorsPath = (): string => join(packageRoot(import.meta.url), "tools", "pai-sensors", ".build", "release", "pai-sensors");

/** The helper's JSON line → a reading; null on any malformed/failed output. */
export function parseSocTempJson(out: string): SocTempReading | null {
  try {
    const j = JSON.parse(out.trim()) as { socTempC?: unknown; socTempAvgC?: unknown; sensors?: unknown };
    if (typeof j.socTempC !== "number" || !Number.isFinite(j.socTempC) || typeof j.socTempAvgC !== "number") return null;
    return { at: Date.now(), maxC: j.socTempC, avgC: j.socTempAvgC, sensors: typeof j.sensors === "number" ? j.sensors : 0 };
  } catch {
    return null;
  }
}

/** Run the helper once (2 s timeout); a missing binary is a permanent reason, never retried in a loop. */
export function readSocTemp(path = paiSensorsPath()): Promise<SocTempReading | null> {
  if (!existsSync(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(path, [], { timeout: 2_000 }, (err, stdout) => resolve(err ? null : parseSocTempJson(stdout)));
  });
}

/** Record one helper run; a failed read keeps the last value and stores the reason. */
export function recordSocTemp(t: number, r: SocTempReading | null): void {
  if (r) {
    socTempLast = { ...r, at: t };
    socTempError = "";
  } else if (!socTempError) {
    socTempError = existsSync(paiSensorsPath()) ? "helper failed (no plausible reading)" : "helper not built: cd tools/pai-sensors && swift build -c release";
  }
}

export function socTempState(): { last: SocTempReading | null; error: string } {
  return { last: socTempLast, error: socTempError };
}

/** Reset the sampler's state (tests). */
export function resetSocTempState(): void {
  socTempLast = null;
  socTempError = "";
}

/**
 * The daemon's SoC temperature sampler: one `tools/pai-sensors` run every
 * intervalMs (default 30 s) — a one-shot IOKit HID read, no sudo, no resident
 * process. A failed run keeps the last value and its reason; there is no retry
 * loop beyond the cadence itself. Returns the stop function.
 */
export function startSocTempSampler(intervalMs = 30_000, read: () => Promise<SocTempReading | null> = readSocTemp, now: () => number = Date.now): () => void {
  if (socTempTimer) clearInterval(socTempTimer);
  const tick = async () => {
    try {
      recordSocTemp(now(), await read());
    } catch {
      recordSocTemp(now(), null);
    }
  };
  void tick();
  socTempTimer = setInterval(() => void tick(), intervalMs);
  socTempTimer.unref();
  return () => {
    if (socTempTimer) clearInterval(socTempTimer);
    socTempTimer = null;
  };
}

const BUILD_LAST = /\b(build\.sh|install\.sh|xcodebuild|gradlew?|cargo build|npm run build|make)\b/;
const TEST_LAST = /\b(vitest|jest|pytest|npm (run )?test|bun test|cargo test|go test)\b/;

/** What a running worker is doing: a build-gate ticket of its own, else the shape of its last tool, else generating. */
export function activityOf(s: Pick<WorkerStatus, "id" | "last">, tickets: BuildTicket[]): Activity {
  const t = tickets.find((x) => x.worker === s.id);
  if (t) return ticketKind(t) === "test" ? "test" : "build";
  if (TEST_LAST.test(s.last ?? "")) return "test";
  if (BUILD_LAST.test(s.last ?? "")) return "build";
  return "generating";
}

/** The sample from disk: statuses, build tickets and the provider queue. */
export async function takeSample(logDir: string, workers: WorkersConfig, now = Date.now(), gpu: () => Promise<number | null> = readGpuUtilization, status: LocalStatus | null = readLocalStatus(logDir, now)): Promise<LocalSample> {
  let tickets: BuildTicket[] = [];
  try {
    tickets = listBuildsSync(buildsDir());
  } catch {
    /* no build dir yet */
  }
  const statuses = loadStatusesCached(logDir).filter((s) => !isChatPane(s) && isLive(s, ownsPidCached) && s.state === "running");
  const queue = queueRows(logDir);
  const providers: LocalProviderSample[] = [];
  const tiers = tierProviderNames();
  for (const [name, p] of Object.entries(workers.providers)) {
    if (!isLocalProvider(p.baseUrl)) continue;
    const cap = providerCap(workers, name);
    if (cap === undefined) continue;
    const onProv = statuses.filter((s) => s.provider === name);
    const mine = onProv.filter((s) => holdsSlot(s, now));
    const paused = onProv.filter((s) => !!s.paused).length;
    const lent = onProv.filter((s) => !holdsSlot(s, now) && !pausedFree(s)).length;
    // the line counts what the table's rows show: "N waiting" = not-started jobs only; a started job that holds a ticket (to get its slot back) is a running row and counts in the `startedHoldingTicket` part instead.
    const ticketed = new Set(statuses.filter((s) => s.provider === name && s.state === "running" && !s.paused).map((s) => s.id));
    const queued = queue.filter((q) => q.provider === name && !ticketed.has(q.id)).length;
    const startedHoldingTicket = queue.filter((q) => q.provider === name && ticketed.has(q.id)).length;
    // only a provider that is a local candidate (enabled or tier-launched) and served (the daemon's local-status names it) or has work is worth a line
    const served = (status?.running ?? []).some((r) => r.provider === name);
    if (!(isLocalCandidate(p, name, tiers) && served) && !onProv.length && !queued) continue;
    providers.push({
      provider: name,
      cap,
      workers: mine.map((s) => ({ id: s.id, activity: activityOf(s, tickets), ...ownerOf(s) })),
      queued,
      paused,
      lent,
      startedHoldingTicket,
    });
  }
  return { at: now, gpuPct: await gpu(), providers };
}

/** One step of the rule; pure. Returns the next state and the nudges due now. */
export function evaluate(state: LocalIdleState, sample: LocalSample, cfg: LocalIdleConfig, muted: ReadonlySet<string> = new Set()): { state: LocalIdleState; nudges: Nudge[] } {
  const idle = sample.gpuPct !== null && sample.gpuPct < cfg.gpuBelowPct;
  const sent: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(state.sent ?? {})) {
    const recent = v.filter((t) => sample.at - t < 3_600_000);
    if (recent.length) sent[k] = recent;
  }
  const next: LocalIdleState = { idleSince: idle ? (state.idleSince ?? sample.at) : null, lastNudge: { ...state.lastNudge }, sent };
  const nudges: Nudge[] = [];
  if (!cfg.enabled || next.idleSince === null || sample.at - next.idleSince < cfg.minutes * 60_000) return { state: next, nudges };
  for (const p of sample.providers) {
    const free = p.cap - p.workers.length;
    if (free <= 0 || p.queued > 0 || p.workers.some((w) => w.activity === "generating")) continue;
    if (sample.at - (next.lastNudge[p.provider] ?? -Infinity) < cfg.backoffMinutes * 60_000) continue;
    const targets = new Map<string, { iterm?: string; name?: string; claudeSession?: string; ids: string[] }>();
    for (const w of p.workers) {
      if ((w.name && muted.has(w.name)) || (w.iterm && muted.has(w.iterm)) || (w.claudeSession && muted.has(w.claudeSession))) continue;
      const key = w.iterm ?? w.name ?? w.claudeSession;
      if (!key) continue;
      if ((sent[key]?.length ?? 0) >= MAX_NUDGES_PER_HOUR) continue;
      const t = targets.get(key) ?? { iterm: w.iterm, name: w.name, claudeSession: w.claudeSession, ids: [] };
      t.ids.push(w.id);
      targets.set(key, t);
    }
    for (const t of targets.values()) {
      const key = (t.iterm ?? t.name ?? t.claudeSession) as string;
      sent[key] = [...(sent[key] ?? []), sample.at];
    }
    next.lastNudge[p.provider] = sample.at; // the idle spell is logged once per backoff even with nobody to tell
    nudges.push({ provider: p.provider, free, workers: p.workers, targets: [...targets.values()] });
  }
  return { state: next, nudges };
}

export const nudgeText = (n: Nudge, ids: string[], minutes: number): string =>
  eventLine(
    ids[0] ?? n.provider,
    "local-idle",
    { provider: n.provider, free: n.free },
    `GPU idle (under ${defaultWorkersConfig().localIdle.gpuBelowPct}% busy) for ${minutes} min: your local workers ${ids.join(", ")} are in builds; ${n.provider} has ${n.free} free slot${n.free === 1 ? "" : "s"}: start more independent local tasks`
  );

export interface LocalIdleFile {
  at: string;
  /** The instant read this tick saw (the idle rule's input). */
  gpuPct: number | null;
  /** Avg GPU % over the last minute of ~5 s instants (fast sampler); null while it has no samples. */
  gpuAvgPct?: number | null;
  /** Peak GPU % over the same window. */
  gpuPeakPct?: number | null;
  /** SoC die temperature max °C from tools/pai-sensors (30 s sampler); absent with no reading yet. */
  socTempC?: number;
  /** SoC die temperature avg °C over the same sensors. */
  socTempAvgC?: number;
  /** Number of die sensors behind the two numbers. */
  socSensors?: number;
  /** Epoch ms of the temperature reading (the sampler's own clock, beside `at`). */
  socTempAt?: number;
  /** Why there is no temperature (helper not built / failed); kept beside the last value. */
  socTempError?: string;
  idleSince: number | null;
  lastNudge: Record<string, number>;
  providers: Array<{ provider: string; cap: number; running: number; free: number; queued: number; paused?: number; lent?: number; startedHoldingTicket?: number; activity: Record<string, number> }>;
}

const stateFile = (logDir: string): string => join(logDir, "local-idle.json");
const muteFile = (logDir: string): string => join(logDir, "local-idle-muted.json");

export function readLocalIdle(logDir: string): LocalIdleFile | null {
  try {
    return JSON.parse(readFileSync(stateFile(logDir), "utf8")) as LocalIdleFile;
  } catch {
    return null;
  }
}

export function readMuted(logDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(muteFile(logDir), "utf8"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A session mutes the nudge by its AIBroker name or iTerm id; returns the muted list. */
export function setMuted(logDir: string, session: string, muted: boolean): string[] {
  const set = new Set(readMuted(logDir));
  if (muted) set.add(session);
  else set.delete(session);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(muteFile(logDir), JSON.stringify([...set]), "utf8");
  return [...set];
}

/** The `ps` / cockpit line: "local model: GPU 63% busy · gyro-m 2/4 running, 2 free"; "" with no reading. */
export function localIdleLine(f: LocalIdleFile | null, now = Date.now()): string {
  if (!f || now - Date.parse(f.at) > 120_000) return "";
  // the minute average of the ~5 s instants, not one instant: the AGX read jumps between 0 and ~97 within seconds
  const gpu = f.gpuAvgPct == null ? (f.gpuPct === null ? "GPU –" : `GPU ${Math.round(f.gpuPct)}%`) : `GPU ${Math.round(f.gpuAvgPct)}%`;
  // same accounting as the slot gate: busy = slot holders; paused and waiting are counted apart, and "N waiting" counts not-started jobs only (what the table's waiting rows show); started jobs that hold a ticket to get a slot back appear in their own part. busy + lent = the running rows of the queue table
  const provs = f.providers.map((p) => [`${p.provider}: ${p.running} of ${p.cap} slots busy`, p.running > p.cap ? `engine idle: admitted ${p.running - p.cap} extra` : "", p.lent ? `${p.lent} lent (waiting on a tool)` : "", p.startedHoldingTicket ? `${p.startedHoldingTicket} waiting for their slot back` : "", p.paused ? `${p.paused} paused` : "", p.queued ? `${p.queued} waiting` : ""].filter(Boolean).join(" · "));
  return [...provs, gpu].join(" · ");
}

export interface LocalIdleDeps {
  sample?: () => Promise<LocalSample>;
  now?: () => number;
}

const daemonState = { current: { idleSince: null, lastNudge: {} } as LocalIdleState };

/** One daemon tick: sample, persist, nudge the owning sessions once per backoff, ledger LOCAL-IDLE. */
export async function localIdleTick(logDir: string, workers: WorkersConfig, msg: Messenger, deps: LocalIdleDeps = {}, state: { current: LocalIdleState } = daemonState): Promise<Nudge[]> {
  const cfg = workers.localIdle;
  if (!cfg.enabled) return [];
  const now = (deps.now ?? Date.now)();
  const sample = await (deps.sample ?? (() => takeSample(logDir, workers, now)))();
  const { state: next, nudges } = evaluate(state.current, sample, cfg, new Set(readMuted(logDir)));
  state.current = next;
  const win = gpuStats(sample.at, 60_000);
  const st = socTempState(); // the 30 s pai-sensors sampler's last value + reason, read without spawning anything
  const file: LocalIdleFile = {
    at: new Date(sample.at).toISOString(),
    gpuPct: sample.gpuPct,
    gpuAvgPct: win.avg,
    gpuPeakPct: win.peak,
    ...(st.last ? { socTempC: st.last.maxC, socTempAvgC: st.last.avgC, socSensors: st.last.sensors, socTempAt: st.last.at } : {}),
    ...(st.error ? { socTempError: st.error } : {}),
    idleSince: next.idleSince,
    lastNudge: next.lastNudge,
    providers: sample.providers.map((p) => {
      const activity: Record<string, number> = {};
      for (const w of p.workers) activity[w.activity] = (activity[w.activity] ?? 0) + 1;
      return { provider: p.provider, cap: p.cap, running: p.workers.length, free: Math.max(0, p.cap - p.workers.length), queued: p.queued, paused: p.paused ?? 0, lent: p.lent ?? 0, startedHoldingTicket: p.startedHoldingTicket ?? 0, activity };
    }),
  };
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(stateFile(logDir), JSON.stringify(file), "utf8");
  } catch {
    /* a state file is an extra: never fail the tick over it */
  }
  for (const n of nudges) {
    appendLedger(ledgerPath(logDir), "LOCAL-IDLE", { provider: n.provider, free: n.free, workers: n.workers.map((w) => `${w.id}:${w.activity}`).join(",") || "-" }, new Date(sample.at));
    for (const t of n.targets) {
      const who = t.iterm ?? t.name ?? t.claudeSession ?? "?";
      let reason = "";
      try {
        const ok = await msg.toSession({ iterm: t.iterm, name: t.name, claudeSession: t.claudeSession }, nudgeText(n, t.ids, cfg.minutes));
        if (!ok) reason = msg.lastError || "AIBroker did not accept the message";
      } catch (e) {
        reason = String(e);
      }
      if (reason) appendLedger(ledgerPath(logDir), "LOCAL-IDLE-UNDELIVERED", { provider: n.provider, target: who, workers: t.ids.join(","), reason: reason.replace(/\s+/g, " ").slice(0, 200) }, new Date(sample.at));
    }
  }
  return nudges;
}
