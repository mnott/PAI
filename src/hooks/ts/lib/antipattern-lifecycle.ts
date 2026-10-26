/**
 * antipattern-lifecycle.ts — lifecycle fields shared by every anti-pattern (shell rules and the other categories).
 *
 * Follows detection-engineering practice: a Sigma-style status, an enforce/monitor mode (monitor records the firing
 * and takes no action), a version, dates, supersession, known false positives and time-boxed exceptions.
 * Defaults keep today's behaviour: status stable, mode enforce, version 1.
 */

export const STATUSES = ["experimental", "test", "stable", "deprecated"] as const;
export type Status = (typeof STATUSES)[number];
export const MODES = ["enforce", "monitor"] as const;
export type Mode = (typeof MODES)[number];
/** Where the pattern acts on the model-API proxy path: enforce rewrites a denied reply, monitor only records, off is silent. */
export const PROXY_MODES = ["enforce", "monitor", "off"] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];
export const LEVELS = ["low", "medium", "high"] as const;

export interface PatternException {
  match: string;
  reason: string;
  owner?: string;
  /** Date after which the exception is ignored. */
  expires?: string;
}

export interface Lifecycle {
  status: Status;
  mode: Mode;
  /** Whether the pattern acts on the proxy path; default monitor (records only). */
  proxy: ProxyMode;
  version: number;
  created?: string;
  modified?: string;
  supersedes: string[];
  falsepositives: string[];
  title?: string;
  description?: string;
  level?: (typeof LEVELS)[number];
  author?: string;
  references: string[];
  blind_spots: string[];
  exceptions: PatternException[];
  applies_to?: { providers?: string[]; models?: string[] };
  superseded_by?: string;
  deprecated?: string;
  reason?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
/** YAML dates may arrive as Date objects depending on the parser schema; keep the YYYY-MM-DD form. */
const dateStr = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && v ? v : undefined);

/** The lifecycle of a raw YAML mapping (defaults filled in), or the problem found. */
export function parseLifecycle(raw: Record<string, unknown>): Lifecycle | string {
  const status = raw.status === undefined ? "stable" : raw.status;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return `status must be one of ${STATUSES.join(", ")}`;
  const mode = raw.mode === undefined ? "enforce" : raw.mode;
  if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) return `mode must be one of ${MODES.join(", ")}`;
  const proxy = raw.proxy === undefined ? "monitor" : raw.proxy;
  if (typeof proxy !== "string" || !(PROXY_MODES as readonly string[]).includes(proxy)) return `proxy must be one of ${PROXY_MODES.join(", ")}`;
  const version = raw.version === undefined ? 1 : raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return "version must be a positive integer";
  if (raw.level !== undefined && !(LEVELS as readonly unknown[]).includes(raw.level)) return `level must be one of ${LEVELS.join(", ")}`;
  for (const k of ["supersedes", "falsepositives", "references", "blind_spots"]) {
    if (raw[k] !== undefined && !Array.isArray(raw[k])) return `${k} must be a list`;
  }
  const exceptions: PatternException[] = [];
  if (raw.exceptions !== undefined) {
    if (!Array.isArray(raw.exceptions)) return "exceptions must be a list";
    for (const e of raw.exceptions) {
      if (!isObj(e) || typeof e.match !== "string" || typeof e.reason !== "string") return "each exception needs match and reason";
      try {
        new RegExp(e.match);
      } catch {
        return `exception regex ${e.match} is invalid`;
      }
      exceptions.push({ match: e.match, reason: e.reason, owner: typeof e.owner === "string" ? e.owner : undefined, expires: dateStr(e.expires) });
    }
  }
  let applies_to: Lifecycle["applies_to"];
  if (raw.applies_to !== undefined) {
    if (!isObj(raw.applies_to)) return "applies_to must be a mapping";
    applies_to = { providers: strList(raw.applies_to.providers), models: strList(raw.applies_to.models) };
  }
  return {
    status: status as Status,
    mode: mode as Mode,
    proxy: proxy as ProxyMode,
    version,
    created: dateStr(raw.created),
    modified: dateStr(raw.modified),
    supersedes: strList(raw.supersedes),
    falsepositives: strList(raw.falsepositives),
    title: typeof raw.title === "string" ? raw.title : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    level: raw.level as Lifecycle["level"],
    author: typeof raw.author === "string" ? raw.author : undefined,
    references: strList(raw.references),
    blind_spots: strList(raw.blind_spots),
    exceptions,
    applies_to,
    superseded_by: typeof raw.superseded_by === "string" ? raw.superseded_by : undefined,
    deprecated: dateStr(raw.deprecated),
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

/** The lifecycle fields as they are written back to YAML (defaults included, empties dropped). */
export function lifecycleDoc(lc: Lifecycle): Record<string, unknown> {
  const out: Record<string, unknown> = { status: lc.status, mode: lc.mode, proxy: lc.proxy, version: lc.version };
  const set = (k: string, v: unknown): void => {
    if (v === undefined || (Array.isArray(v) && !v.length)) return;
    out[k] = v;
  };
  for (const k of ["created", "modified", "title", "description", "level", "author", "superseded_by", "deprecated", "reason"] as const) set(k, lc[k]);
  for (const k of ["supersedes", "falsepositives", "references", "blind_spots", "exceptions"] as const) set(k, lc[k]);
  set("applies_to", lc.applies_to);
  return out;
}

export type Disposition = "enforce" | "monitor" | "off";

/**
 * What a firing means right now on the path it came from: `enforce` acts, `monitor` is recorded only, `off` is neither
 * (deprecated, an unexpired exception matching the input, or applies_to excluding this provider/model). A proxy-path
 * firing acts only when the pattern's YAML lifecycle mode is enforce AND its `proxy` field is enforce; a proxy-path
 * `off` records nothing.
 */
export function dispositionOf(lc: Pick<Lifecycle, "status" | "mode" | "proxy" | "exceptions" | "applies_to">, input = "", env: NodeJS.ProcessEnv = process.env, now = Date.now(), path: "hook" | "proxy" = "hook"): Disposition {
  if (lc.status === "deprecated") return "off";
  if (path === "proxy") {
    if (lc.proxy === "off") return "off";
    if (lc.proxy === "monitor") return "monitor";
    // proxy: enforce acts only when the lifecycle mode is enforce too; a lifecycle monitor records only
    if (lc.mode !== "enforce") return "monitor";
  }
  const at = lc.applies_to;
  if (at?.providers?.length && !at.providers.includes(env.PAI_WORKER_PROVIDER ?? "session")) return "off";
  if (at?.models?.length && !at.models.includes(modelOf(env))) return "off";
  for (const e of lc.exceptions) {
    if (e.expires && Date.parse(e.expires) < now) continue;
    try {
      if (input && new RegExp(e.match).test(input)) return "off";
    } catch {
      /* validated at load */
    }
  }
  return lc.mode;
}

/** The model of the current run: the worker env, else `session`. */
export function modelOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAI_WORKER_MODEL || env.ANTHROPIC_MODEL || "session";
}
