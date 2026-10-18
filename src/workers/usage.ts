/**
 * usage.ts — exact token tallies per model from stream events / transcripts.
 *
 * `sumUsage` (each message id once, its last usage) serves the transcript
 * side, `pai audit tokens usage`; the worker side, `pai worker usage`, reads
 * a run log through `sumRunUsage`, which prefers the run's `result` event —
 * the harness books the run's authoritative totals there, and local servers
 * that report no per-turn counts still show their tokens (src/router/
 * prompt-tokens.ts makes the router fill what the server never reported).
 */

import { existsSync, readFileSync } from "node:fs";
import { eventsPath } from "./paths.js";
import { loadStatuses, type WorkerStatus } from "./status.js";
import { isLocalProvider } from "./policy.js";
import type { UsageBlock } from "../utils/input-side-tokens.js";

export interface CacheCreationSplit {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

export type RichUsage = UsageBlock & { cache_creation?: CacheCreationSplit };

export interface Tally {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export const emptyTally = (): Tally => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });

export function addTally(into: Tally, t: Tally): void {
  into.input += t.input;
  into.cacheRead += t.cacheRead;
  into.cacheWrite5m += t.cacheWrite5m;
  into.cacheWrite1h += t.cacheWrite1h;
  into.output += t.output;
}

/** One usage block as a tally; a cache write without a 5m/1h split counts as 5m. */
export function tallyOf(u: RichUsage): Tally {
  const split5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const split1 = u.cache_creation?.ephemeral_1h_input_tokens;
  const hasSplit = split5 !== undefined || split1 !== undefined;
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: hasSplit ? (split5 ?? 0) : (u.cache_creation_input_tokens ?? 0),
    cacheWrite1h: hasSplit ? (split1 ?? 0) : 0,
    output: u.output_tokens ?? 0,
  };
}

export interface SumResult {
  byModel: Map<string, Tally>;
  /** total_cost_usd of the last result event, when there was one. */
  costUsd: number | null;
}

/** camelCase per-model totals of a result event's modelUsage block as a tally. */
function tallyOfModelUsage(mu: Record<string, unknown>): Tally {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: num(mu.inputTokens),
    cacheRead: num(mu.cacheReadInputTokens),
    cacheWrite5m: num(mu.cacheCreationInputTokens),
    cacheWrite1h: 0,
    output: num(mu.outputTokens),
  };
}

const tallyIsZero = (t: Tally): boolean => !t.input && !t.cacheRead && !t.cacheWrite5m && !t.cacheWrite1h && !t.output;

/**
 * Sum usage of a *run* event log (a worker's, as opposed to a transcript):
 * the run's `result` event is authoritative when it carries usage or
 * modelUsage — local servers report per-turn counts as 0, and the harness
 * fills them only into the result event. Without a result event (killed run)
 * the assistant turns are summed like a transcript. `fallbackModel` books
 * result-event usage that names no model on the run's own model.
 */
export function sumRunUsage(jsonl: string, fallbackModel?: string): SumResult {
  const perTurn = sumUsage(jsonl);
  let result: { model?: string; usage?: RichUsage; modelUsage?: Record<string, Record<string, unknown>> } | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"result"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; model?: string; usage?: RichUsage; modelUsage?: Record<string, Record<string, unknown>> };
      if (e.type === "result") result = e;
    } catch {
      /* torn line */
    }
  }
  if (!result) return perTurn;
  const byModel = new Map<string, Tally>();
  const mu = result.modelUsage;
  if (mu && typeof mu === "object" && Object.keys(mu).length) {
    const named: [string, Tally][] = [];
    for (const [key, v] of Object.entries(mu)) {
      if (!v || typeof v !== "object") continue;
      const model = typeof (v as { canonicalModel?: unknown }).canonicalModel === "string" ? (v as { canonicalModel: string }).canonicalModel : key;
      named.push([model, tallyOfModelUsage(v)]);
    }
    const whole = result.usage ? tallyOf(result.usage) : undefined;
    if (named.length === 1 && whole && !tallyIsZero(whole)) {
      // modelUsage has no 5m/1h split; the result's usage block does, and it is the same run total
      byModel.set(named[0][0], whole);
    } else if (named.length > 1 && whole && whole.cacheWrite5m + whole.cacheWrite1h > 0) {
      // modelUsage has per-model totals but no cache TTL split: apply the run-wide 1h share to each
      // model, rounding by cumulative position so the per-model sums stay exact
      const total = whole.cacheWrite5m + whole.cacheWrite1h;
      let seen = 0;
      let given1h = 0;
      for (const [model, t] of named) {
        const write = t.cacheWrite5m;
        seen += write;
        const upTo1h = Math.round((seen * whole.cacheWrite1h) / total);
        const w1h = Math.min(write, upTo1h - given1h);
        given1h += w1h;
        byModel.set(model, { ...t, cacheWrite5m: write - w1h, cacheWrite1h: w1h });
      }
    } else {
      for (const [model, t] of named) byModel.set(model, t);
    }
  } else if (result.usage && !tallyIsZero(tallyOf(result.usage))) {
    const model = result.model ?? fallbackModel ?? (perTurn.byModel.size === 1 ? [...perTurn.byModel.keys()][0] : "?");
    byModel.set(model, tallyOf(result.usage));
  }
  return byModel.size ? { byModel, costUsd: perTurn.costUsd } : perTurn;
}

/** Sum assistant usage of JSONL text: each message id once (its last usage), grouped by model. */
export function sumUsage(jsonl: string): SumResult {
  const byId = new Map<string, { model: string; usage: RichUsage }>();
  let anon = 0;
  let costUsd: number | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; total_cost_usd?: number; message?: { id?: string; model?: string; usage?: RichUsage } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "result" && typeof e.total_cost_usd === "number") costUsd = e.total_cost_usd;
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const m = e.message;
    byId.set(m.id ?? `anon-${anon++}`, { model: m.model ?? "?", usage: m.usage! });
  }
  const byModel = new Map<string, Tally>();
  for (const { model, usage } of byId.values()) {
    const t = byModel.get(model) ?? emptyTally();
    addTally(t, tallyOf(usage));
    byModel.set(model, t);
  }
  return { byModel, costUsd };
}

export interface UsageRow {
  provider: string;
  model: string;
  local: boolean;
  workers: number;
  tally: Tally;
  /** Summed total_cost_usd; null for local rows. */
  costUsd: number | null;
}

export interface UsageReport {
  rows: UsageRow[];
  cloud: UsageRow;
  local: UsageRow;
}

const totalRow = (provider: string, local: boolean): UsageRow => ({
  provider,
  model: "",
  local,
  workers: 0,
  tally: emptyTally(),
  costUsd: local ? null : 0,
});

export function finishReport(rows: UsageRow[]): UsageReport {
  const cloud = totalRow("TOTAL cloud", false);
  const local = totalRow("TOTAL local", true);
  for (const r of rows) {
    const t = r.local ? local : cloud;
    t.workers += r.workers;
    addTally(t.tally, r.tally);
    if (!r.local) t.costUsd = (t.costUsd ?? 0) + (r.costUsd ?? 0);
  }
  return { rows, cloud, local };
}

export interface WorkerSelect {
  labelPrefix?: string;
  since?: Date;
  until?: Date;
}

/** "1h", "30m", "2d" relative to now, or an ISO timestamp. */
export function parseWhen(s: string, now = new Date()): Date {
  const rel = /^(\d+)([smhd])$/.exec(s.trim());
  if (rel) {
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
    return new Date(now.getTime() - Number(rel[1]) * mult);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot read "${s}" as a time; use an ISO timestamp or 1h / 30m`);
  return d;
}

/** Status `started` is local "YYYY-MM-DD HH:MM:SS" (or ISO). */
function startedAt(s: WorkerStatus): Date | null {
  const d = new Date(s.started.includes("T") ? s.started : s.started.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function selectWorkers(statuses: WorkerStatus[], sel: WorkerSelect): WorkerStatus[] {
  return statuses.filter((s) => {
    if (sel.labelPrefix && !(s.label ?? "").startsWith(sel.labelPrefix)) return false;
    const at = startedAt(s);
    if (sel.since && (!at || at < sel.since)) return false;
    if (sel.until && (!at || at > sel.until)) return false;
    return true;
  });
}

/** Tally the selected workers; `baseUrls` maps provider name to its baseUrl (for the local mark). */
export function workerUsage(logDir: string, sel: WorkerSelect, baseUrls: Record<string, string>): UsageReport {
  const groups = new Map<string, UsageRow>();
  for (const st of selectWorkers(loadStatuses(logDir), sel)) {
    const path = eventsPath(logDir, st.id);
    if (!existsSync(path)) continue;
    const { byModel, costUsd } = sumRunUsage(readFileSync(path, "utf8"), st.model);
    if (byModel.size === 0) continue;
    const local = isLocalProvider(baseUrls[st.provider] ?? "");
    const models = [...byModel.keys()];
    // the run's cost is one number; book it on the run's own model, else the last one seen
    const costModel = models.includes(st.model) ? st.model : models[models.length - 1];
    for (const [model, tally] of byModel) {
      const key = `${st.provider}\u0000${model}`;
      const row = groups.get(key) ?? { provider: st.provider, model, local, workers: 0, tally: emptyTally(), costUsd: local ? null : 0 };
      row.workers += 1;
      addTally(row.tally, tally);
      if (!local && model === costModel) row.costUsd = (row.costUsd ?? 0) + (costUsd ?? 0);
      groups.set(key, row);
    }
  }
  return finishReport([...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)));
}

// ---------------------------------------------------------------------------
// Transcript side (tier 0): cost from a price table
// ---------------------------------------------------------------------------

/** USD per million tokens. Edit here when prices change; cache read 0.1x, write 5m 1.25x, write 1h 2x of input. */
export const PRICE_TABLE: Record<"opus" | "sonnet" | "haiku", { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};
export const CACHE_READ_X = 0.1;
export const CACHE_WRITE_5M_X = 1.25;
export const CACHE_WRITE_1H_X = 2;

export function priceTableText(): string {
  const lines = Object.entries(PRICE_TABLE).map(([f, p]) => `  ${f.padEnd(7)} input $${p.input}/M, output $${p.output}/M`);
  return `Prices (USD per million tokens, matched on the model name):\n${lines.join("\n")}\n  cache read ${CACHE_READ_X}x input, cache write 5m ${CACHE_WRITE_5M_X}x, cache write 1h ${CACHE_WRITE_1H_X}x`;
}

/** Cost of a tally by model family, or null when the model matches no family. */
export function priceTally(model: string, t: Tally): number | null {
  const fam = (Object.keys(PRICE_TABLE) as Array<keyof typeof PRICE_TABLE>).find((f) => model.toLowerCase().includes(f));
  if (!fam) return null;
  const p = PRICE_TABLE[fam];
  const inp = p.input / 1e6;
  return t.input * inp + t.output * (p.output / 1e6) + t.cacheRead * inp * CACHE_READ_X + t.cacheWrite5m * inp * CACHE_WRITE_5M_X + t.cacheWrite1h * inp * CACHE_WRITE_1H_X;
}

export function transcriptUsage(path: string): UsageReport {
  const { byModel } = sumUsage(readFileSync(path, "utf8"));
  const rows: UsageRow[] = [...byModel.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([model, tally]) => ({ provider: "transcript", model, local: false, workers: 0, tally, costUsd: priceTally(model, tally) }));
  const rep = finishReport(rows);
  rep.cloud.provider = "TOTAL";
  return rep;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number | null) => (x === null ? "—" : x.toFixed(4));

export function renderUsage(rep: UsageReport, opts: { workers: boolean }): string {
  const head = ["PROVIDER", "MODEL", ...(opts.workers ? ["WORKERS"] : []), "INPUT", "CACHE READ", "CACHE WRITE 5m", "CACHE WRITE 1h", "OUTPUT", "COST USD"];
  const cells = (r: UsageRow) => [
    r.provider + (r.local && !r.provider.startsWith("TOTAL") ? " (local)" : ""),
    r.model,
    ...(opts.workers ? [String(r.workers)] : []),
    n(r.tally.input),
    n(r.tally.cacheRead),
    n(r.tally.cacheWrite5m),
    n(r.tally.cacheWrite1h),
    n(r.tally.output),
    r.local ? "—" : usd(r.costUsd),
  ];
  const body = [...rep.rows.map(cells)];
  const totals = opts.workers ? [cells(rep.cloud), cells(rep.local)] : [cells(rep.cloud)];
  const all = [head, ...body, ...totals];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const textCols = 2;
  const fmt = (r: string[]) => r.map((c, i) => (i < textCols ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
  return [fmt(head), ...body.map(fmt), fmt(w.map((x) => "-".repeat(x))), ...totals.map(fmt)].join("\n");
}

export function usageJson(rep: UsageReport): unknown {
  const row = (r: UsageRow) => ({ provider: r.provider, model: r.model, local: r.local, workers: r.workers, ...r.tally, costUsd: r.costUsd });
  return { rows: rep.rows.map(row), totalCloud: row(rep.cloud), totalLocal: row(rep.local) };
}
