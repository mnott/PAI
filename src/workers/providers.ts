/**
 * providers.ts — provider, class and switch management over the workers config.
 *
 * One layer under both `pai worker providers …` and the MCP worker_providers
 * tool. Every mutation re-reads the config file, changes only the workers
 * section, and writes it back atomically — the file is shared with everything
 * else PAI runs, so a torn write is not an option.
 *
 * Keys are never stored in the config and never accepted inline from the CLI:
 * only file paths. (The MCP `add` tool additionally accepts a raw `key`, which
 * it immediately parks in ~/.config/pai/keys/<name>, mode 0600, storing only
 * the path — a chat is not a place to leave a credential lying around.)
 */

import { existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import {
  ANTHROPIC_NATIVE,
  DEFAULT_LOG_DIR,
  MODEL_CAPABILITIES,
  PROVIDER_TAGS,
  WorkersConfigError,
  expandHome,
  isModelCapability,
  keysDir,
  nativeAnthropicProvider,
  parseWorkersConfig,
  providerCostTier,
  readWorkersSection,
  writeWorkersSection,
  type ClassTarget,
  type ModelCapability,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { clearCooldown, probeQuota, quotaSkipThreshold } from "./routing.js";
import { workersLogDir } from "./paths.js";

export interface AddProviderInput {
  name: string;
  baseUrl: string;
  keyFile?: string | null;
  key?: string;
  model: string;
  fastModel?: string;
  env?: Record<string, string>;
  note?: string;
  protocol?: "anthropic" | "openai";
  upstreamUrl?: string;
  engine?: "claude" | "codex";
  quotaProbe?: string;
  contextWindow?: number;
  costTier?: number;
  tags?: string[];
}

export function addProvider(input: AddProviderInput): WorkersConfig {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.name)) {
    throw new WorkersConfigError(
      `provider name "${input.name}" may only contain letters, digits, - and _`
    );
  }
  if (input.protocol === "openai" && !input.upstreamUrl) {
    throw new WorkersConfigError(
      `protocol "openai" needs the upstreamUrl (the Chat Completions base, ` +
        `e.g. "https://api.openai.com/v1") — the PAI proxy translates to it.`
    );
  }
  if (!input.baseUrl && input.protocol !== "openai") {
    throw new WorkersConfigError("baseUrl is required");
  }

  let keyFile = input.keyFile ?? null;
  if (input.key !== undefined) {
    const dir = keysDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = `${dir}/${input.name}`;
    writeFileSync(path, input.key.trim() + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* mode above already applied on create where supported */
    }
    keyFile = path;
  }

  const { raw, workers } = readWorkersSection();
  const provider: WorkerProvider = {
    enabled: true,
    protocol: input.protocol ?? "anthropic",
    baseUrl: input.baseUrl,
    keyFile,
    models: input.fastModel
      ? { default: input.model, fast: input.fastModel }
      : { default: input.model },
    env: input.env ?? {},
    ...(input.note ? { note: input.note } : {}),
    ...(input.upstreamUrl ? { upstreamUrl: input.upstreamUrl } : {}),
    ...(input.engine && input.engine !== "claude" ? { engine: input.engine } : {}),
    ...(input.quotaProbe ? { quotaProbe: input.quotaProbe } : {}),
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.costTier ? { costTier: input.costTier } : {}),
    ...(input.tags?.length ? { tags: input.tags as WorkerProvider["tags"] } : {}),
  };
  workers.providers[input.name] = provider;

  // First provider takes over the whole section: active, default classes, pane.
  const first = Object.keys(workers.providers).length === 1;
  if (first) {
    workers.enabled = true;
    workers.active = input.name;
    workers.logDir = workers.logDir || DEFAULT_LOG_DIR;
    const fast = input.fastModel ? `${input.name}/fast` : input.name;
    workers.classes = {
      draft: fast,
      plan: input.name,
      implement: input.name,
      review: input.name,
      research: input.name,
      spotcheck: fast,
      simple: fast,
      complex: input.name,
      image: input.name,
    };
  }

  writeWorkersSection(raw, workers);
  return workers;
}

/** Change costTier / tags on an existing provider (MCP action "update"). */
export function updateProvider(
  name: string,
  changes: { costTier?: number; tags?: string[] }
): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  const p = workers.providers[name];
  if (!p) {
    throw new WorkersConfigError(
      `no provider named "${name}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
    );
  }
  if (changes.costTier !== undefined) {
    if (!Number.isInteger(changes.costTier) || changes.costTier < 1 || changes.costTier > 5) {
      throw new WorkersConfigError("costTier must be an integer 1 (cheapest) … 5 (most expensive)");
    }
    p.costTier = changes.costTier;
  }
  if (changes.tags !== undefined) {
    for (const t of changes.tags) {
      if (!(PROVIDER_TAGS as readonly string[]).includes(t)) {
        throw new WorkersConfigError(`"${t}" is not a tag (from: ${PROVIDER_TAGS.join(", ")})`);
      }
    }
    p.tags = changes.tags as WorkerProvider["tags"];
  }
  writeWorkersSection(raw, workers);
  return workers;
}

export function removeProvider(name: string): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  if (!workers.providers[name]) {
    throw new WorkersConfigError(`no provider named "${name}"`);
  }
  delete workers.providers[name];
  for (const [cls, target] of Object.entries(workers.classes)) {
    const targetProvider = typeof target === "string" ? target.split("/")[0] : target.provider;
    if (targetProvider === name) delete workers.classes[cls];
  }
  if (workers.active === name) workers.active = null;
  writeWorkersSection(raw, workers);
  return workers;
}

export function useProvider(name: string): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  if (name !== ANTHROPIC_NATIVE && !workers.providers[name]) {
    throw new WorkersConfigError(
      `no provider named "${name}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
    );
  }
  workers.active = name;
  writeWorkersSection(raw, workers);
  return workers;
}

/** Which model capability of a provider a set touches (MODEL_CAPABILITIES). */
export type ModelSlot = ModelCapability;

/**
 * The provider a model command targets: the named one, else the active one.
 * "auto" and an unset active both ask for an explicit name.
 */
export function resolveProviderName(workers: WorkersConfig, name?: string): string {
  const target = name ?? workers.active ?? "";
  if (workers.providers[target]) return target;
  if (!target) throw new WorkersConfigError("no active provider — name one explicitly");
  if (target === "auto") {
    throw new WorkersConfigError('active is "auto" — name a provider explicitly');
  }
  throw new WorkersConfigError(
    `no provider named "${target}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
  );
}

/**
 * Set a provider's model id for a capability — default, fast, image, …
 * (`pai worker model`, MCP worker_model).
 */
export function setProviderModel(
  name: string,
  capability: ModelCapability,
  model: string,
  configPath?: string
): WorkersConfig {
  if (!isModelCapability(capability)) {
    throw new WorkersConfigError(
      `"${capability}" is not a model capability (from: ${MODEL_CAPABILITIES.join(", ")})`
    );
  }
  const id = model.trim();
  if (!id) throw new WorkersConfigError(`a ${capability} model id must not be empty`);
  const { raw, workers } = readWorkersSection(configPath);
  const p = workers.providers[name];
  if (!p) {
    throw new WorkersConfigError(
      `no provider named "${name}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
    );
  }
  p.models[capability] = id;
  writeWorkersSection(raw, workers, configPath);
  return workers;
}

export function setProviderEnabled(name: string, enabled: boolean): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  const p = workers.providers[name];
  if (!p) throw new WorkersConfigError(`no provider named "${name}"`);
  p.enabled = enabled;
  writeWorkersSection(raw, workers);
  // `enable` is also the manual cooldown-clear (spec: routing)
  if (enabled) clearCooldown(workersLogDir(parseWorkersConfig(raw.workers)), name);
  return workers;
}

/**
 * Point a class at a target ("provider", "provider/fast", or an object with
 * provider + optional mcp/maxCostTier/requireTags/order). An object without
 * a provider only constrains auto-routing for that class.
 */
export function setClass(name: string, target: ClassTarget): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  if (typeof target === "string") {
    const [provider, alias] = target.split("/");
    const native = provider === ANTHROPIC_NATIVE;
    const p = native ? undefined : workers.providers[provider];
    if (!native && !p) {
      throw new WorkersConfigError(
        `no provider named "${provider}" in "${target}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
      );
    }
    if (alias) {
      if (!isModelCapability(alias)) {
        throw new WorkersConfigError(
          `unknown model alias "${alias}" — providers expose: ${MODEL_CAPABILITIES.join(", ")}`
        );
      }
      // the native provider has no configurable model slots — any alias
      // resolves through resolveModelCapability's own default fallback
      if (!native && alias !== "default" && !p!.models[alias]) {
        throw new WorkersConfigError(`provider "${provider}" has no ${alias} model configured`);
      }
    }
  } else if (target.provider) {
    if (target.provider !== ANTHROPIC_NATIVE && !workers.providers[target.provider]) {
      throw new WorkersConfigError(
        `no provider named "${target.provider}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
      );
    }
  }
  workers.classes[name] = target;
  writeWorkersSection(raw, workers);
  return workers;
}

export function unsetClass(name: string): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  if (!(name in workers.classes)) {
    throw new WorkersConfigError(`no class named "${name}"`);
  }
  delete workers.classes[name];
  writeWorkersSection(raw, workers);
  return workers;
}

export function setWorkersEnabled(enabled: boolean): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  workers.enabled = enabled;
  writeWorkersSection(raw, workers);
  return workers;
}

/** `glm/fast` | `{provider, mcp, …}` → one printable target line. */
export function classTargetText(target: ClassTarget): string {
  if (typeof target === "string") return target;
  const bits = [
    target.provider ?? "(routing)",
    ...(target.mcp?.length ? [`mcp(${target.mcp.join(",")})`] : []),
    ...(target.maxCostTier !== undefined ? [`max tier ${target.maxCostTier}`] : []),
    ...(target.requireTags?.length ? [`needs ${target.requireTags.join(",")}`] : []),
    ...(target.order?.length ? [`order [${target.order.join(",")}]`] : []),
  ];
  return bits.join(" ");
}

/**
 * `default X  fast Y  image Z` — every model capability on one line, unset
 * ones shown as "(none)" (they resolve to the default model).
 */
export function modelPrefsText(p: WorkerProvider): string {
  return MODEL_CAPABILITIES.map((c) => `${c} ${p.models[c] ?? "(none)"}`).join("  ");
}

/**
 * Compact model listing for `pai worker model` / worker_model get: the active
 * provider, then one line per provider with all its capability preferences.
 */
export function describeModels(workers: WorkersConfig): string[] {
  const names = Object.keys(workers.providers);
  if (!names.length) {
    return ["no providers configured — add one with `pai worker providers add <name> …`"];
  }
  const lines = [`active provider: ${workers.active ?? "(none)"}`];
  for (const name of names) {
    const p = workers.providers[name];
    const active = workers.active === name ? "  [active]" : "";
    lines.push(`${name}${active}  ${modelPrefsText(p)}`);
  }
  return lines;
}

/** Human-readable provider listing (quota probe included when configured). */
export function describeProviders(workers: WorkersConfig): string[] {
  const lines: string[] = [];
  const nativeActive = workers.active === ANTHROPIC_NATIVE;
  lines.push(
    `${ANTHROPIC_NATIVE}  [built-in${nativeActive ? ", active" : ""}]  Claude Code's own OAuth/Max-plan login — no base URL, no API key`
  );
  lines.push(`    ${modelPrefsText(nativeAnthropicProvider())}`);
  const names = Object.keys(workers.providers);
  if (!names.length) {
    lines.push(`no other providers configured. Add one with:`);
    lines.push(
      `  pai worker providers add <name> --base-url <url> --key-file <path> --model <model>`
    );
    return lines;
  }
  for (const name of names) {
    const p = workers.providers[name];
    const flags = [
      p.enabled ? "enabled" : "disabled",
      workers.active === name ? "active" : null,
    ].filter(Boolean);
    const quota = p.quotaProbe ? probeQuota(p) : null;
    const quotaNote = quota === null ? "" : `  quota ${quota}% (skip at ${quotaSkipThreshold(p)})`;
    const tierTags = [`tier ${providerCostTier(p)}`, ...(p.tags ?? [])].join(", ");
    lines.push(`${name}  [${flags.join(", ")}]  ${p.baseUrl}`);
    lines.push(`    ${modelPrefsText(p)}${quotaNote}`);
    lines.push(`    ${tierTags}`);
    if (p.keyFile) lines.push(`    key file ${expandHome(p.keyFile)}`);
    else lines.push(`    no key file (token "local")`);
    if (p.note) lines.push(`    ${p.note}`);
    if (p.protocol === "openai") {
      lines.push(`    via PAI proxy ← ${p.upstreamUrl ?? "(upstreamUrl missing)"}`);
    }
    if (p.engine === "codex") {
      lines.push(`    engine codex (runs through the Codex CLI)`);
    }
  }
  const setNames = Object.keys(workers.mcpSets);
  if (setNames.length) {
    lines.push(`mcp sets: ${setNames.map((s) => `${s}=[${workers.mcpSets[s].join(",")}]`).join("  ")}`);
  }
  const classNames = Object.keys(workers.classes);
  if (classNames.length) {
    lines.push(`classes: ${classNames.map((cl) => `${cl}=${classTargetText(workers.classes[cl])}`).join("  ")}`);
  }
  if (workers.active === "auto") {
    lines.push(`routing: auto — order [${workers.routing.order.join(", ")}], cooldown ${workers.routing.cooldownMinutes}m`);
  }
  return lines;
}
