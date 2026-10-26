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
/** The three rule layers: baseline (security/environment, always as configured), behaviour (loops, same rule for every model, tuning per model), quirk (observed for specific models only). */
export const LAYERS = ["baseline", "behaviour", "quirk"] as const;
export type Layer = (typeof LAYERS)[number];
/** Layer derived from a pattern's category when the YAML sets no `layer` (shell and paths are baseline; tool-loop and final-text are behaviour). */
export function layerOfCategory(category: unknown): Layer {
  if (category === "shell" || category === "paths") return "baseline";
  return "behaviour";
}

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
  layer: Layer;
  applies_to?: { providers?: string[]; models?: string[] };
  /** Per-model tuning: the first matching entry (exact id beats a glob with `*`) overrides mode and/or detector params for that model. */
  per_model?: Record<string, { mode?: ProxyMode; params?: Record<string, unknown> }>;
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
  const layer: unknown = raw.layer === undefined ? layerOfCategory(raw.category) : raw.layer;
  if (typeof layer !== "string" || !(LAYERS as readonly string[]).includes(layer)) return `layer must be one of ${LAYERS.join(", ")}`;
  let per_model: Lifecycle["per_model"];
  if (raw.per_model !== undefined) {
    if (!isObj(raw.per_model)) return "per_model must be a mapping";
    per_model = {};
    for (const [k, v] of Object.entries(raw.per_model)) {
      if (!isObj(v)) return `per_model ${k} must be a mapping`;
      if (v.mode !== undefined && !(PROXY_MODES as readonly string[]).includes(v.mode as string)) return `per_model ${k}: mode must be one of ${PROXY_MODES.join(", ")}`;
      if (v.params !== undefined && !isObj(v.params)) return `per_model ${k}: params must be a mapping`;
      per_model[k] = { ...(v.mode !== undefined ? { mode: v.mode as ProxyMode } : {}), ...(v.params !== undefined ? { params: v.params as Record<string, unknown> } : {}) };
    }
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
    layer: layer as Layer,
    applies_to,
    per_model,
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
  set("layer", lc.layer);
  set("applies_to", lc.applies_to);
  set("per_model", lc.per_model);
  return out;
}

export type Disposition = "enforce" | "monitor" | "off";

/** What dispositionOf reads; proxy, applies_to, layer and per_model may be absent (an unscoped behaviour rule, hook path). */
export type DispositionInput = Pick<Lifecycle, "status" | "mode" | "exceptions"> & Partial<Pick<Lifecycle, "proxy" | "applies_to" | "layer" | "per_model">>;

const globMatch = (glob: string, s: string): boolean => {
  if (!glob.includes("*")) return glob === s;
  const re = new RegExp(`^${glob.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(s);
};

/** The per_model entry that applies to `model`: an exact id beats a glob; among globs the first declared wins. */
export function perModelEntry(per_model: Lifecycle["per_model"], model: string): { mode?: ProxyMode; params?: Record<string, unknown> } | undefined {
  if (!per_model) return undefined;
  if (per_model[model]) return per_model[model];
  for (const [k, v] of Object.entries(per_model)) if (k.includes("*") && globMatch(k, model)) return v;
  return undefined;
}

/**
 * What a firing means right now on the path it came from: `enforce` acts, `monitor` is recorded only, `off` is neither
 * (deprecated, an unexpired exception matching the input). Outside a behaviour/quirk rule's applies_to the firing is only
 * recorded (monitor); a baseline rule ignores applies_to and stays as configured. A per_model entry for the current
 * model overrides the mode. A proxy-path firing acts only when the resulting mode is enforce AND the pattern's `proxy`
 * field is enforce; a proxy-path `off` records nothing.
 */
export function dispositionOf(lc: DispositionInput, input = "", env: NodeJS.ProcessEnv = process.env, now = Date.now(), path: "hook" | "proxy" = "hook"): Disposition {
  if (lc.status === "deprecated") return "off";
  if (path === "proxy" && lc.proxy === "off") return "off";
  const mode = baseDisposition(lc, input, env, now);
  if (path === "proxy" && mode !== "off" && (lc.proxy === "monitor" || mode !== "enforce")) return "monitor";
  return mode;
}

function baseDisposition(lc: DispositionInput, input: string, env: NodeJS.ProcessEnv, now: number): Disposition {
  const model = modelOf(env);
  if (lc.layer !== "baseline") {
    const at = lc.applies_to;
    if (at?.providers?.length && !at.providers.includes(env.PAI_WORKER_PROVIDER ?? "session")) return "monitor";
    if (at?.models?.length && !at.models.some((m) => globMatch(m, model))) return "monitor";
  }
  const entry = perModelEntry(lc.per_model, model);
  if (entry?.mode) return entry.mode;
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

/** The detector params for one model: the pattern's params with the matching per_model entry's params merged over them. */
export function paramsForModel(params: Record<string, unknown>, lc: Pick<Lifecycle, "per_model">, model: string): Record<string, unknown> {
  const entry = perModelEntry(lc.per_model, model);
  return entry?.params ? { ...params, ...entry.params } : params;
}

/** The model of the current run: the worker env, else `session`. */
export function modelOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAI_WORKER_MODEL || env.ANTHROPIC_MODEL || "session";
}
