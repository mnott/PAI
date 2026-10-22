/**
 * cockpit-registry.ts — the cockpit's model-registry editor endpoints.
 *
 * GET  /cockpit/registry           {yaml, mtime, hash}  (the workers.yaml text)
 * GET  /cockpit/registry/backups   timestamped backups, newest first
 * POST /cockpit/registry/validate  {yaml, baseHash} -> {ok, errors[{path,line,message}], diff}
 * POST /cockpit/registry/save      {yaml, baseHash} -> {ok, backup} | {ok:false, error}
 * POST /cockpit/registry/restore   {name, baseHash} -> as save
 * POST /cockpit/registry/backup-diff   {name} -> {ok, diff}  (backup vs the current file)
 * POST /cockpit/registry/backup-delete {name} -> {ok}
 * POST /cockpit/registry/backup-label  {name, label} -> {ok, label}  (empty label clears it)
 * POST /cockpit/registry/duplicate {yaml, name, newName?, port?} -> {yaml, name, port}
 *
 * Validation reuses the config loader's own parsers (parseLocalConfig for
 * local_tiers, parseProvider for providers); this file only adds the checks
 * the loader cannot know (uniqueness, ports, model files, running instances)
 * and maps loader errors to line numbers. Mutations are POST-only, same-origin
 * guarded like /cockpit/action, and write a COCKPIT-ACTION ledger line.
 * Every file path is injected (RegistryCtx) so tests never touch the real file.
 */

import type http from "node:http";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LineCounter, parseDocument, isMap, isScalar, type Document } from "yaml";
import { parseLocalConfig, resolveModelPath, LocalTierError } from "../workers/local-tiers.js";
import { parseProvider, WorkersConfigError, ANTHROPIC_NATIVE } from "../workers/config.js";
import { yamlProviderToRaw, parseBuiltinAnthropic } from "../workers/workers-config.js";
import { normalizePathsText, type PathChange } from "../workers/normalize-paths.js";
import { readLiveInstances, type LocalInstance } from "../workers/local-instances.js";
import { appendLedger } from "../workers/ledger.js";
import { COCKPIT_ACTION_EVENT } from "./cockpit-actions.js";

export interface RegistryError {
  path: string;
  line: number;
  message: string;
}

export interface RegistryCtx {
  /** the registry file (workers.yaml) */
  yamlPath: string;
  /** where timestamped backups go */
  backupDir: string;
  /** model-file existence; default fs.existsSync */
  fileExists?: (path: string) => boolean;
  /** true when nothing else listens on the port; default: assume free */
  portFree?: (port: number) => boolean;
  /** instances currently running (starting/ready), for the "no removal while running" rule */
  running?: () => LocalInstance[];
  /** ledger file; no ledger line when absent */
  ledger?: string;
  /** clock for backup names */
  now?: () => Date;
  /** write every providers entry with an explicit `enabled:` (default registry ctx: on) */
  explicitEnabled?: boolean;
  /** write every local_tiers entry with explicit `location:` and `health:` */
  explicitLifecycle?: boolean;
  /** test seam: called before each save step (1..6); throwing fails that step */
  failAt?: (step: number) => void;
}

export const BACKUP_RE = /^workers\.yaml\.(\d{8}-\d{6})\.bak$/;

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

function lineOf(doc: Document.Parsed, lc: LineCounter, path: (string | number)[]): number {
  for (let n = path.length; n >= 0; n--) {
    const node = doc.getIn(path.slice(0, n), true) as { range?: [number, number, number] } | undefined;
    if (node?.range) return lc.linePos(node.range[0]).line;
  }
  return 1;
}

/** `local_tiers.foo.port: ...` / `workers.providers.foo.url: ...` -> key path */
function pathFromMessage(msg: string): { path: (string | number)[]; text: string } {
  const m = /^(?:workers)?\.?((?:local_tiers|providers)[.\w-]*)\s*:\s*(.*)$/s.exec(msg);
  if (!m) return { path: [], text: msg };
  const head = m[1]!.split(".").filter(Boolean);
  return { path: head, text: m[2]! };
}

export interface ValidateResult {
  errors: RegistryError[];
}

/**
 * Validate registry YAML text. `current` (the text on disk) scopes the
 * port-in-use and removal checks to what the edit changes.
 */
export function validateRegistry(yamlText: string, ctx: RegistryCtx, current = ""): ValidateResult {
  const errors: RegistryError[] = [];
  const lc = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter: lc, uniqueKeys: false });
  const at = (path: (string | number)[]) => lineOf(doc, lc, path);
  const add = (path: (string | number)[], message: string) => errors.push({ path: path.join("."), line: at(path), message });

  for (const e of doc.errors) errors.push({ path: "", line: e.linePos?.[0]?.line ?? 1, message: e.message.split("\n")[0]! });
  if (errors.length) return { errors };
  const root = doc.toJS() as unknown;
  if (root === null || root === undefined) return { errors };
  if (typeof root !== "object" || Array.isArray(root)) {
    add([], "top level must be a mapping");
    return { errors };
  }
  const r = root as Record<string, unknown>;

  // duplicate names: the parser keeps the last, so look at the keys of the document itself
  for (const section of ["local_tiers", "providers"]) {
    const node = doc.get(section, true);
    if (!isMap(node)) continue;
    const seen = new Set<string>();
    for (const pair of node.items) {
      const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (seen.has(k)) add([section, k], `duplicate name "${k}" in ${section}`);
      seen.add(k);
    }
  }
  if (errors.length) return { errors };

  const provRaw = r.providers;
  const providers: Record<string, { url?: string; model?: string }> = {};
  if (provRaw !== undefined && provRaw !== null) {
    if (typeof provRaw !== "object" || Array.isArray(provRaw)) add(["providers"], "providers: must be a mapping");
    else {
      for (const [name, raw] of Object.entries(provRaw as Record<string, unknown>)) {
        try {
          // same split as the loader: the builtin anthropic block is not a provider
          if (name === ANTHROPIC_NATIVE) {
            parseBuiltinAnthropic(raw, `providers.${name}`);
            continue;
          }
          parseProvider(name, yamlProviderToRaw((raw ?? {}) as Record<string, unknown>));
        } catch (e) {
          const { path, text } = pathFromMessage((e as Error).message);
          add(path.length ? path : ["providers", name], text);
        }
        const p = (raw ?? {}) as { url?: unknown; models?: { default?: unknown } };
        providers[name] = { url: typeof p.url === "string" ? p.url : undefined, model: typeof p.models?.default === "string" ? p.models.default : undefined };
      }
    }
  }
  if (errors.length) return { errors };

  let tiers: ReturnType<typeof parseLocalConfig>["tiers"] = {};
  try {
    tiers = parseLocalConfig(r, providers).tiers;
  } catch (e) {
    if (e instanceof LocalTierError || e instanceof WorkersConfigError) {
      const { path, text } = pathFromMessage((e as Error).message);
      add(path, text);
    } else add([], (e as Error).message);
    return { errors };
  }

  const exists = ctx.fileExists ?? existsSync;
  const free = ctx.portFree ?? (() => true);
  let before: Record<string, { port: number }> = {};
  try {
    before = current ? parseLocalConfig((parseDocument(current).toJS() ?? {}) as Record<string, unknown>, providers).tiers : {};
  } catch {
    before = {};
  }
  // one server may back several tiers (only one runs at a time): Strata tiers share the Strata server whatever their config; script tiers the same script; vllm-mlx the same model
  const target = (t: (typeof tiers)[string]) => `${t.engine}|${t.engine === "strata" ? "" : t.engine === "script" ? t.start : t.model}`;
  const byPort = new Map<number, (typeof tiers)[string]>();
  for (const t of Object.values(tiers)) {
    const clash = byPort.get(t.port);
    if (clash && target(clash) !== target(t)) add(["local_tiers", t.tier, "port"], `port ${t.port} is also used by "${clash.tier}"`);
    else if (!clash) byPort.set(t.port, t);
    if (before[t.tier]?.port !== t.port && !free(t.port)) add(["local_tiers", t.tier, "port"], `port ${t.port} is in use by another process`);
    if (t.engine === "vllm-mlx" && t.model && !exists(resolveModelPath(t.model))) add(["local_tiers", t.tier, "model"], `model file not found: ${t.model}`);
  }

  const running = (ctx.running?.() ?? []).filter((i) => i.state === "starting" || i.state === "ready");
  for (const name of Object.keys(before)) {
    if (tiers[name]) continue;
    const inst = running.find((i) => i.model === name);
    if (inst) add(["local_tiers"], `cannot remove "${name}": instance ${inst.id} is running`);
  }
  const provNames = new Set(Object.keys(providers));
  for (const inst of running) {
    if (inst.origin === "registered" && !provNames.has(inst.provider)) add(["providers"], `cannot remove provider "${inst.provider}": instance ${inst.id} is running`);
  }
  return { errors };
}

/**
 * Every providers.<name> entry carries an explicit `enabled:` so a search for `enabled: true` finds
 * the live ones too. A missing key is inserted as `enabled: true` (what the loader assumes) on the
 * line after the entry's name, indented like its other keys; the rest of the text is untouched.
 * The builtin anthropic block and flow-style entries are left alone.
 */
export function withExplicitEnabled(yamlText: string): string {
  const doc = parseDocument(yamlText, { uniqueKeys: false });
  if (doc.errors.length) return yamlText;
  const providers = doc.get("providers", true);
  if (!isMap(providers)) return yamlText;
  const inserts: { at: number; text: string }[] = [];
  for (const pair of providers.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : "";
    const v = pair.value;
    if (name === ANTHROPIC_NATIVE || !isMap(v) || v.flow || v.has("enabled") || !v.items.length || !isScalar(pair.key) || !pair.key.range) continue;
    const first = v.items[0]!.key as { range?: [number, number, number] } | null;
    if (!first?.range) continue;
    const lineStart = yamlText.lastIndexOf("\n", first.range[0] - 1) + 1;
    const indent = yamlText.slice(lineStart, first.range[0]);
    if (!/^[ ]+$/.test(indent)) continue; // first key not on a line of its own
    const nl = yamlText.indexOf("\n", pair.key.range[1]);
    if (nl < 0) continue;
    inserts.push({ at: nl + 1, text: `${indent}enabled: true\n` });
  }
  let out = yamlText;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

/** Line diff, `+ `/`- ` prefixed changed lines only (LCS). */
export function diffLines(a: string, b: string): string[] {
  const x = a === "" ? [] : a.split("\n");
  const y = b === "" ? [] : b.split("\n");
  const n = x.length;
  const m = y.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (i++, j++);
    else if (t[i + 1]![j]! >= t[i]![j + 1]!) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out;
}

export function diffSummary(a: string, b: string): string {
  const d = diffLines(a, b);
  const plus = d.filter((l) => l.startsWith("+")).length;
  const minus = d.length - plus;
  return d.length ? `+${plus} -${minus} lines` : "no changes";
}

const readCurrent = (ctx: RegistryCtx): string => (existsSync(ctx.yamlPath) ? readFileSync(ctx.yamlPath, "utf8") : "");

export function readRegistry(ctx: RegistryCtx): { yaml: string; mtime: number; hash: string } {
  const yaml = readCurrent(ctx);
  return { yaml, mtime: existsSync(ctx.yamlPath) ? statSync(ctx.yamlPath).mtimeMs : 0, hash: hashText(yaml) };
}

export function validateRequest(yamlText: string, baseHash: string, ctx: RegistryCtx): { ok: boolean; errors: RegistryError[]; diff: string[]; stale?: boolean } {
  const cur = readCurrent(ctx);
  if (baseHash !== hashText(cur)) return { ok: false, stale: true, errors: [{ path: "", line: 1, message: "changed on disk - reload" }], diff: [] };
  const { errors } = validateRegistry(yamlText, ctx, cur);
  let shown = yamlText;
  if (!errors.length) {
    if (ctx.explicitEnabled) shown = withExplicitEnabled(shown);
    if (ctx.explicitLifecycle) shown = withExplicitLifecycle(shown);
  }
  return { ok: errors.length === 0, errors, diff: diffLines(cur, shown) };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupName(ctx: RegistryCtx): string {
  const d = new Date((ctx.now?.() ?? new Date()).getTime());
  for (;;) {
    const name = `workers.yaml.${stamp(d)}.bak`;
    if (!existsSync(join(ctx.backupDir, name))) return name;
    d.setSeconds(d.getSeconds() + 1);
  }
}

/** `pai worker config normalize-paths`: home-prefixed path values become `~/…`. Write mode backs up (editor naming) and swaps atomically. */
export function normalizeRegistryPaths(
  yamlPath: string,
  opts: { write?: boolean; home?: string; now?: () => Date } = {},
): { changes: PathChange[]; backup?: string } {
  const cur = readFileSync(yamlPath, "utf8");
  const { text, changes } = normalizePathsText(cur, opts.home);
  if (!opts.write || !changes.length) return { changes };
  const backupDir = join(dirname(yamlPath), "workers-backups");
  mkdirSync(backupDir, { recursive: true });
  const backup = backupName({ yamlPath, backupDir, now: opts.now } as RegistryCtx);
  copyFileSync(yamlPath, join(backupDir, backup));
  const tmp = `${yamlPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: statSync(yamlPath).mode & 0o777 });
    renameSync(tmp, yamlPath);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
  return { changes, backup };
}

export type SaveResult = { ok: true; backup: string } | { ok: false; error: string };

/** The 7-step save. A failure at any step leaves the registry file byte-identical. */
export function saveRegistry(yamlText: string, baseHash: string, ctx: RegistryCtx): SaveResult {
  const step = (n: number) => ctx.failAt?.(n);
  const tmp = `${ctx.yamlPath}.${process.pid}.tmp`;
  let backupPath = "";
  try {
    step(1);
    const cur = readCurrent(ctx);
    if (baseHash !== hashText(cur)) return { ok: false, error: "changed on disk - reload" };
    step(2);
    const { errors } = validateRegistry(yamlText, ctx, cur);
    if (errors.length) return { ok: false, error: errors.map((e) => `line ${e.line}: ${e.message}`).join("; ") };
    if (ctx.explicitEnabled) yamlText = withExplicitEnabled(yamlText);
    if (ctx.explicitLifecycle) yamlText = withExplicitLifecycle(yamlText);
    yamlText = normalizePathsText(yamlText).text;
    step(3);
    mkdirSync(ctx.backupDir, { recursive: true });
    const name = backupName(ctx);
    backupPath = join(ctx.backupDir, name);
    if (existsSync(ctx.yamlPath)) copyFileSync(ctx.yamlPath, backupPath);
    else writeFileSync(backupPath, "");
    step(4);
    writeFileSync(tmp, yamlText);
    step(5);
    const back = readFileSync(tmp, "utf8");
    const again = validateRegistry(back, ctx, cur).errors;
    if (back !== yamlText || again.length) throw new Error(`written file failed re-validation: ${again[0]?.message ?? "content differs"}`);
    step(6);
    renameSync(tmp, ctx.yamlPath);
    return { ok: true, backup: name };
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    if (backupPath && existsSync(backupPath)) unlinkSync(backupPath);
    return { ok: false, error: (e as Error).message };
  }
}

export interface BackupInfo {
  name: string;
  size: number;
  mtime: number;
  summary: string;
  /** optional operator-given name, kept in a sidecar next to the backup */
  label: string;
}

const LABEL_MAX = 80;
const labelPath = (ctx: RegistryCtx, name: string): string => join(ctx.backupDir, `${name}.label`);
const readLabel = (ctx: RegistryCtx, name: string): string => {
  try {
    return readFileSync(labelPath(ctx, name), "utf8").trim();
  } catch {
    return "";
  }
};

/** Backups newest first (by the stamp in the name), each with a diff summary against the current file. */
export function listBackups(ctx: RegistryCtx): BackupInfo[] {
  if (!existsSync(ctx.backupDir)) return [];
  const cur = readCurrent(ctx);
  return readdirSync(ctx.backupDir)
    .filter((n) => BACKUP_RE.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const p = join(ctx.backupDir, name);
      const st = statSync(p);
      return { name, size: st.size, mtime: st.mtimeMs, summary: diffSummary(cur, readFileSync(p, "utf8")), label: readLabel(ctx, name) };
    });
}

function backupFile(name: string, ctx: RegistryCtx): { ok: true; path: string } | { ok: false; error: string } {
  if (!BACKUP_RE.test(name) || basename(name) !== name) return { ok: false, error: `not a backup name: ${name}` };
  const path = join(ctx.backupDir, name);
  return existsSync(path) ? { ok: true, path } : { ok: false, error: `no such backup: ${name}` };
}

/** Diff of one backup against the current file: `-` lines are in the file now, `+` lines are what restoring brings back. */
export function diffBackup(name: string, ctx: RegistryCtx): { ok: true; diff: string[] } | { ok: false; error: string } {
  const f = backupFile(name, ctx);
  return f.ok ? { ok: true, diff: diffLines(readCurrent(ctx), readFileSync(f.path, "utf8")) } : f;
}

/** Delete one backup (and its name). Nothing else in the directory is touched. */
export function deleteBackup(name: string, ctx: RegistryCtx): { ok: true } | { ok: false; error: string } {
  const f = backupFile(name, ctx);
  if (!f.ok) return f;
  unlinkSync(f.path);
  if (existsSync(labelPath(ctx, name))) unlinkSync(labelPath(ctx, name));
  return { ok: true };
}

/** Name a backup; an empty label removes the name. */
export function labelBackup(name: string, label: string, ctx: RegistryCtx): { ok: true; label: string } | { ok: false; error: string } {
  const f = backupFile(name, ctx);
  if (!f.ok) return f;
  const clean = label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  if (clean) writeFileSync(labelPath(ctx, name), clean + "\n");
  else if (existsSync(labelPath(ctx, name))) unlinkSync(labelPath(ctx, name));
  return { ok: true, label: clean };
}

/** Restore a backup through the same validate + atomic path; the replaced file is backed up by saveRegistry. */
export function restoreBackup(name: string, baseHash: string, ctx: RegistryCtx): SaveResult {
  if (!BACKUP_RE.test(name) || basename(name) !== name) return { ok: false, error: `not a backup name: ${name}` };
  const p = join(ctx.backupDir, name);
  if (!existsSync(p)) return { ok: false, error: `no such backup: ${name}` };
  return saveRegistry(readFileSync(p, "utf8"), baseHash, ctx);
}

/** Insert a copy of local_tiers.<name> as <newName> (default `<name>-2`, unique) on the next free port. Other fields identical. */
export function duplicateEntry(
  yamlText: string,
  name: string,
  opts: { newName?: string; port?: number; portFree?: (port: number) => boolean } = {},
): { ok: true; yaml: string; name: string; port: number } | { ok: false; error: string } {
  const doc = parseDocument(yamlText);
  const tiers = doc.get("local_tiers", true);
  if (!isMap(tiers) || !tiers.has(name)) return { ok: false, error: `no local_tiers entry "${name}"` };
  const used = new Set<number>();
  const names = new Set<string>();
  for (const pair of tiers.items) {
    names.add(String(isScalar(pair.key) ? pair.key.value : pair.key));
    const port = isMap(pair.value) ? pair.value.get("port") : undefined;
    if (typeof port === "number") used.add(port);
  }
  let newName = opts.newName;
  if (newName === undefined) {
    newName = `${name}-2`;
    for (let n = 3; names.has(newName); n++) newName = `${name}-${n}`;
  } else if (names.has(newName)) return { ok: false, error: `name "${newName}" already exists` };
  const src = tiers.get(name, true);
  const copy = doc.createNode((src as { toJSON(): unknown }).toJSON());
  const base = Math.max(0, ...used);
  let port = opts.port;
  if (port === undefined) {
    port = base + 1;
    while (used.has(port) || !(opts.portFree?.(port) ?? true)) port++;
  } else if (used.has(port)) return { ok: false, error: `port ${port} is already used` };
  if (isMap(copy)) copy.set("port", port);
  tiers.set(newName, copy);
  return { ok: true, yaml: String(doc), name: newName, port };
}

/**
 * Every local_tiers.<name> entry carries its lifecycle explicitly: `location`, `health` (the values the
 * loader would fill in) are inserted after the entry's name when missing, indented like its other keys.
 * An entry that does not parse, or a flow-style one, is left alone; the rest of the text is untouched.
 */
export function withExplicitLifecycle(yamlText: string): string {
  const doc = parseDocument(yamlText, { uniqueKeys: false });
  if (doc.errors.length) return yamlText;
  const tiersNode = doc.get("local_tiers", true);
  if (!isMap(tiersNode)) return yamlText;
  const root = doc.toJS() as Record<string, unknown>;
  const provs: Record<string, { url?: string; model?: string }> = {};
  for (const [n, raw] of Object.entries((root.providers ?? {}) as Record<string, { url?: unknown; models?: { default?: unknown } }>)) {
    provs[n] = { url: typeof raw?.url === "string" ? raw.url : undefined, model: typeof raw?.models?.default === "string" ? raw.models.default : undefined };
  }
  let cfg;
  try {
    cfg = parseLocalConfig(root, provs);
  } catch {
    return yamlText;
  }
  const inserts: { at: number; text: string }[] = [];
  for (const pair of tiersNode.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : "";
    const v = pair.value;
    const tier = cfg.tiers[name];
    if (!tier || !isMap(v) || v.flow || !v.items.length || !isScalar(pair.key) || !pair.key.range) continue;
    const first = v.items[0]!.key as { range?: [number, number, number] } | null;
    if (!first?.range) continue;
    const lineStart = yamlText.lastIndexOf("\n", first.range[0] - 1) + 1;
    const indent = yamlText.slice(lineStart, first.range[0]);
    if (!/^[ ]+$/.test(indent)) continue;
    const nl = yamlText.indexOf("\n", pair.key.range[1]);
    if (nl < 0) continue;
    const lines = [
      ...(v.has("location") || !tier.location ? [] : [`${indent}location: ${JSON.stringify(tier.location)}\n`]),
      ...(v.has("health") ? [] : [`${indent}health: ${JSON.stringify(tier.health)}\n`]),
    ];
    if (lines.length) inserts.push({ at: nl + 1, text: lines.join("") });
  }
  let out = yamlText;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

export function defaultRegistryCtx(yamlPath: string, ledger?: string, logDir?: string): RegistryCtx {
  return {
    yamlPath,
    backupDir: join(dirname(yamlPath), "workers-backups"),
    explicitEnabled: true,
    explicitLifecycle: true,
    ledger,
    ...(logDir ? { running: () => readLiveInstances(logDir) } : {}),
  };
}

function ledgerLine(ctx: RegistryCtx, action: string, target: string, result: string): void {
  if (ctx.ledger) appendLedger(ctx.ledger, COCKPIT_ACTION_EVENT, { who: "cockpit", action, target, result: result.replace(/\s+/g, "_") });
}

/**
 * Route table entry: returns true when it handled the request. `sameOrigin`
 * and `readBody` come from cockpit.ts (same guard as /cockpit/action).
 */
export function handleRegistryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  ctxOf: () => RegistryCtx,
  io: { sameOrigin: (req: http.IncomingMessage) => boolean; readBody: (req: http.IncomingMessage) => Promise<string> },
): boolean {
  if (path !== "/cockpit/registry" && !path.startsWith("/cockpit/registry/")) return false;
  const send = (status: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };
  if (req.method !== "GET" && req.method !== "POST") return send(405, { error: "GET or POST only" }), true;
  let ctx: RegistryCtx;
  try {
    ctx = ctxOf();
  } catch (e) {
    return send(500, { ok: false, message: (e as Error).message }), true;
  }
  if (req.method === "GET") {
    if (path === "/cockpit/registry") send(200, readRegistry(ctx));
    else if (path === "/cockpit/registry/backups") send(200, { backups: listBackups(ctx) });
    else send(404, { error: "no such registry route" });
    return true;
  }
  if (!io.sameOrigin(req)) return send(403, { ok: false, message: "cross-origin action refused" }), true;
  io.readBody(req)
    .then((raw) => JSON.parse(raw || "{}") as { yaml?: unknown; baseHash?: unknown; name?: unknown; newName?: unknown; port?: unknown; label?: unknown })
    .catch(() => ({}) as Record<string, unknown>)
    .then((b) => {
      const yaml = typeof b.yaml === "string" ? b.yaml : "";
      const baseHash = typeof b.baseHash === "string" ? b.baseHash : "";
      try {
        if (path === "/cockpit/registry/validate" && typeof b.yaml === "string") {
          const r = validateRequest(yaml, baseHash, ctx);
          ledgerLine(ctx, "registry.validate", basename(ctx.yamlPath), r.ok ? "ok" : `refused ${r.errors[0]?.message ?? ""}`);
          send(200, r);
        } else if (path === "/cockpit/registry/save" && typeof b.yaml === "string") {
          const r = saveRegistry(yaml, baseHash, ctx);
          ledgerLine(ctx, "registry.save", basename(ctx.yamlPath), r.ok ? `ok ${r.backup}` : `failed ${r.error}`);
          send(200, r);
        } else if (path === "/cockpit/registry/restore" && typeof b.name === "string") {
          const r = restoreBackup(b.name, baseHash, ctx);
          ledgerLine(ctx, "registry.restore", b.name, r.ok ? `ok ${r.backup}` : `failed ${r.error}`);
          send(200, r);
        } else if (path === "/cockpit/registry/backup-diff" && typeof b.name === "string") {
          send(200, diffBackup(b.name, ctx));
        } else if (path === "/cockpit/registry/backup-delete" && typeof b.name === "string") {
          const r = deleteBackup(b.name, ctx);
          ledgerLine(ctx, "registry.backup-delete", b.name, r.ok ? "ok" : `refused ${r.error}`);
          send(200, r);
        } else if (path === "/cockpit/registry/backup-label" && typeof b.name === "string" && typeof b.label === "string") {
          const r = labelBackup(b.name, b.label, ctx);
          ledgerLine(ctx, "registry.backup-label", b.name, r.ok ? "ok" : `refused ${r.error}`);
          send(200, r);
        } else if (path === "/cockpit/registry/duplicate" && typeof b.yaml === "string" && typeof b.name === "string") {
          const r = duplicateEntry(yaml, b.name, {
            ...(typeof b.newName === "string" ? { newName: b.newName } : {}),
            ...(typeof b.port === "number" ? { port: b.port } : {}),
            portFree: ctx.portFree,
          });
          ledgerLine(ctx, "registry.duplicate", b.name, r.ok ? `ok ${r.name}` : `refused ${r.error}`);
          send(200, r);
        } else send(400, { ok: false, message: "bad request" });
      } catch (e) {
        send(500, { ok: false, message: (e as Error).message });
      }
    });
  return true;
}
