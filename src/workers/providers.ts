/**
 * providers.ts — provider, role and switch management over the workers config.
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
  DEFAULT_LOG_DIR,
  WorkersConfigError,
  expandHome,
  keysDir,
  parseWorkersConfig,
  readWorkersSection,
  writeWorkersSection,
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
  };
  workers.providers[input.name] = provider;

  // First provider takes over the whole section: active, default roles, pane.
  const first = Object.keys(workers.providers).length === 1;
  if (first) {
    workers.enabled = true;
    workers.active = input.name;
    workers.logDir = workers.logDir || DEFAULT_LOG_DIR;
    workers.roles = {
      implement: input.name,
      research: input.name,
      spotcheck: input.fastModel ? `${input.name}/fast` : input.name,
    };
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
  for (const [role, target] of Object.entries(workers.roles)) {
    const targetProvider = typeof target === "string" ? target.split("/")[0] : target.provider;
    if (targetProvider === name) delete workers.roles[role];
  }
  if (workers.active === name) workers.active = null;
  writeWorkersSection(raw, workers);
  return workers;
}

export function useProvider(name: string): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  if (!workers.providers[name]) {
    throw new WorkersConfigError(
      `no provider named "${name}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
    );
  }
  workers.active = name;
  writeWorkersSection(raw, workers);
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

export function setRole(role: string, target: string): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  const [name, alias] = target.split("/");
  const p = workers.providers[name];
  if (!p) {
    throw new WorkersConfigError(
      `no provider named "${name}" in "${target}". Configured: ${Object.keys(workers.providers).join(", ") || "(none)"}`
    );
  }
  if (alias && alias !== "default" && alias !== "fast") {
    throw new WorkersConfigError(
      `unknown model alias "${alias}" — providers expose "default" and "fast"`
    );
  }
  if (alias === "fast" && !p.models.fast) {
    throw new WorkersConfigError(`provider "${name}" has no fast model configured`);
  }
  workers.roles[role] = target;
  writeWorkersSection(raw, workers);
  return workers;
}

export function unsetRole(role: string): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  if (!(role in workers.roles)) {
    throw new WorkersConfigError(`no role named "${role}"`);
  }
  delete workers.roles[role];
  writeWorkersSection(raw, workers);
  return workers;
}

export function setWorkersEnabled(enabled: boolean): WorkersConfig {
  const { raw, workers } = readWorkersSection();
  workers.enabled = enabled;
  writeWorkersSection(raw, workers);
  return workers;
}

/** Human-readable provider listing (quota probe included when configured). */
export function describeProviders(workers: WorkersConfig): string[] {
  const lines: string[] = [];
  const names = Object.keys(workers.providers);
  if (!names.length) {
    lines.push(`no providers configured. Add one with:`);
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
    lines.push(`${name}  [${flags.join(", ")}]  ${p.baseUrl}`);
    lines.push(
      `    model ${p.models.default}${p.models.fast ? ` (fast: ${p.models.fast})` : ""}${quotaNote}`
    );
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
  if (workers.active === "auto") {
    lines.push(`routing: auto — order [${workers.routing.order.join(", ")}], cooldown ${workers.routing.cooldownMinutes}m`);
  }
  return lines;
}
