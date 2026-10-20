/**
 * local-idle.ts — the local model must not sit idle while workers build.
 * Incident 2026-10-20: both workers of the local engine were inside build-gate jobs, the GPU read 0 %,
 * two slots were free and nothing was queued. The daemon samples every 30 s (GPU utilisation, what each
 * running local worker is doing, free slots, queued local work); when the GPU stays under the threshold
 * for `minutes`, every running local worker is blocked in a build/test (or none runs), a slot is free and
 * nothing local is queued, it nudges each owning session ONCE (then backs off) and writes LOCAL-IDLE to the
 * ledger. The latest sample is persisted for `pai worker ps` and the cockpit. Read-only towards the engine.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBuildsSync, ticketKind, buildsDir, type BuildTicket } from "../builds/queue.js";
import { providerCap, queueRows } from "./capacity.js";
import { isLocalProvider, type WorkersConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { eventLine, type Messenger } from "./run-events.js";
import { isChatPane, isLive, loadStatuses, type WorkerStatus } from "./status.js";

export interface LocalIdleConfig {
  enabled: boolean;
  /** GPU "Device Utilization %" under which the engine counts as idle. */
  gpuBelowPct: number;
  /** Minutes the GPU must stay idle before the nudge. */
  minutes: number;
  /** Minutes before the same provider may nudge again. */
  backoffMinutes: number;
}

export const DEFAULT_LOCAL_IDLE: LocalIdleConfig = { enabled: true, gpuBelowPct: 10, minutes: 2, backoffMinutes: 10 };

export type Activity = "build" | "test" | "generating";

export interface LocalWorker {
  id: string;
  activity: Activity;
  /** Where a nudge goes: the owning session. */
  iterm?: string;
  name?: string;
}

export interface LocalProviderSample {
  provider: string;
  cap: number;
  workers: LocalWorker[];
  queued: number;
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
}

export interface Nudge {
  provider: string;
  free: number;
  workers: LocalWorker[];
  /** One entry per owning session. */
  targets: Array<{ iterm?: string; name?: string; ids: string[] }>;
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
export async function takeSample(logDir: string, workers: WorkersConfig, now = Date.now(), gpu: () => Promise<number | null> = readGpuUtilization): Promise<LocalSample> {
  let tickets: BuildTicket[] = [];
  try {
    tickets = listBuildsSync(buildsDir());
  } catch {
    /* no build dir yet */
  }
  const statuses = loadStatuses(logDir).filter((s) => !isChatPane(s) && isLive(s) && s.state === "running");
  const queue = queueRows(logDir);
  const providers: LocalProviderSample[] = [];
  for (const [name, p] of Object.entries(workers.providers)) {
    if (!isLocalProvider(p.baseUrl)) continue;
    const cap = providerCap(workers, name);
    if (cap === undefined) continue;
    providers.push({
      provider: name,
      cap,
      workers: statuses
        .filter((s) => s.provider === name)
        .map((s) => ({ id: s.id, activity: activityOf(s, tickets), iterm: s.term || undefined, name: s.session?.name })),
      queued: queue.filter((q) => q.provider === name).length,
    });
  }
  return { at: now, gpuPct: await gpu(), providers };
}

/** One step of the rule; pure. Returns the next state and the nudges due now. */
export function evaluate(state: LocalIdleState, sample: LocalSample, cfg: LocalIdleConfig, muted: ReadonlySet<string> = new Set()): { state: LocalIdleState; nudges: Nudge[] } {
  const idle = sample.gpuPct !== null && sample.gpuPct < cfg.gpuBelowPct;
  const next: LocalIdleState = { idleSince: idle ? (state.idleSince ?? sample.at) : null, lastNudge: { ...state.lastNudge } };
  const nudges: Nudge[] = [];
  if (!cfg.enabled || next.idleSince === null || sample.at - next.idleSince < cfg.minutes * 60_000) return { state: next, nudges };
  for (const p of sample.providers) {
    const free = p.cap - p.workers.length;
    if (free <= 0 || p.queued > 0 || p.workers.some((w) => w.activity === "generating")) continue;
    if (sample.at - (next.lastNudge[p.provider] ?? -Infinity) < cfg.backoffMinutes * 60_000) continue;
    const targets = new Map<string, { iterm?: string; name?: string; ids: string[] }>();
    for (const w of p.workers) {
      if ((w.name && muted.has(w.name)) || (w.iterm && muted.has(w.iterm))) continue;
      const key = w.iterm ?? w.name;
      if (!key) continue;
      const t = targets.get(key) ?? { iterm: w.iterm, name: w.name, ids: [] };
      t.ids.push(w.id);
      targets.set(key, t);
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
    `GPU idle ${minutes} min: your local workers ${ids.join(", ")} are in builds; ${n.provider} has ${n.free} free slot${n.free === 1 ? "" : "s"}: start more independent local tasks`
  );

export interface LocalIdleFile {
  at: string;
  gpuPct: number | null;
  idleSince: number | null;
  lastNudge: Record<string, number>;
  providers: Array<{ provider: string; cap: number; running: number; free: number; queued: number; activity: Record<string, number> }>;
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

/** The `ps` / cockpit line: "local model: busy 63 % · gyro-m 2/4 running, 2 free"; "" with no reading. */
export function localIdleLine(f: LocalIdleFile | null, now = Date.now()): string {
  if (!f || now - Date.parse(f.at) > 120_000) return "";
  const gpu = f.gpuPct === null ? "gpu ?" : `${f.gpuPct < DEFAULT_LOCAL_IDLE.gpuBelowPct ? "idle" : "busy"} ${f.gpuPct}%`;
  const provs = f.providers.map((p) => `${p.provider} ${p.running}/${p.cap} running, ${p.free} free${p.queued ? `, ${p.queued} queued` : ""}`);
  return `local model: ${[gpu, ...provs].join(" · ")}`;
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
  const file: LocalIdleFile = {
    at: new Date(sample.at).toISOString(),
    gpuPct: sample.gpuPct,
    idleSince: next.idleSince,
    lastNudge: next.lastNudge,
    providers: sample.providers.map((p) => {
      const activity: Record<string, number> = {};
      for (const w of p.workers) activity[w.activity] = (activity[w.activity] ?? 0) + 1;
      return { provider: p.provider, cap: p.cap, running: p.workers.length, free: Math.max(0, p.cap - p.workers.length), queued: p.queued, activity };
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
    for (const t of n.targets) await msg.toSession({ iterm: t.iterm, name: t.name }, nudgeText(n, t.ids, cfg.minutes)).catch(() => false);
  }
  return nudges;
}
