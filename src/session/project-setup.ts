/**
 * `pai project init` and the project checks of `pai project health`: the
 * shared core of the CLI and the MCP tools project_setup / project_health.
 *
 * init detects what it can (git toplevel, origin kind, existing .pai files) and
 * writes `.pai/project.yaml` and a starter `.pai/worker.md`; it never overwrites
 * (`--force` does, keeping a .bak) and never searches issues for an anchor.
 * Every check prints `ok - <what>` or `missing - <what> - fix: <one command>`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { resolveFromModule } from "../module-paths.js";
import { PREAMBLE_MAX_BYTES, PREAMBLE_REL, projectRoot } from "../workers/preamble.js";
import { paneBackend, resolveHostSession, type HostSession } from "../workers/pane.js";
import {
  ForgeError, PROJECT_CONFIG_REL, parseStatusConfig, writeContinueToForge,
  type ForgeDeps, type StatusConfig,
} from "./forge-sink.js";

export type OriginKind = "forge" | "github" | "none";

export function originUrl(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
}

/** The checks only make sense inside a git checkout. */
export function isGitProject(cwd: string): boolean {
  return existsSync(join(projectRoot(cwd), ".git"));
}

export function originKind(url: string | undefined): OriginKind {
  if (!url) return "none";
  return /(^|[@/])github\.com[:/]/i.test(url) ? "github" : "forge";
}

/** Generic and cache-stable on purpose: no dates, ids or paths. */
export const STARTER_WORKER_MD = `Project rules for every worker started in this repository.

- Read the code a change touches before editing it; reuse existing helpers.
- Run only the tests of the files you touched; report the counts.
- Commit on your worker branch with a conventional message; never push or tag.
- Keep secrets, tokens and personal data out of code, tests and docs.
`;

export interface InitOpts { anchor?: number; marker?: string; force?: boolean; dryRun?: boolean }
export interface InitResult { root: string; origin: OriginKind; sink: "forge" | "todo"; written: string[]; kept: string[]; message: string[] }

function projectYaml(sink: "forge" | "todo", anchor?: number, marker?: string): string {
  const forge = sink === "forge" && (anchor || marker)
    ? `  forge:\n${anchor ? `    anchor: ${anchor}\n` : ""}${marker ? `    marker: ${JSON.stringify(marker)}\n` : ""}`
    : "";
  return `status:\n  sink: ${sink}\n${forge}`;
}

export function initProject(cwd: string, o: InitOpts = {}): InitResult {
  const root = projectRoot(cwd);
  const kind = originKind(originUrl(root));
  const sink = kind === "forge" ? "forge" : "todo";
  const res: InitResult = { root, origin: kind, sink, written: [], kept: [], message: [] };
  const yamlPath = join(root, PROJECT_CONFIG_REL);
  let anchor = o.anchor;
  let marker = o.marker;
  if (existsSync(yamlPath) && !o.force) {
    res.kept.push(PROJECT_CONFIG_REL);
  } else {
    if (existsSync(yamlPath)) {
      // --force keeps what is already there unless given anew
      try { const old = parseStatusConfig(readFileSync(yamlPath, "utf8")); anchor ??= old.anchor; marker ??= old.marker; } catch { /* unreadable: replaced */ }
    }
    put(res, root, PROJECT_CONFIG_REL, projectYaml(sink, anchor, marker), o);
  }
  if (existsSync(join(root, PREAMBLE_REL)) && !o.force) res.kept.push(PREAMBLE_REL);
  else put(res, root, PREAMBLE_REL, STARTER_WORKER_MD, o);
  return res;
}

function put(res: InitResult, root: string, rel: string, text: string, o: InitOpts): void {
  const path = join(root, rel);
  const had = existsSync(path);
  res.message.push(`${o.dryRun ? "would write" : "wrote"} ${rel}${had ? " (old copy kept as .bak)" : ""}`);
  res.written.push(rel);
  if (o.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  if (had) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, text);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface CheckLine { ok: boolean; what: string; fix?: string }
export const formatCheck = (c: CheckLine): string => (c.ok ? `ok - ${c.what}` : `missing - ${c.what} - fix: ${c.fix}`);

export interface CheckDeps extends ForgeDeps {
  host?: () => Promise<HostSession>;
  /** Daemon start (ms epoch), null when it does not answer. */
  daemonStart?: () => Promise<number | null>;
  /** mtime (ms epoch) of the installed daemon build, null when unknown. */
  buildTime?: () => number | null;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

export async function projectChecks(cwd: string, d: CheckDeps = {}): Promise<CheckLine[]> {
  const root = projectRoot(cwd);
  const out: CheckLine[] = [];
  const yamlPath = join(root, PROJECT_CONFIG_REL);
  let cfg: StatusConfig | null = null;
  if (!existsSync(yamlPath)) {
    out.push({ ok: false, what: `${PROJECT_CONFIG_REL} present`, fix: "pai project init" });
  } else {
    try {
      parse(readFileSync(yamlPath, "utf8"));
      cfg = parseStatusConfig(readFileSync(yamlPath, "utf8"));
      out.push({ ok: true, what: `${PROJECT_CONFIG_REL} valid (sink: ${cfg.sink})` });
    } catch {
      out.push({ ok: false, what: `${PROJECT_CONFIG_REL} is not valid YAML`, fix: "pai project init --force" });
    }
  }
  if (cfg?.sink === "forge") {
    const anchorFix = "pai project init --force --anchor <issue> --marker <text>";
    if (!cfg.anchor || !cfg.marker) {
      out.push({ ok: false, what: "forge anchor and marker set", fix: anchorFix });
    } else {
      try {
        // dry run: GETs only; resolves the token, the anchor, its marker and the handover issue
        writeContinueToForge(root, cfg, "", { ...d, dryRun: true });
        out.push({ ok: true, what: `forge token present; anchor #${cfg.anchor} reachable, marker matches` });
      } catch (e) {
        const m = e instanceof ForgeError ? e.message : String(e);
        out.push(m === "no forge token"
          ? { ok: false, what: "forge token present", fix: "pai config set forge.token <token>" }
          : { ok: false, what: `forge anchor #${cfg.anchor}: ${m}`, fix: anchorFix });
      }
    }
  }
  const wPath = join(root, PREAMBLE_REL);
  if (!existsSync(wPath)) out.push({ ok: false, what: `${PREAMBLE_REL} present`, fix: "pai project init" });
  else {
    const size = statSync(wPath).size;
    out.push(size > PREAMBLE_MAX_BYTES
      ? { ok: false, what: `${PREAMBLE_REL} is ${size} bytes, over the ${PREAMBLE_MAX_BYTES} limit`, fix: `$EDITOR ${PREAMBLE_REL}` }
      : { ok: true, what: `${PREAMBLE_REL} size ok (${size} bytes)` });
  }
  const env = d.env ?? process.env;
  const backend = paneBackend(env, d.platform ?? process.platform, env.ITERM_SESSION_ID);
  if (backend === "tmux") out.push({ ok: true, what: "worker panes open in tmux" });
  else {
    const h = await (d.host ?? (() => resolveHostSession()))();
    out.push(h.via === "none"
      ? { ok: false, what: `iTerm host session for worker panes (${h.reason})`, fix: "pai worker pane --check" }
      : { ok: true, what: `iTerm host session ${h.uid} via ${h.via}` });
  }
  const started = await (d.daemonStart ?? realDaemonStart)();
  const built = (d.buildTime ?? realBuildTime)();
  if (started === null) out.push({ ok: false, what: "daemon running", fix: "pai daemon restart" });
  else if (built !== null && started < built) out.push({ ok: false, what: "daemon started before the installed build", fix: "pai daemon restart" });
  else out.push({ ok: true, what: "daemon running on the installed build" });
  return out;
}

async function realDaemonStart(): Promise<number | null> {
  try {
    const [{ PaiClient }, { loadConfig }] = await Promise.all([import("../daemon/ipc-client.js"), import("../daemon/config.js")]);
    const s = await new PaiClient(loadConfig().socketPath).status();
    return Date.now() - Number(s.uptime) * 1000;
  } catch { return null; }
}

function realBuildTime(): number | null {
  try {
    // dist/daemon/index.mjs is what `pai daemon restart` launches
    return statSync(resolveFromModule(import.meta.url, "dist/daemon/index.mjs")).mtimeMs;
  } catch { return null; }
}
