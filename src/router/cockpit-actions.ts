/**
 * cockpit-actions.ts — the cockpit's POST /cockpit/action endpoint.
 *
 * Every action goes through the code path the CLI command already implements
 * (injected here so tests can mock it and the router process never spawns a
 * model server on its own): `pai worker local <tier>` (startTier / stopAll),
 * `pai worker classes set` (setClass), `pai config set` (setConfigValueOp /
 * unsetConfigValueOp). Each action appends one COCKPIT-ACTION line to the
 * routing ledger (who=cockpit, action, target, result) and answers
 * {ok, message}. local.switch / local.off run detached and answer at once
 * with a job id; the card shows progress from the inventory refresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendLedger, parseLedger } from "../workers/ledger.js";
import { ledgerPath, workersLogDir } from "../workers/paths.js";
import { readWorkersSection } from "../workers/config.js";
import { readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import { setClass } from "../workers/providers.js";
import { setConfigValueOp, unsetConfigValueOp } from "../config/main-config-ops.js";
import { readLocalConfig } from "../workers/local-tiers.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { readLocalStatus } from "../workers/local-status.js";

export const COCKPIT_ACTION_EVENT = "COCKPIT-ACTION";

export interface ActionDeps {
  /** `pai worker local <tier>`: stop every local server, start this tier. */
  startTier: (tierName: string) => Promise<void>;
  /** `pai worker local off`: stop every local server. */
  stopAll: () => Promise<void>;
  /** `pai worker classes set <class> <provider>`. */
  setClass: (cls: string, target: string) => void;
  /** `pai config set models.labels.<runtime>[/<model>] <label>`. */
  setLabel: (path: string, value: string, opts?: { force?: boolean }) => void;
  /** `pai config unset <path>`. */
  unsetLabel: (path: string) => void;
  /** The ledger file; default <logDir>/ledger.log. */
  ledger: string;
  /** workers.yaml path for tier lookup; default workersYamlPath(). */
  workersYaml: string;
  /** Tier names override (tests without a workers.yaml); default reads workersYaml. */
  tiers?: string[];
  /** PAI_HOME for job files; default process.env.PAI_HOME. */
  home: string;
  /** The worker config (providers/classes) for validation and role mapping. */
  workers: ReturnType<typeof readWorkersSection>["workers"];
  /** The daemon's local-status cache (the "stops X first" confirm text). */
  localStatus: ReturnType<typeof readLocalStatus>;
  /** Main config path override (tests); default the live config. */
  configPath?: string;
}

/** Everything the handler wires in production; tests replace the whole object. */
export interface ActionHooks {
  /** local.switch / local.off run through this (the router command wires the
   *  real spawn); tests inject a fake. */
  runLocalJob?: (kind: "switch" | "off", tier: string) => Promise<void>;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  jobId?: string;
}

/** The classes `pai worker classes` knows; the worker role maps all of them. */
export const WORKER_ROLE_CLASSES = ["draft", "plan", "implement", "review", "research", "spotcheck", "simple", "complex", "image"] as const;

/** The ledger line every action writes. */
export function writeLedgerLine(deps: ActionDeps, action: string, target: string, result: string): void {
  // `who=cockpit` first, so `tail` reads as a table (same shape as the WORKER-* lines)
  appendLedger(deps.ledger, COCKPIT_ACTION_EVENT, { who: "cockpit", action, target, result: result.replace(/\s+/g, "_") });
}

/** The job file of a local switch: <PAI_HOME>/cockpit-jobs/<id>.json. */
export function cockpitJobFile(home: string, id: string): string {
  return `${home}/cockpit-jobs/${id}.json`;
}

export interface LocalJobState {
  id: string;
  kind: "switch" | "off";
  tier: string;
  state: "running" | "done" | "failed";
  message: string;
  at: string;
}

/** The job's current state; null when the file is absent or unreadable. */
export function readCockpitJob(home: string, id: string): LocalJobState | null {
  if (!/^[a-z0-9]+$/i.test(id)) return null;
  try {
    const j = JSON.parse(readFileSync(cockpitJobFile(home, id), "utf8")) as LocalJobState;
    return j && typeof j.id === "string" ? j : null;
  } catch {
    return null;
  }
}

function writeJob(home: string, j: LocalJobState): void {
  const path = cockpitJobFile(home, j.id);
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify(j) + "\n", "utf8");
  } catch {
    /* the job answer already went out; the card just shows no progress */
  }
}

/** The running local model's name, for the "stops X first" confirm text. */
export function runningLocalModel(st: ReturnType<typeof readLocalStatus>): string | null {
  return st?.running ? `${st.running.provider} (${st.running.model})` : null;
}

/** The tier names in workers.yaml (same reader `pai worker local` uses). */
export function tierNames(yamlPath: string): string[] {
  try {
    return Object.keys(readLocalConfig(yamlPath).tiers);
  } catch {
    return [];
  }
}

/** The config path of a label: models.labels.<runtime> or models.labels.<runtime>.<model>. */
export function labelPath(runtime: string, model?: string): string {
  return model ? `models.labels.${runtime}.${model}` : `models.labels.${runtime}`;
}

/** The labels config block (runtime → {model → label} or a plain runtime label). */
export function readLabels(): Record<string, unknown> {
  try {
    const l = (readMainConfigRaw() as { models?: { labels?: unknown } }).models?.labels;
    return l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The label of a runtime (or one of its models), "" when none is set. */
export function labelFor(runtime: string, model?: string): string {
  const block = readLabels()[runtime];
  if (model) {
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const v = (block as Record<string, unknown>)[model];
      return typeof v === "string" ? v : "";
    }
    return "";
  }
  return typeof block === "string" ? block : "";
}

/** Which classes currently pin this provider (the "workers" toggle state). */
export function classesOnProvider(workers: ActionDeps["workers"], provider: string): string[] {
  return Object.entries(workers.classes)
    .filter(([, t]) => (typeof t === "string" ? t.split("/")[0] : t.provider) === provider)
    .map(([c]) => c);
}

/** The provider the orchestrate/chat side runs on: the session profile's chat
 *  provider when set, else the active provider ("" = the built-in anthropic). */
export function orchestratorProvider(workers: ActionDeps["workers"]): string {
  try {
    const p = (readWorkersSection().raw as { session?: { profile?: { chat?: { provider?: unknown } } } }).session?.profile?.chat?.provider;
    if (typeof p === "string" && p) return p;
  } catch {
    /* no profile: the active provider answers */
  }
  return workers.active && workers.active !== "auto" ? workers.active : "";
}

export function defaultDeps(): ActionDeps {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  return {
    startTier: async (tierName) => {
      const { startTier } = await import("../cli/commands/worker-config.js");
      const cfg = readLocalConfig(workersYamlPath());
      const tier = cfg.tiers[tierName];
      if (!tier) throw new Error(`no tier "${tierName}" (configured: ${Object.keys(cfg.tiers).join(", ") || "none"})`);
      await startTier(cfg, tierName, tier);
    },
    stopAll: async () => {
      const { stopAll } = await import("../cli/commands/worker-config.js");
      await stopAll(readLocalConfig(workersYamlPath()));
    },
    setClass: (cls, target) => void setClass(cls, target),
    setLabel: (path, value, opts) => void setConfigValueOp(path, value, opts),
    unsetLabel: (path) => void unsetConfigValueOp(path),
    ledger: ledgerPath(logDir),
    workersYaml: workersYamlPath(),
    home: process.env.PAI_HOME || "~/.pai",
    workers,
    localStatus: readLocalStatus(logDir),
  };
}

/**
 * Validate and run one action. Returns {ok, message}; local.switch / local.off
 * answer at once with a jobId and run through hooks.runLocalJob.
 */
export async function runCockpitAction(
  body: { action?: unknown; target?: unknown; value?: unknown; class?: unknown; models?: unknown; session?: unknown; clear?: unknown },
  deps: ActionDeps,
  hooks: ActionHooks = {}
): Promise<ActionResult> {
  const action = typeof body.action === "string" ? body.action : "";
  const target = typeof body.target === "string" ? body.target : "";
  const value = typeof body.value === "string" ? body.value : undefined;
  const fail = (message: string): ActionResult => {
    writeLedgerLine(deps, action || "?", target, `error: ${message}`);
    return { ok: false, message };
  };

  if (action === "local.switch") {
    const tiers = deps.tiers ?? tierNames(deps.workersYaml);
    if (!target || !tiers.includes(target)) return fail(`no tier "${target}" (configured: ${tiers.join(", ") || "none"})`);
    const id = randomBytes(6).toString("hex");
    writeJob(deps.home, { id, kind: "switch", tier: target, state: "running", message: `starting ${target}`, at: new Date().toISOString() });
    writeLedgerLine(deps, action, target, `job ${id}: started`);
    void finishLocalJob(deps, hooks, id, "switch", target);
    return { ok: true, message: `switching to ${target}`, jobId: id };
  }
  if (action === "local.off") {
    const id = randomBytes(6).toString("hex");
    writeJob(deps.home, { id, kind: "off", tier: "", state: "running", message: "stopping local servers", at: new Date().toISOString() });
    writeLedgerLine(deps, action, target || "-", `job ${id}: started`);
    void finishLocalJob(deps, hooks, id, "off", "");
    return { ok: true, message: "stopping local model servers", jobId: id };
  }
  if (action === "model.label") {
    if (!target) return fail("target (runtime) required");
    const runtime = target;
    // value "model:<id>=<label>" labels one model; a plain value labels the runtime;
    // an empty (or label-less model:) value removes the entry
    let model: string | undefined;
    let label = value ?? "";
    if (value !== undefined && value.startsWith("model:")) {
      const rest = value.slice(6);
      const eq = rest.indexOf("=");
      if (eq >= 0) {
        model = rest.slice(0, eq);
        label = rest.slice(eq + 1);
      } else {
        model = rest;
        label = "";
      }
    }
    const path = labelPath(runtime, model);
    // the config writer validates against DEFAULTS; models.* is not a known
    // top-level key there, so this label block writes with force (same as
    // `pai config set models.labels.<rt> <label> --force`)
    try {
      if (!label.trim()) {
        deps.unsetLabel(path);
        writeLedgerLine(deps, action, path, "removed");
        return { ok: true, message: `label removed (${runtime}${model ? "/" + model : ""})` };
      }
      deps.setLabel(path, label, { force: true });
      writeLedgerLine(deps, action, path, `set:${label}`);
      return { ok: true, message: `labelled ${runtime}${model ? "/" + model : ""}: ${label}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (action === "cloud.role") {
    const role = value;
    if (!target) return fail("target (provider) required");
    if (role !== "worker" && role !== "orchestrator") return fail(`role must be worker or orchestrator, got "${role ?? ""}"`);
    const provider = target;
    if (provider !== "anthropic" && !deps.workers.providers[provider]) {
      return fail(`no provider named "${provider}"`);
    }
    try {
      if (role === "worker") {
        for (const cls of WORKER_ROLE_CLASSES) deps.setClass(cls, provider);
        writeLedgerLine(deps, action, provider, "role=worker: classes → " + provider);
        return { ok: true, message: `worker classes → ${provider}` };
      }
      // orchestrator: the chat side runs on this provider — the active provider
      // (the same code path `pai providers use` takes) plus the main config's
      // session.profile.chat, so the next session orchestrates on it.
      const { useProvider } = await import("../workers/providers.js");
      useProvider(provider);
      try {
        const raw = readMainConfigRaw();
        const session = (raw.session ?? {}) as Record<string, unknown>;
        const profile = (session.profile ?? {}) as Record<string, unknown>;
        const chat = (profile.chat ?? {}) as Record<string, unknown>;
        chat.provider = provider;
        profile.chat = chat;
        session.profile = profile;
        raw.session = session;
        writeMainConfigRaw(raw);
      } catch {
        /* the active provider alone still answers the toggle */
      }
      writeLedgerLine(deps, action, provider, "role=orchestrator: active → " + provider);
      return { ok: true, message: `orchestrator → ${provider}` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  return fail(`unknown action "${action}"`);
}

/** Runs the injected local job, records its outcome in the job file and ledger. */
async function finishLocalJob(deps: ActionDeps, hooks: ActionHooks, id: string, kind: "switch" | "off", tier: string): Promise<void> {
  const run = hooks.runLocalJob ?? (kind === "switch" ? () => deps.startTier(tier) : () => deps.stopAll());
  try {
    await run(kind, tier);
    writeJob(deps.home, { id, kind, tier, state: "done", message: kind === "off" ? "local servers stopped" : `${tier} up`, at: new Date().toISOString() });
    writeLedgerLine(deps, kind === "off" ? "local.off" : "local.switch", tier || "-", `job ${id}: done`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeJob(deps.home, { id, kind, tier, state: "failed", message: msg, at: new Date().toISOString() });
    writeLedgerLine(deps, kind === "off" ? "local.off" : "local.switch", tier || "-", `job ${id}: failed: ${msg}`);
  }
}

/** The ledger lines of cockpit actions (for the card's result text / history). */
export function cockpitActionLedger(ledgerFile: string, lastN = 10): string[] {
  if (!existsSync(ledgerFile)) return [];
  return parseLedger(readFileSync(ledgerFile, "utf8"))
    .filter((l) => l.event === COCKPIT_ACTION_EVENT)
    .slice(-lastN)
    .map((l) => `${l.stamp} ${l.fields.action ?? "?"} ${l.fields.target ?? "-"} ${l.fields.result ?? ""}`);
}
