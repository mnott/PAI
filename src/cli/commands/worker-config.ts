/**
 * `pai worker` configuration commands: providers, classes (alias roles), config,
 * local, bench, policy, fallback, pool, proxy, mcp, on, off, install, controls.
 * Names, flags and stdout match the old CLI (hooks, prompts and MCP tools call
 * them). `pai providers ...` shares the provider subcommands defined here.
 */

import { duplicateModelIds } from "../../router/router.js";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { CONFIG_FILE } from "../../daemon/config.js";
import {
  ANTHROPIC_NATIVE,
  PROVIDER_TAGS,
  WorkersConfigError,
  expandHome,
  getProviderOrNative,
  nativeAnthropicProvider,
  readWorkersSection,
  type ClassTarget,
  type WorkerProvider,
  type WorkersConfig,
} from "../../workers/config.js";
import { applyPolicyToRoutes, clearSessionRoute, resolveSessionArg, routeRows, routeText, servingChip, setRoute, setSessionRoute } from "../../workers/route-table.js";
import { findTier, parseEntry } from "../../workers/route-lists.js";
import { budgetCache } from "../../workers/budget.js";
import { ledgerPath, workersLogDir } from "../../workers/paths.js";
import { appendLedger } from "../../workers/ledger.js";
import {
  inlineWorkersYamlKeys,
  initWorkersYaml,
  migrateWorkersToYaml,
  needsWorkersYamlRelocation,
  parseWorkersYamlDocument,
  relocateWorkersYaml,
  setLocalPreference,
  workersYamlLegacyNotice,
  workersYamlPath,
} from "../../workers/workers-config.js";
import { testProvider } from "../../workers/run.js";
import { currentLocalStatus, probeLoopback } from "../../workers/local-provider.js";
import { getProfile, readProfiles, sessionWorkersLine } from "../../workers/session-profile.js";
import { localStatusLine } from "../../workers/local-status.js";
import {
  addProvider,
  classTargetText,
  describeProviders,
  removeProvider,
  setClass,
  setProviderCap,
  setProviderEnabled,
  setWorkersEnabled,
  unsetClass,
  updateProvider,
} from "../../workers/providers.js";
import { activeTier, fetchServedModels, fmtRss, LocalTierError, parseServers, planStart, readLocalConfig, stopLines, type LocalConfig, type LocalTier, type RunningServer, type StartPlan } from "../../workers/local-tiers.js";
import { PROMPTS, aggregate, planArms, readSuiteRows, runBench, suiteTasks, writeResults, type Prompt } from "../../workers/bench.js";
import {
  POLICY_MODES,
  clearPolicy,
  findLocal,
  onBattery,
  parseDuration,
  readPolicy,
  routeRun,
  writePolicy,
  type PolicyMode,
} from "../../workers/policy.js";
import { fallbackOff, fallbackOn, fallbackStatus, fallbackStatusText } from "../../workers/fallback.js";
import { installWorkers } from "../../workers/install.js";
import { describeMcp } from "../../workers/mcp.js";
import { clickrControlsArgv, markControlsHeld } from "../../workers/controls.js";
import { loadStatus } from "../../workers/status.js";
import { DEFAULT_PROXY_PORT, ensureProxyRunning, stopProxy } from "../../workers/proxy/server.js";
import { CliError, type CommandDef, type Io, type OptDef, type RunContext } from "../define.js";
import { dim, err, ok, warn } from "../lib/utils.js";
import { useCommand } from "./providers.js";
import { psTable } from "../../workers/ps-table.js";

const out = (s = "") => void process.stdout.write(s + "\n");

/** Turn any failure into a plain sentence plus the command to try next. */
export function fail(e: unknown, hint?: string): never {
  if (e instanceof CliError) throw e;
  throw new CliError(e instanceof Error ? e.message : String(e), hint);
}

const logDir = (): string => workersLogDir(readWorkersSection().workers);

// ---------------------------------------------------------------------------
// Value parsers (same rules and messages as the old CLI)
// ---------------------------------------------------------------------------

export function collectEnv(pairs: string[] | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new WorkersConfigError(`--env expects NAME=VALUE, got "${p}"`);
    o[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return o;
}

export function parseCostTier(v: string): number {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new WorkersConfigError(`cost tier must be an integer 1 (cheapest) … 5 (most expensive), got "${v}"`);
  }
  return n;
}

export function collectTags(vals: string[] | undefined): string[] {
  const o: string[] = [];
  for (const v of vals ?? []) {
    for (const t of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!(PROVIDER_TAGS as readonly string[]).includes(t)) {
        throw new WorkersConfigError(`"${t}" is not a tag (from: ${PROVIDER_TAGS.join(", ")})`);
      }
      if (!o.includes(t)) o.push(t);
    }
  }
  return o;
}

const csv = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

export interface ClassSetOpts {
  provider?: string;
  mcp?: string;
  maxCostTier?: number;
  requireTags?: string[];
  order?: string;
}

/** Positional target + constraint flags → a ClassTarget for setClass. */
export function buildClassTarget(target: string | undefined, opts: ClassSetOpts): ClassTarget {
  const hasConstraints =
    opts.provider !== undefined || opts.mcp !== undefined || opts.maxCostTier !== undefined ||
    opts.requireTags !== undefined || opts.order !== undefined;
  if (target !== undefined && !hasConstraints) return target;
  const obj: Exclude<ClassTarget, string> = {};
  if (target !== undefined) obj.provider = target.split("/")[0];
  if (opts.provider !== undefined) obj.provider = opts.provider;
  if (opts.mcp !== undefined) obj.mcp = csv(opts.mcp);
  if (opts.maxCostTier !== undefined) obj.maxCostTier = opts.maxCostTier;
  if (opts.requireTags !== undefined) obj.requireTags = opts.requireTags;
  if (opts.order !== undefined) obj.order = csv(opts.order);
  if (target !== undefined && target.includes("/") && obj.provider) {
    const alias = target.split("/")[1];
    if (alias && alias !== "default") {
      throw new WorkersConfigError(
        `a provider alias ("${alias}") cannot be combined with constraint flags — use the plain "<target>" form for pinning`
      );
    }
  }
  if (!Object.keys(obj).length) {
    throw new WorkersConfigError("give a target (provider, provider/fast) or a constraint (--max-cost-tier, --require-tags, …)");
  }
  return obj;
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

const PROVIDERS_HINT = "pai worker providers";
const tagsHelp = `Capability tags, comma-separated (from: ${PROVIDER_TAGS.join(", ")})`;
const costTierOpt: OptDef = { name: "cost-tier", type: "string", value: "1-5", summary: "Cost tier: 1 (cheapest) to 5 (most expensive; default 3)" };

async function printProviders(): Promise<void> {
  const { workers } = readWorkersSection();
  const running = await probeLoopback(workers);
  out();
  for (const line of describeProviders(workers, CONFIG_FILE, running)) out(`  ${line}`);
  out();
  out(dim(`  workers are ${workers.enabled ? "on" : "off"} — pai worker ${workers.enabled ? "off" : "on"}`));
  const legacyNotice = workersYamlLegacyNotice();
  if (legacyNotice) out(dim(`  ${legacyNotice}`));
  out();
}

const providersListCommand: CommandDef = {
  name: "list",
  summary: "List providers, their models and whether workers are on",
  description: "Shows every configured provider with its models, cost tier and state. This is also what `pai worker providers` prints on its own.",
  examples: ["pai worker providers list", "pai worker providers"],
  seeAlso: ["pai providers", "pai worker providers add"],
  async run() {
    try {
      const line = await sessionWorkersLine();
      if (line) out(line);
      await printProviders();
    } catch (e) {
      fail(e, "pai worker config check");
    }
  },
};

const providersAddCommand: CommandDef = {
  name: "add",
  summary: "Add a provider (the first one also turns workers on)",
  description:
    "Adds a provider that workers can run on. The first provider you add also turns workers on and sets up the default classes.\n" +
    "Give the API token with --key (stored in workers.yaml, file kept private) or --key-file (path to a private file holding it), not both.\n" +
    "OpenAI-style APIs: --protocol openai --upstream-url URL (runs through the local proxy).\n" +
    "ChatGPT plan through the Codex CLI: --engine codex. Image generation: --engine image.",
  args: [{ name: "NAME", required: true, summary: "Name for the new provider, e.g. glm" }],
  options: [
    { name: "base-url", type: "string", value: "URL", summary: "Anthropic-compatible API base URL (required unless --protocol openai)" },
    { name: "url", type: "string", value: "URL", summary: "Same as --base-url" },
    { name: "model", type: "string", value: "ID", summary: "Default model id for this provider (required)" },
    { name: "key", type: "string", value: "TOKEN", summary: "API token, written into workers.yaml; use instead of --key-file" },
    { name: "key-file", type: "string", value: "PATH", summary: "File holding the API token (kept private); leave out for a local server" },
    { name: "fast-model", type: "string", value: "ID", summary: "Cheaper model for quick checks and routing" },
    { name: "env", type: "string", value: "NAME=VALUE", repeatable: true, summary: "Extra environment variable for runs (repeat for several)" },
    { name: "note", type: "string", value: "TEXT", summary: "Short note shown in the provider list" },
    { name: "protocol", type: "string", value: "KIND", summary: "anthropic (default) or openai" },
    { name: "upstream-url", type: "string", value: "URL", summary: "Chat Completions base URL (required for --protocol openai)" },
    { name: "engine", type: "string", value: "KIND", summary: "claude (default), codex, or image" },
    { name: "context-window", type: "number", value: "TOKENS", summary: "Context window for the usage meter (default 200000)" },
    { name: "quota-probe", type: "string", value: "URL", summary: "URL whose JSON first number is the quota percent (0-100)" },
    { ...costTierOpt },
    { name: "tags", type: "string", value: "LIST", repeatable: true, summary: tagsHelp },
  ],
  examples: [
    "pai worker providers add glm --url https://api.example.invalid/anthropic --key-file ~/glm.key --model glm-5.3 --fast-model glm-5.3-flash",
    "pai worker providers add local --protocol openai --upstream-url http://127.0.0.1:8080/v1 --model qwen",
  ],
  seeAlso: ["pai worker providers use", "pai worker providers list"],
  async run(ctx) {
    try {
      const o = ctx.opts;
      const name = ctx.args.NAME as string;
      const protocol = o.protocol as "anthropic" | "openai" | undefined;
      const engine = o.engine as "claude" | "codex" | "image" | undefined;
      if (o.model === undefined) throw new WorkersConfigError("--model is required (the default model id for this provider)");
      if (protocol && protocol !== "anthropic" && protocol !== "openai") {
        throw new WorkersConfigError(`--protocol must be anthropic or openai, got "${protocol}"`);
      }
      if (engine && engine !== "claude" && engine !== "codex" && engine !== "image") {
        throw new WorkersConfigError(`--engine must be claude, codex, or image, got "${engine}"`);
      }
      const baseUrl = (o["base-url"] ?? o.url) as string | undefined;
      if (protocol !== "openai" && !baseUrl) {
        throw new WorkersConfigError("--base-url (or --url) is required (only --protocol openai goes without it)");
      }
      if (o.key && o["key-file"]) throw new WorkersConfigError("--key and --key-file are alternatives — pass one, not both");
      const costTier = o["cost-tier"] !== undefined ? parseCostTier(String(o["cost-tier"])) : undefined;
      const tags = collectTags(ctx.multi?.tags);
      addProvider({
        name,
        baseUrl: baseUrl ?? "",
        keyFile: (o["key-file"] as string | undefined) ?? null,
        ...(o.key ? { inlineKey: o.key as string } : {}),
        model: o.model as string,
        fastModel: o["fast-model"] as string | undefined,
        env: collectEnv(ctx.multi?.env),
        note: o.note as string | undefined,
        ...(protocol ? { protocol } : {}),
        ...(o["upstream-url"] ? { upstreamUrl: o["upstream-url"] as string } : {}),
        ...(engine ? { engine } : {}),
        ...(o["context-window"] ? { contextWindow: o["context-window"] as number } : {}),
        quotaProbe: o["quota-probe"] as string | undefined,
        ...(costTier !== undefined ? { costTier } : {}),
        ...(tags.length ? { tags } : {}),
      });
      const { workers } = readWorkersSection();
      out(ok(`provider ${name} added`));
      if (workers.active === name) out(`  active: ${name} — workers ${workers.enabled ? "on" : "off"}`);
      for (const line of describeProviders(workers, CONFIG_FILE, await probeLoopback(workers))) out(dim(`  ${line}`));
    } catch (e) {
      fail(e, PROVIDERS_HINT);
    }
  },
};

const providersUpdateCommand: CommandDef = {
  name: "update",
  summary: "Change a provider's cost tier and tags",
  description: "Routing constraints (--max-cost-tier, --require-tags on a class) look at these two settings.",
  args: [{ name: "NAME", required: true, summary: "Provider to change" }],
  options: [
    { ...costTierOpt },
    { name: "tags", type: "string", value: "LIST", repeatable: true, summary: `${tagsHelp}; --tags '' clears them` },
  ],
  examples: ["pai worker providers update glm --cost-tier 2", "pai worker providers update glm --tags long-context,reasoning"],
  seeAlso: ["pai worker providers list"],
  async run(ctx) {
    try {
      const name = ctx.args.NAME as string;
      const hasTier = ctx.opts["cost-tier"] !== undefined;
      const hasTags = ctx.multi?.tags !== undefined;
      if (!hasTier && !hasTags) throw new WorkersConfigError("nothing to update — pass --cost-tier and/or --tags");
      const costTier = hasTier ? parseCostTier(String(ctx.opts["cost-tier"])) : undefined;
      const tags = hasTags ? collectTags(ctx.multi!.tags) : undefined;
      updateProvider(name, { ...(costTier !== undefined ? { costTier } : {}), ...(tags !== undefined ? { tags } : {}) });
      out(ok(`provider ${name} updated`));
      const { workers } = readWorkersSection();
      for (const line of describeProviders(workers, CONFIG_FILE, await probeLoopback(workers))) out(dim(`  ${line}`));
    } catch (e) {
      fail(e, PROVIDERS_HINT);
    }
  },
};

const providersRemoveCommand: CommandDef = {
  name: "remove",
  summary: "Remove a provider and the classes pointing at it",
  description: "Deletes the provider from workers.yaml. Classes pinned to it are removed too.",
  args: [{ name: "NAME", required: true, summary: "Provider to remove" }],
  examples: ["pai worker providers remove glm", "pai worker providers list"],
  seeAlso: ["pai worker providers add"],
  run(ctx) {
    try {
      removeProvider(ctx.args.NAME as string);
      out(ok(`provider ${ctx.args.NAME} removed`));
    } catch (e) {
      fail(e, PROVIDERS_HINT);
    }
  },
};

const enableDisable = (enable: boolean): CommandDef => ({
  name: enable ? "enable" : "disable",
  summary: enable ? "Turn a provider on (also clears its cooldown)" : "Turn a provider off (automatic routing skips it)",
  description: enable
    ? "Makes the provider usable again and clears any cooldown after hitting a limit."
    : "Automatic routing skips a disabled provider. Naming it with --provider still works.",
  args: [{ name: "NAME", required: true, summary: "Provider name" }],
  examples: [`pai worker providers ${enable ? "enable" : "disable"} glm`, "pai worker providers list"],
  seeAlso: [`pai worker providers ${enable ? "disable" : "enable"}`],
  run(ctx) {
    try {
      setProviderEnabled(ctx.args.NAME as string, enable);
      out(ok(`provider ${ctx.args.NAME} ${enable ? "enabled" : "disabled"}`));
    } catch (e) {
      fail(e, PROVIDERS_HINT);
    }
  },
});

/** The provider a worker run would use now: the t2 tier's first available entry, else the active provider. */
async function resolveTestTarget(workers: WorkersConfig, logDir: string): Promise<{ name: string; provider: WorkerProvider; why: string } | null> {
  const tier = findTier(workers.tiers, "t2");
  if (tier) {
    const rows = await routeRows({ ...workers, tiers: [tier] }, { logDir });
    const chip = servingChip(rows[0]?.chips ?? []);
    if (chip) {
      const { provider } = parseEntry(chip.entry);
      const p = getProviderOrNative(workers, provider);
      if (p) return { name: provider, provider: p, why: `routing uses it now (${tier.id}: ${chip.label})` };
    }
  }
  // no entry of the row serves: the active provider stands unless the row
  // itself is the routing (a row with entries means routing decides)
  const active = workers.active && workers.active !== "auto" ? workers.active : null;
  if (active && !(tier && tier.models.length)) {
    const p = getProviderOrNative(workers, active);
    if (p) return { name: active, provider: p, why: "the active provider" };
  }
  return null;
}

const providersTestCommand: CommandDef = {
  name: "test",
  summary: "Check a provider answers — without a name, what workers would use now",
  description:
    "With a NAME, sends a tiny prompt through that provider and prints the reply and the time it took; exits 1 if it does not answer. " +
    "Without a NAME it tests the provider routing would use for a worker now: the t2 tier's first available entry, else the active provider. " +
    "The built-in `anthropic` provider is Claude Code's own login: it probes the local `claude` CLI (installed and logged in) and never needs an API key.",
  args: [{ name: "NAME", summary: "Provider to test (default: what routing would use now)" }],
  examples: ["pai worker providers test", "pai worker providers test glm"],
  seeAlso: ["pai worker providers list", "pai worker route"],
  async run(ctx, io?) {
    try {
      const name = ctx.args.NAME as string | undefined;
      const { workers } = readWorkersSection();
      const logDir = workersLogDir(workers);
      let pname: string;
      let provider: WorkerProvider;
      let why: string;
      if (name) {
        // the built-in login is synthesized; any other name must exist
        const p = name === ANTHROPIC_NATIVE ? nativeAnthropicProvider(workers.nativeModels) : workers.providers[name];
        if (!p) throw new WorkersConfigError(`no provider named "${name}"`);
        pname = name;
        provider = p;
        why = "named";
      } else {
        // the built-in login is never a tier entry: with no routing target and
        // no active provider, workers run on it (the default), so test it
        const target = await resolveTestTarget(workers, logDir);
        if (target) {
          ({ name: pname, provider, why } = target);
        } else if (!workers.active || workers.active === "auto") {
          pname = ANTHROPIC_NATIVE;
          provider = nativeAnthropicProvider(workers.nativeModels);
          why = "the default: no active provider";
        } else {
          throw new WorkersConfigError(
            `no provider available for a worker right now — add one with: pai worker providers add <name> --url <url> --model <model> --key-file <path>, ` +
              `or make one the active provider with: pai worker providers use <name> (see: pai worker providers)`
          );
        }
      }
      io?.out(dim(`  probing ${pname} (${provider.models.default}) — ${why} …`));
      const r = await testProvider(pname, provider, logDir, undefined, io?.run ? { run: io.run } : undefined);
      const head = `${r.provider} ${r.model}  ${(r.latencyMs / 1000).toFixed(1)}s`;
      const say = (s: string) => void (io?.out(s) ?? out(s));
      if (r.skipped) {
        say(dim(`  ${head}  ${r.skipped}`));
        say(`  next: ${r.result.slice(0, 200)}`);
        return 0;
      }
      say(r.ok ? ok(`  ${head}`) : err(`  ${head}`));
      say(`  reply: ${r.result.slice(0, 200)}`);
      return r.ok ? 0 : 1;
    } catch (e) {
      fail(e, PROVIDERS_HINT);
    }
  },
};

/** The provider subcommands except `use` (shared with `pai providers`, see providers.ts). */
const providersCapCommand: CommandDef = {
  name: "cap",
  summary: "Show or set how many workers run in parallel on a provider",
  description:
    "Without N, shows the provider's effective cap and where it comes from (config or default). " +
    "N (>= 1) writes maxConcurrent to workers.yaml; `default` removes it again. " +
    "Unset, a local provider runs one worker at a time and a cloud provider is uncapped.",
  args: [
    { name: "PROVIDER", required: true, summary: "Provider name" },
    { name: "N", summary: "Parallel runs (>= 1), or `default` to unset" },
  ],
  options: [
    { name: "slots", type: "string", value: "N", summary: "Conversation-cache slots of the engine (writes conversationSlots; `default` removes it). Admitted workers stay one below it." },
  ],
  examples: ["pai worker providers cap local", "pai worker providers cap local 2", "pai worker providers cap local default", "pai worker providers cap local --slots 4"],
  seeAlso: ["pai worker providers", "pai worker queue"],
  run(ctx) {
    try {
      const name = ctx.args.PROVIDER as string;
      const raw = ctx.args.N as string | undefined;
      let cap: number | "default" | undefined;
      if (raw !== undefined) {
        cap = raw === "default" ? "default" : Number(raw);
        if (cap !== "default" && (!Number.isInteger(cap) || cap < 1)) throw new WorkersConfigError(`cap must be an integer >= 1 or "default", got "${raw}"`);
      }
      const slotsRaw = ctx.opts.slots as string | undefined;
      let slots: number | "default" | undefined;
      if (slotsRaw !== undefined) {
        slots = slotsRaw === "default" ? "default" : Number(slotsRaw);
        if (slots !== "default" && (!Number.isInteger(slots) || slots < 1)) throw new WorkersConfigError(`--slots must be an integer >= 1 or "default", got "${slotsRaw}"`);
      }
      const { effective } = setProviderCap(name, cap, undefined, slots);
      out(ok(`${name}: ${effective}`));
    } catch (e) {
      fail(e, "pai worker providers");
    }
  },
};

export const PROVIDER_EDIT_COMMANDS: CommandDef[] = [
  providersAddCommand,
  providersUpdateCommand,
  providersRemoveCommand,
  enableDisable(true),
  enableDisable(false),
  providersTestCommand,
  providersCapCommand,
];

export const workerProvidersCommand: CommandDef = {
  name: "providers",
  summary: "Providers workers can run on: list, add, remove, use, enable, disable, test",
  description:
    "Without a subcommand, lists the providers. `use` makes one the active provider (the same command as `pai providers use`).\n" +
    "The configuration lives in workers.yaml (see `pai worker config path`).",
  examples: ["pai worker providers", "pai worker providers use glm", "pai worker providers test glm"],
  seeAlso: ["pai providers", "pai worker classes", "pai worker config"],
  subcommands: [providersListCommand, useCommand, ...PROVIDER_EDIT_COMMANDS],
  run: (ctx: RunContext, io?: Io) => providersListCommand.run!(ctx, io),
};

// ---------------------------------------------------------------------------
// classes (alias: roles)
// ---------------------------------------------------------------------------

function printClasses(): void {
  const { workers } = readWorkersSection();
  const entries = Object.entries(workers.classes);
  // the delegation table (tiers) carries the class -> tier mapping
  const mapped = workers.tiers.flatMap((t) => (t.classes ?? []).map((cls) => [cls, t] as const));
  if (!entries.length && !mapped.length) return void out(dim("  no classes set — runs use the active provider (or auto routing)"));
  for (const [cls, target] of entries) out(`  ${cls.padEnd(12)} ${classTargetText(target)}`);
  for (const [cls, t] of mapped) if (!(cls in workers.classes)) out(`  ${cls.padEnd(12)} ${t.id} (${t.name}): ${t.models.join(" > ")}`);
}

const classListCommand: CommandDef = {
  name: "list",
  summary: "List classes and where each one runs",
  description: "A class is a kind of job (draft, implement, review, …). This shows the provider each one is sent to.",
  examples: ["pai worker classes list", "pai worker classes"],
  seeAlso: ["pai worker classes set"],
  run() {
    try {
      printClasses();
    } catch (e) {
      fail(e, "pai worker config check");
    }
  },
};

const classSetCommand: CommandDef = {
  name: "set",
  summary: "Send a class to a provider, or give it routing limits",
  description:
    "Point a class at a provider (or provider/fast for its cheap model), or give only limits and let routing choose, for example:\n" +
    "pai worker classes set research --max-cost-tier 2 --require-tags long-context,reasoning",
  args: [
    { name: "CLASS", required: true, summary: "Class name, e.g. draft, implement, review" },
    { name: "TARGET", summary: "Provider, or provider/fast" },
  ],
  options: [
    { name: "provider", type: "string", value: "NAME", summary: "Pin the class to this provider (object form)" },
    { name: "mcp", type: "string", value: "NAMES", summary: "MCP servers or sets for runs of this class (comma-separated)" },
    { name: "max-cost-tier", type: "string", value: "1-5", summary: "Automatic routing considers only providers up to this cost tier" },
    { name: "require-tags", type: "string", value: "LIST", summary: "Automatic routing needs these tags (comma-separated)" },
    { name: "order", type: "string", value: "LIST", summary: "Provider order for this class (comma-separated)" },
  ],
  examples: ["pai worker classes set draft glm", "pai worker classes set research --max-cost-tier 2 --require-tags long-context"],
  seeAlso: ["pai worker classes unset", "pai worker classes list"],
  run(ctx) {
    try {
      const o = ctx.opts;
      const built = buildClassTarget(ctx.args.TARGET as string | undefined, {
        provider: o.provider as string | undefined,
        mcp: o.mcp as string | undefined,
        maxCostTier: o["max-cost-tier"] !== undefined ? parseCostTier(String(o["max-cost-tier"])) : undefined,
        requireTags: o["require-tags"] !== undefined ? csv(String(o["require-tags"])) : undefined,
        order: o.order as string | undefined,
      });
      setClass(ctx.args.CLASS as string, built);
      out(ok(`class ${ctx.args.CLASS} → ${classTargetText(built)}`));
    } catch (e) {
      fail(e, "pai worker classes list");
    }
  },
};

const classUnsetCommand: CommandDef = {
  name: "unset",
  summary: "Remove a class (runs then use the active provider)",
  description: "Deletes the class setting. Jobs of that class go to the active provider.",
  args: [{ name: "CLASS", required: true, summary: "Class to remove" }],
  examples: ["pai worker classes unset draft", "pai worker classes list"],
  seeAlso: ["pai worker classes set"],
  run(ctx) {
    try {
      unsetClass(ctx.args.CLASS as string);
      out(ok(`class ${ctx.args.CLASS} removed`));
    } catch (e) {
      fail(e, "pai worker classes list");
    }
  },
};

export const workerClassesCommand: CommandDef = {
  name: "classes",
  summary: "Which provider serves draft, implement, review, …",
  description: "Classes are kinds of worker jobs. Each can be pinned to a provider or given routing limits. Without a subcommand, lists them.",
  examples: ["pai worker classes", "pai worker classes set review kimi"],
  seeAlso: ["pai worker providers", "pai worker policy"],
  subcommands: [classListCommand, classSetCommand, classUnsetCommand],
  run: (ctx: RunContext, io?: Io) => classListCommand.run!(ctx, io),
};

export const workerRolesCommand: CommandDef = {
  ...workerClassesCommand,
  name: "roles",
  summary: "Old name of `classes`",
  description: "Roles were renamed to classes. Same data, kept so old scripts keep working.",
  hidden: true,
  examples: ["pai worker roles", "pai worker classes"],
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const CONFIG_HINT = "pai worker config check";

const configPathCommand: CommandDef = {
  name: "path",
  summary: "Print where workers.yaml is",
  description: "Prints the path of the file that holds your providers and classes.",
  examples: ["pai worker config path", "pai worker config check"],
  seeAlso: ["pai worker config check"],
  run() {
    out(workersYamlPath());
  },
};

const configInitCommand: CommandDef = {
  name: "init",
  summary: "Write a commented starter workers.yaml",
  description: "Creates workers.yaml with explanations. Refuses if one already exists.",
  examples: ["pai worker config init", "pai worker config path"],
  seeAlso: ["pai worker config check"],
  run() {
    try {
      out(ok(`wrote ${initWorkersYaml()}`));
    } catch (e) {
      fail(e, "pai worker config path");
    }
  },
};

const configMigrateCommand: CommandDef = {
  name: "migrate",
  summary: "Move or build workers.yaml from an older setup",
  description:
    "Does one of two things, chosen from what is on disk:\n" +
    "  - workers.yaml is still at an old location: moved unchanged to the current one; the old file is renamed to workers.yaml.migrated-DATE.\n" +
    "  - no workers.yaml yet: built from the workers section of config.json, which is backed up to workers.json.migrated-DATE.",
  options: [
    { name: "force", type: "boolean", summary: "Overwrite an existing workers.yaml" },
    { name: "dry-run", type: "boolean", summary: "Print the plan without writing anything" },
  ],
  examples: ["pai worker config migrate --dry-run", "pai worker config migrate"],
  seeAlso: ["pai worker config check"],
  run(ctx) {
    try {
      const force = ctx.opts.force === true;
      if (needsWorkersYamlRelocation()) {
        const r = relocateWorkersYaml({ force, dryRun: ctx.dryRun });
        if (r.dryRun) return void out(dim(`# would move ${r.fromPath} → ${r.toPath}`));
        return void out(ok(`moved ${r.fromPath} → ${r.toPath}`));
      }
      const r = migrateWorkersToYaml(CONFIG_FILE, { force, dryRun: ctx.dryRun });
      if (r.dryRun) {
        out(dim(`# would write ${r.yamlPath}:`));
        out(r.yamlText);
        return;
      }
      out(ok(`wrote ${r.yamlPath}`));
      out(`  JSON workers section backed up to ${r.backupPath}`);
      out();
      const { workers } = readWorkersSection(CONFIG_FILE);
      for (const line of describeProviders(workers)) out(`  ${line}`);
    } catch (e) {
      fail(e, "pai worker config migrate --dry-run");
    }
  },
};

const configCheckCommand: CommandDef = {
  name: "check",
  summary: "Check workers.yaml for mistakes",
  description: "Validates workers.yaml (or the file at PATH). On an error it exits 1 and names the file and line.",
  args: [{ name: "PATH", summary: "File to check (default: your workers.yaml)" }],
  examples: ["pai worker config check", "pai worker config check ./workers.yaml"],
  seeAlso: ["pai worker config path"],
  run(ctx) {
    try {
      const target = (ctx.args.PATH as string | undefined) ?? workersYamlPath();
      if (!existsSync(target)) return void out(dim(`no workers.yaml at ${target} — JSON config fallback is in effect`));
      const doc = parseDocument(readFileSync(target, "utf8"));
      if (doc.errors.length) throw new WorkersConfigError(`${target}: ${doc.errors[0]!.message}`);
      const data = parseWorkersYamlDocument(doc, target);
      out(ok(`${target} OK — ${Object.keys(data.providers).length} provider(s), ${Object.keys(data.classes).length} class(es)`));
      const both = Object.entries(data.providers).filter(([, p]) => p.key && p.keyFile).map(([n]) => n);
      if (both.length) out(dim(`  note: ${both.join(", ")} — both key and key_file set; key wins`));
      for (const d of duplicateModelIds(data.providers)) {
        out(warn(`  warning: model id ${d.model} is declared by ${d.providers.join(", ")} — the router prefers the one that is up; give them distinct ids or disable one`));
      }
      const mode = statSync(target).mode & 0o777;
      if (Object.values(data.providers).some((p) => p.key) && mode !== 0o600) {
        out(warn(`  warning: ${target} contains a key: field but is mode ${mode.toString(8)} — chmod 600 ${target}`));
      }
      const legacyNotice = workersYamlLegacyNotice();
      if (legacyNotice) out(dim(`  ${legacyNotice}`));
    } catch (e) {
      fail(e, "pai worker config path");
    }
  },
};

const configInlineKeysCommand: CommandDef = {
  name: "inline-keys",
  summary: "Move key files' contents into workers.yaml",
  description: "For each provider that uses a key file, writes the key into workers.yaml. The key files stay on disk.",
  options: [{ name: "dry-run", type: "boolean", summary: "Show the plan (provider names and paths, never keys); write nothing" }],
  examples: ["pai worker config inline-keys --dry-run", "pai worker config inline-keys"],
  seeAlso: ["pai worker config check"],
  run(ctx) {
    try {
      const r = inlineWorkersYamlKeys({ dryRun: ctx.dryRun });
      if (!r.inlined.length) return void out(dim("no providers have a key_file without an inline key — nothing to do"));
      for (const { provider, keyFilePath } of r.inlined) {
        out((r.dryRun ? dim("  would inline ") : ok("  inlined ")) + `${provider} (was ${keyFilePath})`);
      }
      if (r.dryRun) return void out(dim("  dry run — nothing written"));
      out(ok(`wrote ${r.yamlPath}`));
      out(dim("  key files left on disk — remove them yourself if you no longer need them:"));
      for (const { keyFilePath } of r.inlined) out(dim(`    ${expandHome(keyFilePath)}`));
    } catch (e) {
      fail(e, CONFIG_HINT);
    }
  },
};

export const workerConfigCommand: CommandDef = {
  name: "config",
  summary: "The workers.yaml file itself: path, init, migrate, check, inline-keys",
  description: "`pai worker providers` and `classes` change what is inside workers.yaml; these commands deal with the file.",
  examples: ["pai worker config path", "pai worker config check"],
  seeAlso: ["pai worker providers", "pai worker classes"],
  subcommands: [configPathCommand, configInitCommand, configMigrateCommand, configCheckCommand, configInlineKeysCommand],
};

// ---------------------------------------------------------------------------
// local
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** pids listening on each script tier's port (lsof), for the tiers that start from a script. */
function scriptListeners(cfg: LocalConfig): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const t of Object.values(cfg.tiers)) {
    if (t.engine !== "script") continue;
    try {
      const o = execFileSync("lsof", ["-nP", `-iTCP:${t.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      out[t.port] = o.split(/\s+/).filter(Boolean).map(Number);
    } catch {
      /* nothing listens (lsof exits 1) */
    }
  }
  return out;
}

export function listServers(cfg: LocalConfig): RunningServer[] {
  const o = psTable("pid=,rss=,command=");
  return parseServers(o, cfg, process.pid, scriptListeners(cfg));
}

/** Stop every local server PAI knows, then wait until their ports are free. */
export async function stopAll(cfg: LocalConfig): Promise<void> {
  for (const s of listServers(cfg)) process.kill(s.pid, "SIGTERM");
  const deadline = Date.now() + 60_000;
  while (listServers(cfg).length > 0 && Date.now() < deadline) await sleep(1000);
  for (const s of listServers(cfg)) process.kill(s.pid, "SIGKILL");
  const ports = [...new Set(Object.values(cfg.tiers).map((t) => t.port))];
  const freeBy = Date.now() + 30_000;
  while (Date.now() < freeBy && (await Promise.all(ports.map(isUp))).some(Boolean)) await sleep(1000);
}

export async function isUp(port: number): Promise<boolean> {
  return (await fetchServedModels(port)) !== null;
}

/** The active tier (its port answers with its model name), null when none. */
export async function currentTier(cfg: LocalConfig): Promise<LocalTier | null> {
  return activeTier(cfg, fetchServedModels);
}

export interface StartDeps {
  /** workers.yaml whose `local:` follows the switch (default: the live one). */
  yamlPath?: string;
  /** Ledger file for the LOCAL-SWITCH line (default: the workers ledger). */
  ledger?: string;
  stop?: (cfg: LocalConfig) => Promise<void>;
  up?: (port: number) => Promise<boolean>;
  current?: (cfg: LocalConfig) => Promise<LocalTier | null>;
  /** Start the server; returns its exit code while it has exited, null while it runs. */
  launch?: (plan: StartPlan) => () => number | null;
  pollMs?: number;
}

function launchDetached(plan: StartPlan): () => number | null {
  mkdirSync(dirname(plan.logPath), { recursive: true });
  const fd = openSync(plan.logPath, "w");
  const [cmd, ...args] = plan.argv;
  const child = spawn(cmd, args, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  closeSync(fd);
  return () => child.exitCode;
}

/**
 * Stop every local server, start `tier`'s and wait until it answers; then
 * point workers.yaml `local:` at the tier's provider and write LOCAL-SWITCH.
 */
export async function startTier(
  cfg: LocalConfig,
  target: string,
  tier: LocalTier,
  plan: StartPlan = planStart(cfg, tier),
  deps: StartDeps = {},
): Promise<void> {
  const from = await (deps.current ?? currentTier)(cfg).catch(() => null);
  await (deps.stop ?? stopAll)(cfg);
  const exited = (deps.launch ?? launchDetached)(plan);
  out(dim(`starting ${tier.label} (${tier.provider}) on :${tier.port}, log ${plan.logPath}`));
  const up = deps.up ?? isUp;
  const deadline = Date.now() + plan.readyMs;
  while (!(await up(tier.port))) {
    const code = exited();
    // a script may hand off to a background server and exit 0
    if (code !== null && !(tier.engine === "script" && code === 0)) throw new LocalTierError(`server exited (${code}); see ${plan.logPath}`);
    if (Date.now() > deadline) throw new LocalTierError(`not ready after ${Math.round(plan.readyMs / 60000)} min; see ${plan.logPath}`);
    await sleep(deps.pollMs ?? 5000);
  }
  const yamlPath = deps.yamlPath ?? workersYamlPath();
  setLocalPreference(yamlPath, tier.provider);
  appendLedger(deps.ledger ?? ledgerPath(workersLogDir(readWorkersSection().workers)), "LOCAL-SWITCH", {
    from: from?.tier ?? "none",
    to: tier.tier,
    provider: tier.provider,
  });
  const s = listServers(cfg).find((x) => x.port === tier.port);
  out(ok(`${target} up: ${tier.provider} on port ${tier.port}${s ? `, rss ${fmtRss(s.rssKb)}` : ""}`));
}

async function printLocalStatus(cfg: LocalConfig): Promise<void> {
  const servers = listServers(cfg);
  const active = await currentTier(cfg);
  if (servers.length === 0) out(dim("no local model server running"));
  for (const s of servers) {
    out(`${s.tier ?? "?"}  provider=${s.provider ?? "?"}  port=${s.port ?? "?"}  pid=${s.pid}  rss=${fmtRss(s.rssKb)}`);
  }
  out(active ? `active: ${active.tier} (${active.label})` : dim("active: none"));
  out(dim(`tiers: ${Object.keys(cfg.tiers).join(", ") || "(none configured)"}`));
}

export const workerLocalCommand: CommandDef = {
  name: "local",
  summary: "Which local model runs; the operator switches tiers",
  description:
    "Without TARGET: one line with the running local model (the daemon's answer, `--local` runs on it). Sessions never probe ports or start servers.\n" +
    "TARGET is a tier name (stops every local server — vllm-mlx, Strata, scripts — starts that tier, points workers.yaml local: at it), `off` (stops all) or `status` (what is up).\n" +
    "Tiers are listed under local_tiers: in workers.yaml. This does not change where workers are routed (see `pai worker policy`).",
  args: [{ name: "TARGET", required: false, summary: "A tier name, off, or status; omit for the running local model" }],
  options: [{ name: "dry-run", type: "boolean", summary: "Print the exact commands without starting or stopping anything" }],
  examples: ["pai worker local", "pai worker local status", "pai worker local big --dry-run"],
  seeAlso: ["pai worker policy", "pai worker config path"],
  async run(ctx) {
    try {
      const target = ctx.args.TARGET as string | undefined;
      if (!target) {
        const line = await sessionWorkersLine();
        if (line) out(line);
        return void out(localStatusLine(await currentLocalStatus()));
      }
      const cfg = readLocalConfig(workersYamlPath());
      if (target === "status") return void (await printLocalStatus(cfg));
      if (target === "off") {
        if (ctx.dryRun) return void stopLines(cfg).forEach((l) => out(l));
        await stopAll(cfg);
        return void out(ok("local model servers stopped"));
      }
      const tier = cfg.tiers[target];
      if (!tier) throw new LocalTierError(`no tier "${target}" (configured: ${Object.keys(cfg.tiers).join(", ") || "none"})`);
      const plan = planStart(cfg, tier);
      if (ctx.dryRun) {
        for (const l of stopLines(cfg)) out(l);
        out("sleep 10");
        out(plan.line);
        out(`until curl -s -m 3 http://127.0.0.1:${tier.port}/v1/models > /dev/null; do sleep 5; done`);
        return;
      }
      await startTier(cfg, target, tier, plan);
    } catch (e) {
      fail(e, "pai worker local status");
    }
  },
};

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

export const workerBenchCommand: CommandDef = {
  name: "bench",
  summary: "Compare providers on a set of real tasks",
  description:
    "For each task × provider × repeat, runs the suite's run.sh and then grade.sh, prints pass counts, median time and turns per provider, and writes results.md into the suite folder.\n" +
    "Providers are named explicitly: a measurement ignores `pai worker policy`.",
  options: [
    { name: "suite", type: "string", value: "DIR", summary: "Suite folder with run.sh, grade.sh and tasks/NAME/ (required)" },
    { name: "providers", type: "string", value: "LIST", summary: "Comma-separated providers, e.g. anthropic,local30" },
    { name: "tasks", type: "string", value: "LIST", summary: "Comma-separated task names (default: all)" },
    { name: "prompt", type: "string", value: "KIND", default: "task", summary: `Prompt file kind: ${PROMPTS.join("|")}` },
    { name: "repeat", type: "string", value: "N", default: "1", summary: "Runs per task and provider" },
    { name: "max-parallel", type: "string", value: "N", default: "3", summary: "Runs going at once" },
    { name: "max-load", type: "string", value: "N", default: "60", summary: "Start no run while the 1-minute load average is above this" },
    { name: "dry-run", type: "boolean", summary: "Print the plan only" },
    { name: "report", type: "boolean", summary: "Only summarise the suite's existing rows.tsv into results.md; run nothing" },
  ],
  examples: ["pai worker bench --suite ./suite --providers anthropic,glm --dry-run", "pai worker bench --suite ./suite --report"],
  seeAlso: ["pai worker providers"],
  async run(ctx) {
    try {
      const o = ctx.opts;
      if (o.suite === undefined) throw new Error("--suite is required (the suite folder)");
      const suite = resolve(o.suite as string);
      if (o.report) {
        const rows = readSuiteRows(suite);
        out(aggregate(rows));
        out(writeResults(suite, rows));
        return;
      }
      const prompt = String(o.prompt);
      if (!PROMPTS.includes(prompt as Prompt)) throw new Error(`--prompt must be one of ${PROMPTS.join(", ")}`);
      if (!o.providers) throw new Error("--providers is required");
      for (const f of ["run.sh", "grade.sh"]) if (!existsSync(join(suite, f))) throw new Error(`${suite}/${f} missing`);
      const all = suiteTasks(suite);
      const tasks = o.tasks ? String(o.tasks).split(",") : all;
      const unknown = tasks.filter((t) => !all.includes(t));
      if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(", ")}`);
      const arms = planArms(tasks, String(o.providers).split(","), prompt as Prompt, Math.max(1, Number(o.repeat) || 1));
      out(`${arms.length} arm(s), prompt ${prompt}, max ${o["max-parallel"]} parallel, load gate ${o["max-load"]}`);
      if (ctx.dryRun) {
        for (const a of arms) out(`${a.task}\t${a.provider}\t${a.prompt}\t#${a.repeat}`);
        return;
      }
      const rows = await runBench({ suite, arms, maxParallel: Number(o["max-parallel"]), maxLoad: Number(o["max-load"]), log: (s) => out(s) });
      out(aggregate(rows));
      out(writeResults(suite, rows));
    } catch (e) {
      fail(e, "pai help worker bench");
    }
  },
};

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export const workerPolicyCommand: CommandDef = {
  name: "policy",
  summary: "Where workers run: cloud, local, or a mix",
  description:
    "With no mode, shows the policy and the route the next run would take. A mode sets it; `clear` removes it (class and active-provider routing as before).\n" +
    "  cloud-only    never local (battery, on the road)\n" +
    "  local-only    never cloud (saves tokens); fails if no local server answers\n" +
    "  prefer-local  local first; a local run with a bad report is repeated once on the cloud\n" +
    "  prefer-cloud  cloud first (fast turnaround); local only when the cloud is unavailable\n" +
    "  auto          prefer-local, but cloud on battery and for an --urgent run\n" +
    "Per run you can add --urgent, --local-ok or --cloud; --provider beats the policy.",
  args: [{ name: "MODE", summary: `${POLICY_MODES.join(", ")} or clear` }],
  options: [{ name: "for", type: "string", value: "DURATION", summary: "Expire the policy after 30m, 2h, 1d …" }],
  examples: ["pai worker policy", "pai worker policy prefer-local --for 2h"],
  seeAlso: ["pai worker local", "pai worker providers"],
  async run(ctx) {
    try {
      const mode = ctx.args.MODE as string | undefined;
      const config = readWorkersSection().workers;
      const dir = workersLogDir(config);
      if (mode === "clear") {
        clearPolicy(dir);
        return void out("policy: none (class/active routing)");
      }
      if (mode !== undefined) {
        if (!(POLICY_MODES as readonly string[]).includes(mode)) {
          throw new Error(`policy: expected one of ${POLICY_MODES.join(", ")}, clear — got "${mode}"`);
        }
        const p = writePolicy(dir, mode as PolicyMode, ctx.opts.for ? parseDuration(String(ctx.opts.for)) : undefined);
        // one setting: the policy rewrites the route lists of implement / simple / spotcheck
        const text = applyPolicyToRoutes(p.mode);
        out(`policy: ${p.mode}${p.until ? ` until ${p.until}` : ""}`);
        return void out(`routes: ${text || "no class list to rewrite"}`);
      }
      const p = readPolicy(dir);
      out(`policy: ${p ? `${p.mode}${p.until ? ` until ${p.until}` : ""}` : "none (class/active routing)"}`);
      const local = await findLocal(config, dir);
      out(`local:   ${local.name ?? local.why}`);
      out(`battery: ${onBattery() ? "yes" : "no"}`);
      const r = await routeRun(config, dir, {}).catch((e: Error) => ({ error: e.message }));
      if (r && "error" in r) out(`next run: fails — ${r.error}`);
      else if (r) out(`next run: ${r.providerFlag ?? "cloud"} (${r.route.reason})`);
    } catch (e) {
      fail(e, "pai worker policy");
    }
  },
};

// ---------------------------------------------------------------------------
// fallback, pool, proxy, mcp, on, off, install, controls
// ---------------------------------------------------------------------------

export const workerRouteCommand: CommandDef = {
  name: "route",
  summary: "Print the routing table: per delegation tier the ordered models",
  description:
    "One row per delegation tier of workers.yaml `tiers:` (typically t0 Session: the interactive session itself; t1 Orchestrator: splits a job, plans, reviews; t2 Worker: implements the parts and runs quick checks), each an ordered list of models: the first available one serves, the rest is the fallback order (a tier is not a fallback rank). The first line is the flow, what each tier resolves to right now. Local models (\"local gyro-m\") are entries like any other; one whose server is not running is skipped, never started. `pai worker policy` rewrites the default tier's list.\n" +
    "`route set <tier|class> <provider/model,...>` sets a row (a class sets its tier's row): a cloud entry is provider/model (glm/glm-5.3-flash, anthropic/opus, glm/fast), a local one the provider name (gyro-m). --note adds the reason (tooltip). Tiers, their classes and descriptions are edited in workers.yaml.\n" +
    "--session <name|self> makes it a per-session override stored in that session's profile (`route set --session s <tier|class> <models>`, `route clear --session s [<tier|class>]`); runs started from that session use its row, else the global one. `route --session s` prints the effective table for that session.",
  args: [
    { name: "ACTION", summary: "set or clear (omit to print)" },
    { name: "CLASS", summary: "A tier id (t0, t1, t2, ... as configured) or a class (it sets its tier)" },
    { name: "MODELS", summary: "Comma-separated provider/model entries, first serves" },
  ],
  options: [
    { name: "session", type: "string", value: "NAME", summary: "Per-session override: a session name or self" },
    { name: "note", type: "string", value: "TEXT", summary: "Reason for the row (tooltip), e.g. \"context width, reasoning\"" },
  ],
  examples: ["pai worker route", "pai worker route set t2 gyro-m,anthropic/sonnet,glm/glm-5.3-flash --note \"context width, reasoning\"", "pai worker route set --session self t2 anthropic/sonnet", "pai worker route clear --session self t2", "pai worker route --session self"],
  seeAlso: ["pai worker policy", "pai worker classes"],
  async run(ctx) {
    try {
      const sessionOpt = ctx.opts.session as string | undefined;
      const note = ctx.opts.note as string | undefined;
      const action = ctx.args.ACTION as string | undefined;
      if (action === "set") {
        const cls = String(ctx.args.CLASS ?? "");
        const models = String(ctx.args.MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
        if (sessionOpt !== undefined) return void out(`route: ${setSessionRoute(await resolveSessionArg(sessionOpt), cls, models, { note }).text}`);
        return void out(`route: ${setRoute(cls, models, undefined, note).text}`);
      }
      if (action === "clear") {
        if (sessionOpt === undefined) throw new Error("route clear needs --session <name|self> (the global row is changed with route set)");
        return void out(`route: ${clearSessionRoute(await resolveSessionArg(sessionOpt), ctx.args.CLASS ? String(ctx.args.CLASS) : undefined)}`);
      }
      if (action) throw new Error(`unknown action "${action}" (set, clear)`);
      const { workers } = readWorkersSection();
      const logDir = workersLogDir(workers);
      const p = readPolicy(logDir);
      out(`policy: ${p ? p.mode : "none"}`);
      if (sessionOpt !== undefined) {
        const name = await resolveSessionArg(sessionOpt);
        out(`session: ${name}`);
        return void out(routeText(await routeRows(workers, { logDir, budgets: budgetCache.snapshot(), session: getProfile(name) })));
      }
      out(routeText(await routeRows(workers, { logDir, budgets: budgetCache.snapshot(), profiles: readProfiles() })));
    } catch (e) {
      fail(e, "pai worker route");
    }
  },
};

export const workerFallbackCommand: CommandDef = {
  name: "fallback",
  summary: "Run every new Claude Code process on a worker provider",
  description:
    "`on [PROVIDER]` switches (default: the active provider) by writing env and a model pin into settings.json; `off` restores settings.json exactly; `status` shows the state and running sessions (also the default).\n" +
    "Set CLAUDE_SETTINGS_PATH to another settings.json for a dry run.",
  args: [
    { name: "ACTION", summary: "on, off or status (default: status)" },
    { name: "PROVIDER", summary: "With on: provider to switch to" },
  ],
  examples: ["pai worker fallback status", "CLAUDE_SETTINGS_PATH=/tmp/settings.json pai worker fallback on glm"],
  seeAlso: ["pai worker providers use", "pai worker policy"],
  run(ctx) {
    try {
      const action = ctx.args.ACTION as string | undefined;
      if (action === undefined || action === "status") return void out(fallbackStatusText(fallbackStatus()).join("\n"));
      if (action === "on") {
        const r = fallbackOn(ctx.args.PROVIDER as string | undefined);
        out(
          r.alreadyOn
            ? `fallback already on — provider ${r.provider}, env re-applied`
            : `fallback on — provider ${r.provider}; every new Claude Code process uses it`
        );
        out(`  settings.json env: ${r.envKeys.join(", ")}`);
        out(`  model pin: ${r.model}`);
        out("running sessions keep their current provider until restarted (see: pai worker fallback status)");
        return;
      }
      if (action === "off") {
        const r = fallbackOff();
        out(`fallback off — provider ${r.provider} released, settings.json restored`);
        out(`  restored keys: ${r.envKeys.join(", ")}`);
        return;
      }
      throw new WorkersConfigError(`unknown fallback action "${action}" (expected: on, off, status)`);
    } catch (e) {
      fail(e, "pai worker fallback status");
    }
  },
};

export const workerPoolCommand: CommandDef = {
  name: "pool",
  summary: "Keep headless worker sessions warm between small runs",
  description:
    "Long-lived headless claude slots that successive small runs talk to, so the provider's prompt cache carries over.\n" +
    "`on` starts the background host and enables routing, `off` stops both, `status` (default) shows slots, tasks served and cache savings. Default is off.",
  args: [{ name: "ACTION", summary: "on, off or status (default: status)" }],
  examples: ["pai worker pool status", "pai worker pool on"],
  seeAlso: ["pai worker on"],
  async run(ctx) {
    try {
      const action = ctx.args.ACTION as string | undefined;
      const { poolOn, poolOff, poolStatusText } = await import("../../workers/pool-cli.js");
      if (action === undefined || action === "status") return void out(await poolStatusText(logDir()));
      if (action === "on") return void (await poolOn(logDir())).forEach((l) => out(l));
      if (action === "off") return void (await poolOff(logDir())).forEach((l) => out(l));
      throw new WorkersConfigError(`unknown pool action "${action}" (expected: on, off, status)`);
    } catch (e) {
      fail(e, "pai worker pool status");
    }
  },
};

export const workerProxyCommand: CommandDef = {
  name: "proxy",
  summary: "The local proxy for OpenAI-style providers",
  description: "Starts (or checks) the loopback-only Anthropic-to-OpenAI proxy. `run` starts it on demand anyway; `proxy stop` stops it again.",
  args: [{ name: "STOP", summary: "Write stop to stop the proxy" }],
  options: [{ name: "port", type: "number", value: "N", summary: `Port to listen on (default ${DEFAULT_PROXY_PORT})` }],
  examples: ["pai worker proxy", "pai worker proxy stop"],
  seeAlso: ["pai worker providers add"],
  async run(ctx) {
    try {
      const stop = ctx.args.STOP as string | undefined;
      if (stop === "stop") return void out(stopProxy(logDir()));
      if (stop) throw new WorkersConfigError(`unknown proxy argument "${stop}" (expected: stop)`);
      const url = await ensureProxyRunning((ctx.opts.port as number | undefined) ?? DEFAULT_PROXY_PORT, logDir());
      out(`proxy listening on ${url} — point openai providers at ${url}/<provider>`);
    } catch (e) {
      fail(e, "pai worker proxy");
    }
  },
};

export const workerMcpCommand: CommandDef = {
  name: "mcp",
  summary: "MCP servers workers may load",
  description: "Lists the MCP servers a worker can be given with --mcp or a class, and the configured sets.",
  args: [{ name: "LIST", summary: "Optional word list (the default)" }],
  examples: ["pai worker mcp", "pai worker mcp list"],
  seeAlso: ["pai worker classes set"],
  run(ctx) {
    try {
      const what = ctx.args.LIST as string | undefined;
      if (what && what !== "list") throw new WorkersConfigError(`unknown mcp argument "${what}" (expected: list)`);
      out(describeMcp(readWorkersSection().workers).join("\n"));
    } catch (e) {
      fail(e, "pai worker mcp");
    }
  },
};

export const workerOnCommand: CommandDef = {
  name: "on",
  summary: "Send Agent-tool subagents to workers",
  description: "Turns worker routing on (the default once a provider exists). The Agent hook then denies the Agent tool and suggests `pai worker run`.",
  examples: ["pai worker on", "pai worker off"],
  seeAlso: ["pai worker off"],
  run() {
    try {
      setWorkersEnabled(true);
      out("workers on — the Agent hook now denies and suggests `pai worker run`");
    } catch (e) {
      fail(e, "pai worker providers");
    }
  },
};

export const workerOffCommand: CommandDef = {
  name: "off",
  summary: "Stop routing: Agent tool runs on Anthropic again",
  description: "Turns worker routing off. Subagents started with the Agent tool run on Anthropic as usual.",
  examples: ["pai worker off", "pai worker on"],
  seeAlso: ["pai worker on"],
  run() {
    try {
      setWorkersEnabled(false);
      out("workers off — Agent-tool subagents run on Anthropic");
    } catch (e) {
      fail(e, "pai worker providers");
    }
  },
};

export const workerInstallCommand: CommandDef = {
  name: "install",
  summary: "Set up the Agent hook and command shims",
  description: "Adds the Agent hook to settings.json, writes the glm* shims in ~/.local/bin and cleans up old scripts. Safe to run again.",
  examples: ["pai worker install", "pai worker providers"],
  seeAlso: ["pai worker on"],
  run() {
    try {
      for (const line of installWorkers().lines) out(`  ${line}`);
    } catch (e) {
      fail(e, "pai worker providers");
    }
  },
};

/** The argv `controls` hands to clickr (kept separate so it can be tested). */
export function controlsArgv(id: string, who: string, pid: number): string[] {
  return clickrControlsArgv(id, who as "you" | "me", pid);
}

export const workerControlsCommand: CommandDef = {
  name: "controls",
  summary: "Hand the desktop controls to a worker, or take them back",
  description:
    "WHO is `you` (the worker becomes the exclusive holder of the desktop controls; needs clickr with --agent support) or `me` (you take them back).\n" +
    "Inside a worker's pane, typing \"your controls\" does the same.",
  args: [
    { name: "ID", required: true, summary: "Worker id (see `pai worker ps`)" },
    { name: "WHO", required: true, summary: "you or me" },
  ],
  examples: ["pai worker controls 20260101-120000-1234 you", "pai worker controls 20260101-120000-1234 me"],
  seeAlso: ["pai worker ps"],
  run(ctx) {
    const id = ctx.args.ID as string;
    const who = ctx.args.WHO as string;
    if (who !== "you" && who !== "me") throw new CliError(`<who> must be "you" or "me"`, `pai worker controls ${id} me`);
    let status: ReturnType<typeof loadStatus>;
    const dir = (() => {
      try {
        return logDir();
      } catch (e) {
        return fail(e, "pai worker config check");
      }
    })();
    try {
      status = loadStatus(dir, id);
    } catch (e) {
      fail(e, "pai worker ps");
    }
    if (!status) throw new CliError(`no worker named "${id}"`, "pai worker ps");
    return new Promise<number>((done) => {
      const proc = spawn("clickr", controlsArgv(id, who, status!.pid), { stdio: "inherit" });
      proc.on("error", (e) => {
        process.stderr.write(err(`pai: cannot run clickr controls: ${e.message} (is clickr installed?)`) + "\n");
        done(1);
      });
      proc.on("close", (code) => {
        if (code === 0) {
          if (who === "you") markControlsHeld(dir, id);
          out(`controls → ${who === "you" ? `${id} (exclusive; needs clickr with --agent support)` : "operator"}`);
        }
        done(code ?? 1);
      });
    });
  },
};

/** The `worker` subcommands this file owns, in help order. */
export const WORKER_CONFIG_COMMANDS: CommandDef[] = [
  workerProvidersCommand,
  workerClassesCommand,
  workerRolesCommand,
  workerConfigCommand,
  workerPolicyCommand,
  workerRouteCommand,
  workerLocalCommand,
  workerFallbackCommand,
  workerPoolCommand,
  workerProxyCommand,
  workerMcpCommand,
  workerOnCommand,
  workerOffCommand,
  workerInstallCommand,
  workerControlsCommand,
  workerBenchCommand,
];
