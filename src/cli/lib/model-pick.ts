/**
 * model-pick.ts — the "which model?" step of the bare-`pai` picker.
 *
 * After a project is chosen, the operator can pick the provider the session
 * starts on: the built-in anthropic login, any other enabled workers.yaml
 * provider, or a local tier (small/medium/large from local_tiers:). Choice 1
 * is always "default" — no provider override, i.e. exactly what Enter did
 * before this step existed.
 */

import { readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { launchableProviderNames } from "../../workers/launch.js";
import { ANTHROPIC_NATIVE, hasProviderKey } from "../../workers/config.js";
import type { WorkerProvider, WorkersConfig } from "../../workers/config.js";
import { fmtRss, resolveModelPath } from "../../workers/local-tiers.js";
import type { LocalConfig, LocalTier, RunningServer } from "../../workers/local-tiers.js";
import { dim } from "../utils.js";

export interface ModelChoice {
  /** Provider handed to `pai launch --provider`; undefined = today's default. */
  provider?: string;
  /** Local tier name, when this choice is a local model server. */
  tier?: string;
  /** Local model server (tier, or provider on 127.0.0.1/localhost). */
  local?: boolean;
  /** Local only: its server is running now. */
  up?: boolean;
  /** Local provider whose model is not on disk: cannot be chosen. */
  missing?: boolean;
  /** Cloud provider whose credential does not resolve: cannot be chosen. */
  noKey?: boolean;
  /** Local provider that is not a tier and is down: start recipe for it. */
  launch?: LocalTier;
  /** Local only: RSS when up, else size on disk. */
  mem?: string;
  label: string;
}

/** What the screen needs to know about running servers (all optional). */
export interface ModelProbe {
  /** Ports that answer (health check), for providers that are not tiers. */
  upPorts?: number[];
  /** Size on disk in bytes of a tier's model, null when unknown. */
  diskBytes?: (t: LocalTier) => number | null;
  /** Model path on disk for a provider's default model name, null when absent. */
  findModel?: (served: string) => string | null;
}

/** True when the provider's base URL points at this machine. */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost";
  } catch {
    return false;
  }
}

function portOf(url: string | undefined): number | null {
  try {
    const p = new URL(url ?? "").port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

export function fmtDisk(bytes: number): string {
  return `~${Math.max(0.1, Math.round((bytes / 1073741824) * 10) / 10)} GB`;
}

/** Total size in bytes of a file or directory tree; null when unreadable. */
export function diskBytesOf(path: string): number | null {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const e of readdirSync(path)) n += diskBytesOf(`${path}/${e}`) ?? 0;
    return n;
  } catch {
    return null;
  }
}

/** diskBytes probe backed by the filesystem. */
export const diskBytesOfTier = (t: LocalTier): number | null => diskBytesOf(resolveModelPath(t.model));

/**
 * Build the choice list. Index 0 is the default (no override), then cloud
 * providers, then local ones (providers on localhost, then tiers). Tier
 * providers are listed once, as tiers.
 */
export function buildModelChoices(
  workers: Pick<WorkersConfig, "providers" | "active">,
  local: Pick<LocalConfig, "tiers"> | null,
  running: Pick<RunningServer, "port" | "rssKb">[],
  probe: ModelProbe = {},
): ModelChoice[] {
  const tiers: LocalTier[] = local ? Object.values(local.tiers) : [];
  const tierProviders = new Set(tiers.map((t) => t.provider));
  const active = workers.active && workers.active !== "auto" ? workers.active : "anthropic";

  const choices: ModelChoice[] = [{ label: `default  (today's behaviour: ${active})` }];
  const localProviders: ModelChoice[] = [];
  for (const name of launchableProviderNames(workers)) {
    if (tierProviders.has(name)) continue;
    const prov = (workers.providers as Record<string, { baseUrl?: string; key?: string; keyFile?: string | null; models?: { default?: string } }>)[name];
    const url = prov?.baseUrl;
    if (!isLocalUrl(url)) {
      const noKey = name !== ANTHROPIC_NATIVE && !!prov && !hasProviderKey(prov as unknown as WorkerProvider);
      choices.push({ provider: name, label: name, ...(noKey ? { noKey, missing: true } : {}) });
      continue;
    }
    const port = portOf(url);
    const r = running.find((x) => x.port === port);
    const up = !!r || (port !== null && (probe.upPorts ?? []).includes(port));
    if (up) {
      localProviders.push({ provider: name, local: true, up, mem: r ? fmtRss(r.rssKb) : undefined, label: name });
      continue;
    }
    const served = prov?.models?.default;
    const model = served && port !== null ? (probe.findModel?.(served) ?? null) : null;
    if (!served || port === null || !model) {
      localProviders.push({ provider: name, local: true, up: false, missing: true, label: name });
      continue;
    }
    const launch: LocalTier = { tier: name, provider: name, model, served, port, flags: [] };
    const bytes = probe.diskBytes?.(launch) ?? null;
    localProviders.push({
      provider: name, local: true, up: false, launch,
      mem: bytes !== null ? fmtDisk(bytes) : undefined,
      label: name,
    });
  }
  choices.push(...localProviders);
  for (const t of tiers) {
    const r = running.find((x) => x.port === t.port);
    const bytes = r ? null : (probe.diskBytes?.(t) ?? null);
    choices.push({
      provider: t.provider,
      tier: t.tier,
      local: true,
      up: !!r,
      mem: r ? fmtRss(r.rssKb) : bytes !== null ? fmtDisk(bytes) : undefined,
      label: `local ${t.tier}  ${t.served}  :${t.port}`,
    });
  }
  return choices;
}

function status(c: ModelChoice): string {
  if (c.noKey) return chalk.dim("no key");
  if (c.missing) return chalk.dim("not installed");
  const mem = c.mem ? `${c.up ? "" : "disk "}${c.mem}` : "";
  return c.up
    ? `${chalk.green("up")}${mem ? `  ${mem} RSS` : ""}`
    : `down — will be started${mem ? `  ${mem}` : ""}`;
}

/** The screen text for the model step. `cursor` is the highlighted index. */
export function modelScreen(choices: ModelChoice[], name: string, cursor = 0, typed = ""): string[] {
  const lines = ["", `  ${chalk.bold("Model for")} ${chalk.white(name)}`, ""];
  let section = "";
  choices.forEach((c, i) => {
    const sec = i === 0 ? "" : c.local ? "LOCAL" : "CLOUD";
    if (sec && sec !== section) {
      lines.push("", `  ${chalk.bold(sec)}`);
    }
    section = sec || section;
    const mark = c.local ? (c.up ? chalk.green("●") : chalk.dim("○")) : " ";
    const body = c.missing ? chalk.dim(`${c.label}  ${status(c)}`) : c.local ? `${c.label}  ${status(c)}` : c.label;
    const row = `${chalk.cyan(String(i + 1).padStart(2))}  ${mark} ${body}`;
    lines.push(i === cursor ? `${chalk.cyan("›")} ${chalk.bold(row)}` : `  ${row}`);
  });
  lines.push("", dim(`  ↑/↓ + Enter, or type a number or name${typed ? "  > " : ""}`) + (typed ? typed : ""), "");
  return lines;
}

/** Answer text → choice. Empty (Enter) = default; unknown or down = null. */
export function parseModelAnswer(answer: string, choices: ModelChoice[]): ModelChoice | null {
  const t = answer.trim().toLowerCase();
  let c: ModelChoice | null | undefined;
  if (!t) c = choices[0];
  else if (/^\d+$/.test(t)) c = choices[Number(t) - 1];
  else
    c =
      choices.find((x) => x.provider === t && !x.tier) ??
      choices.find((x) => x.tier === t || x.tier === t.replace(/^local[ -]?/, ""));
  return c && !c.missing ? c : null;
}

/** Next cursor after an arrow key, skipping choices that cannot be chosen. */
export function moveCursor(choices: ModelChoice[], cursor: number, dir: 1 | -1): number {
  for (let i = cursor + dir; i >= 0 && i < choices.length; i += dir) {
    if (!choices[i].missing) return i;
  }
  return cursor;
}

/**
 * Result of Enter: typed text wins (number/name), else the highlighted row.
 * Arrow selection and the equivalent number give the same choice.
 */
export function resolveEnter(choices: ModelChoice[], cursor: number, typed: string): ModelChoice | null {
  return typed.trim() ? parseModelAnswer(typed, choices) : (choices[cursor] ?? null);
}

/** Ask on the terminal: arrows + Enter, or a typed number/name. Null = invalid. */
export function askModel(choices: ModelChoice[], name: string): Promise<ModelChoice | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    for (const l of modelScreen(choices, name, -1)) console.log(l);
    const rl = createInterface({ input: stdin, output: process.stdout });
    return new Promise((resolve) =>
      rl.question(dim("  Pick a number or name [Enter = default]: "), (a) => {
        rl.close();
        resolve(parseModelAnswer(a, choices));
      }),
    );
  }
  const out = process.stdout;
  return new Promise((resolve) => {
    let cursor = 0;
    let typed = "";
    let drawn = 0;
    const render = () => {
      const lines = modelScreen(choices, name, cursor, typed);
      if (drawn) out.write(`\x1b[${drawn}A\x1b[J`);
      out.write(lines.join("\n") + "\n");
      drawn = lines.length;
    };
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (c: ModelChoice | null) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(c);
    };
    const onData = (buf: Buffer) => {
      const k = buf.toString();
      if (k === "\x03" || k === "\x1b") return finish(null);
      if (k === "\r" || k === "\n") return finish(resolveEnter(choices, cursor, typed));
      if (k === "\x1b[A") { typed = ""; cursor = moveCursor(choices, cursor, -1); }
      else if (k === "\x1b[B") { typed = ""; cursor = moveCursor(choices, cursor, 1); }
      else if (k === "\x7f") typed = typed.slice(0, -1);
      else if (/^[\x20-\x7e]+$/.test(k)) typed += k;
      render();
    };
    stdin.on("data", onData);
    render();
  });
}
