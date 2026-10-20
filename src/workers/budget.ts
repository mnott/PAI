/**
 * budget.ts — live budget probes for budget-aware routing (policy "budget").
 *
 * One reading per provider: {percent, resetAt} of its most-constrained usage
 * window, from the same endpoints the cockpit limits card polls — anthropic
 * via the OAuth usage endpoint (keychain token), every other provider via its
 * workers.yaml `usage` block. Readings are cached for BUDGET_TTL_MS so a
 * burst of spawns costs one poll, and a failed probe reads as "unknown",
 * never as "full": routing must not break because an endpoint did.
 *
 * The routing decision itself lives in routing.ts (wall skip, cooldown until
 * reset); this module only fetches and caches. Keys never leave this process
 * and never appear in a reading or an error.
 */

import {
  anthropicShared,
  getJson,
  windowsFromJson,
  type LimitWindow,
} from "../router/limits.js";
import {
  type WorkerProvider,
  type WorkersConfig,
  type WorkersRoutingConfig,
  nativeAnthropicProvider,
  resolveProviderKey,
} from "./config.js";

/** One provider's budget reading: most-constrained window, or "unknown". */
export interface BudgetReading {
  /** Used percent 0–100; null when no window could be read (never wall a provider on null). */
  percent: number | null;
  /** Epoch ms the window resets; null when the endpoint did not say. */
  resetAt: number | null;
  /** Epoch ms the reading was fetched. */
  fetchedAt: number;
  /** Every window the endpoint reported, for per-window walls; absent on a bare reading. */
  windows?: Array<{ name: string; percent: number; resetAt?: number }>;
}

export type BudgetMap = Record<string, BudgetReading>;

/** How long a reading is trusted before the next spawn re-probes. */
export const BUDGET_TTL_MS = 5 * 60_000;

/**
 * The most-constrained window of a usage response: highest percent, with its
 * reset. A provider is as full as its fullest window (a 96% 5h window is the
 * wall even when the 7d window reads 20%).
 */
export function pickBudgetWindow(windows: LimitWindow[], now: number): BudgetReading {
  let best: LimitWindow | null = null;
  for (const w of windows) if (!best || w.percent > best.percent) best = w;
  if (!best) return { percent: null, resetAt: null, fetchedAt: now };
  return { percent: best.percent, resetAt: best.resetAt ?? null, fetchedAt: now };
}

function withWindows(r: BudgetReading, windows: LimitWindow[]): BudgetReading {
  return { ...r, windows: windows.map((w) => ({ name: w.name, percent: w.percent, ...(w.resetAt ? { resetAt: w.resetAt } : {}) })) };
}

/**
 * Fetch one provider's budget reading. anthropic (native) reads the OAuth
 * usage endpoint with the keychain token; every other provider its
 * workers.yaml `usage` block. Any failure — no key, no network, bad JSON —
 * is "unknown", and unknown never walls a provider.
 */
export async function fetchBudgetReading(name: string, p: WorkerProvider): Promise<BudgetReading> {
  const now = Date.now();
  try {
    if (p.native || name === "anthropic") {
      // the shared door: a reading the router or another probe took within the
      // poll interval is reused, and a 429 backoff is honoured, not retried
      const r = await anthropicShared(now);
      return withWindows(pickBudgetWindow(r.windows, r.fetchedAt), r.windows);
    }
    if (!p.usage) return { percent: null, resetAt: null, fetchedAt: now };
    const key = resolveProviderKey(p);
    const [hn, ...pre] = (p.usage.authHeader ?? "Authorization: Bearer").split(/:\s*/);
    const prefix = pre.join(": ");
    const body = await getJson(new URL(p.usage.url), {
      [hn!.toLowerCase()]: prefix ? `${prefix} ${key}` : String(key),
    });
    const windows = windowsFromJson(body, p.usage);
    return withWindows(pickBudgetWindow(windows, now), windows);
  } catch {
    return { percent: null, resetAt: null, fetchedAt: now };
  }
}

/**
 * Budget readings for spawn-time routing, at most one poll per TTL;
 * concurrent warmers share the inflight poll. `seed` lets tests (and a
 * caller with fresh readings of its own) put values in without a poll.
 */
export class BudgetCache {
  private value: BudgetMap = {};
  private at = 0;
  private inflight: Promise<BudgetMap> | undefined;

  constructor(
    private readonly ttlMs: number = BUDGET_TTL_MS,
    private readonly fetch: (name: string, p: WorkerProvider) => Promise<BudgetReading> = fetchBudgetReading
  ) {}

  /** Refresh every stale provider of `config`; resolves to the full map. */
  async warm(config: WorkersConfig, now: number = Date.now()): Promise<BudgetMap> {
    if (this.at && now - this.at < this.ttlMs) return this.value;
    this.inflight ??= this.poll(config).then((v) => {
      this.value = v;
      this.at = now;
      this.inflight = undefined;
      return v;
    });
    return this.inflight;
  }

  private async poll(config: WorkersConfig): Promise<BudgetMap> {
    const out: BudgetMap = { ...this.value };
    const jobs: Array<Promise<void>> = [
      // native anthropic has no config entry: probe it as the synthetic provider
      this.fetch("anthropic", nativeAnthropicProvider(config.nativeModels)).then((r) => {
        out.anthropic = r;
      }),
    ];
    for (const [name, p] of Object.entries(config.providers)) {
      jobs.push(
        this.fetch(name, p).then((r) => {
          out[name] = r;
        })
      );
    }
    await Promise.all(jobs);
    return out;
  }

  /** Synchronous read for routing (possibly absent — absence is "unknown"). */
  get(name: string): BudgetReading | undefined {
    return this.value[name];
  }

  snapshot(): BudgetMap {
    return { ...this.value };
  }

  seed(map: BudgetMap, at: number = Date.now()): void {
    this.value = { ...map };
    this.at = at;
  }

  clear(): void {
    this.value = {};
    this.at = 0;
    this.inflight = undefined;
  }
}

/** The process-wide cache routing reads; run.ts warms it before resolving. */
export const budgetCache = new BudgetCache();

/**
 * A provider's wall for one window: routing.budgetWalls[name] as a map entry
 * for that window, else its plain number, else the shipped
 * routing.budgetPercent, else the shipped routing.budgetWall.
 */
export function budgetWall(routing: WorkersRoutingConfig, name: string, window?: string): number {
  const w = routing.budgetWalls[name];
  if (typeof w === "number") return w;
  if (w && window !== undefined && w[window] !== undefined) return w[window]!;
  return routing.budgetPercent[name] ?? routing.budgetWall;
}

/** At or above its wall? Unknown (absent/null percent) is never full. */
export function budgetExceeded(r: BudgetReading | undefined, wall: number): boolean {
  return !!r && r.percent !== null && r.percent >= wall;
}

/** The window that makes a provider full, with its wall. */
export interface BudgetHit {
  window: string | null;
  percent: number;
  wall: number;
  resetAt: number | null;
}

/**
 * Is the provider full? True when ANY window it reports is at or above that
 * window's wall (a bare reading without windows is judged on its one percent).
 * Returns the first window over its wall, null when there is room or the
 * reading is unknown.
 */
export function budgetFull(
  routing: WorkersRoutingConfig,
  name: string,
  r: BudgetReading | undefined
): BudgetHit | null {
  if (!r || r.percent === null) return null;
  if (r.windows?.length) {
    for (const w of r.windows) {
      const wall = budgetWall(routing, name, w.name);
      if (w.percent >= wall) return { window: w.name, percent: w.percent, wall, resetAt: w.resetAt ?? null };
    }
    return null;
  }
  const wall = budgetWall(routing, name);
  return r.percent >= wall ? { window: null, percent: r.percent, wall, resetAt: r.resetAt } : null;
}

/** Is this reading fresh enough to act on (wall cooldowns) at `now`? */
export function budgetFresh(r: BudgetReading, now: number, ttlMs: number = BUDGET_TTL_MS): boolean {
  return now - r.fetchedAt < ttlMs;
}

/** "08:02" for a reading's reset, else now + 10 min — the reason line's clock. */
export function budgetUntilLabel(r: BudgetReading, now: Date = new Date()): string {
  const t = r.resetAt && r.resetAt > now.getTime() ? r.resetAt : now.getTime() + 10 * 60_000;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Why `chosen` is not the walled provider skipped ahead of it:
 * "anthropic 96% until 08:02" — the one-line switch reason.
 */
export function budgetSkipReason(name: string, r: BudgetReading, now: Date = new Date(), percent: number | null = r.percent): string {
  return `${name} ${percent}% until ${budgetUntilLabel(r, now)}`;
}
