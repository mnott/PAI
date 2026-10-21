/**
 * pai daemon <sub-command>
 *
 * serve      — Start the PAI daemon in the foreground
 * status     — Query daemon status via IPC
 * start      — Start the installed service
 * stop       — Stop the service without uninstalling it
 * restart    — Restart the running daemon (launchd on macOS, systemd on Linux)
 * install    — Install as a service (launchd plist / systemd user unit) + update ~/.claude.json to use the shim
 * uninstall  — Remove the service + revert ~/.claude.json to direct MCP
 * logs       — Tail the daemon log file
 */

import { LAUNCHD_LABEL } from "../../daemon/daemon-pid.js";
import { formatEmbedStatus } from "../../memory/embed-pass.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { ok, warn, err, dim, bold } from "../lib/utils.js";
import { loadConfig, paiConfigFilePath } from "../../daemon/config.js";
import { resolvedMainConfigPath } from "../../config/main-config.js";
import { describeQuiet, nextOccurrence, readQuiet, writeQuiet } from "../../daemon/quiet.js";
import { resolveDaemonPid } from "../../daemon/daemon-pid.js";
import { PaiClient } from "../../daemon/ipc-client.js";
import { readClaudeJson, writeClaudeJson } from "../../config/claude-json.js";
import { daemonLogPath } from "../../runtime-paths.js";
import { resolveFromModule } from "../../module-paths.js";
import { serviceManagerAllowed } from "../../service-manager.js";
import { formatStorageHealth, type StorageHealthStatus } from "./daemon-status.js";
import {
  loadSessionKeepaliveState,
  sessionKeepaliveLedgerSummary,
} from "../../daemon/session-keepalive.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME = homedir();
const PLIST_LABEL = LAUNCHD_LABEL;
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);
const DAEMON_LOG = daemonLogPath();

const SYSTEMD_UNIT_NAME = "pai-daemon.service";
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");
const SYSTEMD_UNIT_PATH = join(SYSTEMD_USER_DIR, SYSTEMD_UNIT_NAME);

/** Service name `daemon install` registers on this platform: systemd unit on Linux, launchd label elsewhere. */
export function daemonServiceName(plat: NodeJS.Platform = process.platform): string {
  return plat === "linux" ? SYSTEMD_UNIT_NAME : PLIST_LABEL;
}

/**
 * Resolve the absolute path to the built daemon entry point.
 * tsdown may emit this module's own chunk directly under dist/ rather than
 * under dist/cli/, so a fixed "../daemon/index.mjs" is not reliable — walk up
 * from this module until dist/daemon/index.mjs is found instead.
 */
function getDaemonBinPath(): string {
  return resolveFromModule(import.meta.url, "dist/daemon/index.mjs");
}

/** Resolve the absolute path to the built MCP shim entry point. Same reasoning as getDaemonBinPath. */
function getShimBinPath(): string {
  return resolveFromModule(import.meta.url, "dist/daemon-mcp/index.mjs");
}

// ---------------------------------------------------------------------------
// claude.json helpers
// ---------------------------------------------------------------------------

// Moved to src/config/claude-json.ts — see the note there on why returning {}
// from a failed read was a data-loss bug rather than a convenience.

// ---------------------------------------------------------------------------
// launchd plist generation
// ---------------------------------------------------------------------------

function generatePlist(daemonBin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${daemonBin}</string>
        <string>serve</string>
    </array>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>3</integer>

    <key>StandardOutPath</key>
    <string>${DAEMON_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${DAEMON_LOG}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// systemd user unit generation (Linux)
// ---------------------------------------------------------------------------

export function generateSystemdUnit(daemonBin: string, nodeBin: string): string {
  return `[Unit]
Description=PAI Daemon
After=network.target

[Service]
ExecStart=${nodeBin} ${daemonBin} serve
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

type LoginctlRunner = (args: string[]) => { status: number | null; stdout: string };

const runLoginctl: LoginctlRunner = (args) => {
  const r = spawnSync("loginctl", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/**
 * Turns on systemd linger for the user (so the user unit survives logout) without sudo
 * or a prompt; prints the sudo command only when the system refuses. Linux only.
 */
export function ensureLinger(
  plat: NodeJS.Platform = process.platform,
  username: string = userInfo().username,
  loginctl: LoginctlRunner = runLoginctl,
  log: (s: string) => void = console.log,
): void {
  if (plat !== "linux") return;
  const linger = () => {
    const r = loginctl(["show-user", username, "-p", "Linger"]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const before = linger();
  if (before === null || before === "Linger=yes") return;
  loginctl(["--no-ask-password", "enable-linger", username]);
  if (linger() === "Linger=yes") {
    log(ok("  linger: on (daemon survives logout)"));
    return;
  }
  log(warn(`  Linger is off for ${username} — the daemon stops when you log out.`));
  log(dim(`    Enable it: sudo loginctl enable-linger ${username}`));
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<number> {
  const config = loadConfig();
  const client = new PaiClient(config.socketPath);

  try {
    const status = await client.status();
    const s = status as Record<string, unknown>;

    console.log();
    console.log(bold("  PAI Daemon Status"));
    console.log();
    console.log(ok(`  Daemon running`));
    console.log(dim(`    PID:         ${resolveDaemonPid() ?? "unknown"}`));
    console.log(dim(`    Uptime:      ${s["uptime"]}s`));
    console.log(dim(`    Socket:      ${s["socketPath"]}`));
    if (s["dashboard"]) console.log(dim(`    Dashboard:   ${s["dashboard"]}`));
    const quiet = readQuiet();
    if (quiet.on) console.log(warn(`    Quiet:       ${describeQuiet(quiet)}`));

    // Lead with the outage and the backlog. Everything below them — index
    // state, totals — describes a system that is not moving, and printing those
    // first is how "Index: idle" came to mean "all is well" during a two-day
    // outage.
    const health = formatStorageHealth(s as StorageHealthStatus);
    if (health.length > 0) {
      console.log();
      for (const line of health) {
        const paint = line.severity === "error" ? err : line.severity === "warn" ? warn : dim;
        console.log(paint(`    ${line.text}`));
      }
      console.log();
    }
    console.log(
      dim(
        `    Index:       ${s["indexInProgress"] ? "in progress" : "idle"}  (interval: ${s["indexIntervalSecs"]}s)`
      )
    );
    if (s["lastIndexTime"]) {
      console.log(dim(`    Last index:  ${s["lastIndexTime"]}`));
    }
    for (const line of formatEmbedStatus(s as Parameters<typeof formatEmbedStatus>[0])) {
      console.log(dim(`    ${line}`));
    }
    if (s["db"]) {
      const db = s["db"] as Record<string, unknown>;
      console.log(
        dim(
          `    DB:          ${db["projects"]} projects, ${db["files"]} files, ${db["chunks"]} chunks`
        )
      );
    }
    console.log();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(warn("  PAI Daemon Status"));
    console.log();
    console.log(warn(`  Daemon not running: ${msg}`));
    console.log(dim("    Start with: pai daemon serve"));
    console.log(dim("    Or install as service: pai daemon install"));
    console.log();
    return 1;
  }
  return 0;
}

function cmdRestart(): number {
  if (!serviceManagerAllowed("pai daemon restart")) return 0;
  if (process.platform === "linux") {
    const before = resolveDaemonPid();
    const result = spawnSync("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      console.log(ok(`Restarted daemon pid ${before ?? "?"} -> ${resolveDaemonPid() ?? "?"}`));
    } else {
      console.error(err(`systemctl restart failed: ${(result.stderr || "").trim()}`));
      return 1;
    }
    return 0;
  }

  if (process.platform !== "darwin") {
    console.error(
      err(`Unsupported platform: ${process.platform}. Daemon restart supports macOS (launchd) and Linux (systemd user) only.`)
    );
    return 1;
  }

  // kickstart -k kills and restarts the launchd job; the old PID comes from launchd, never a pattern
  try {
    const before = resolveDaemonPid();
    const kick = spawnSync(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`],
      { encoding: "utf8" }
    );
    if (kick.status !== 0) {
      console.log(dim("Not managed by launchd. Run: pai daemon serve"));
      return 0;
    }
    console.log(ok(`Restarted daemon pid ${before ?? "?"} -> ${resolveDaemonPid() ?? "?"}`));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`restart error: ${msg}`));
    return 1;
  }
  return 0;
}

function installServiceDarwin(daemonBin: string): boolean {
  // 1. Write launchd plist
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  const plistContent = generatePlist(daemonBin);
  try {
    writeFileSync(PLIST_PATH, plistContent, "utf8");
    console.log(ok(`  Wrote launchd plist: ${PLIST_PATH}`));
  } catch (e) {
    console.error(err(`  Failed to write plist: ${e}`));
    return false;
  }

  // 2. Load the plist (unload first in case it was already there)
  if (!serviceManagerAllowed(`launchctl load ${PLIST_PATH}`)) return true;
  try {
    spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });
    const loadResult = spawnSync("launchctl", ["load", PLIST_PATH], {
      encoding: "utf8",
    });
    if (loadResult.status === 0) {
      console.log(ok("  Loaded plist with launchctl."));
    } else {
      console.log(warn(`  launchctl load: ${loadResult.stderr?.trim() ?? "unknown error"}`));
    }
  } catch {
    console.log(warn("  Could not run launchctl. Load manually:"));
    console.log(dim(`    launchctl load ${PLIST_PATH}`));
  }
  return true;
}

function installServiceLinux(daemonBin: string): boolean {
  // 1. Write systemd user unit
  if (!existsSync(SYSTEMD_USER_DIR)) {
    mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  }

  const unitContent = generateSystemdUnit(daemonBin, process.execPath);
  try {
    writeFileSync(SYSTEMD_UNIT_PATH, unitContent, "utf8");
    console.log(ok(`  Wrote systemd unit: ${SYSTEMD_UNIT_PATH}`));
  } catch (e) {
    console.error(err(`  Failed to write systemd unit: ${e}`));
    return false;
  }

  // 2. daemon-reload + enable --now
  if (!serviceManagerAllowed(`systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`)) return true;
  spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  const enableResult = spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME], {
    encoding: "utf8",
  });
  if (enableResult.status === 0) {
    console.log(ok("  Enabled and started via systemd."));
  } else {
    console.log(warn(`  systemctl enable --now: ${(enableResult.stderr || "").trim()}`));
  }

  ensureLinger();
  return true;
}

function cmdInstall(): number {
  const daemonBin = getDaemonBinPath();
  const shimBin = getShimBinPath();

  console.log();
  console.log(bold("  PAI Daemon Install"));
  console.log();

  if (process.platform === "darwin") {
    if (!installServiceDarwin(daemonBin)) return 1;
  } else if (process.platform === "linux") {
    if (!installServiceLinux(daemonBin)) return 1;
  } else {
    console.error(
      err(`  Unsupported platform: ${process.platform}. Daemon install supports macOS (launchd) and Linux (systemd user) only.`)
    );
    return 1;
  }

  // 3. Update ~/.claude.json to use the shim
  const config = readClaudeJson();

  if (typeof config.mcpServers !== "object" || config.mcpServers === null) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;

  // Check if already pointing to the shim
  const existing = servers["pai"] as Record<string, unknown> | undefined;
  const existingArgs = existing?.args as string[] | undefined;
  const alreadyShim = existingArgs?.includes(shimBin);

  if (alreadyShim) {
    console.log(ok("  ~/.claude.json already points to the shim."));
  } else {
    // Back up the existing entry if any
    if (existing) {
      servers["pai-legacy"] = existing;
      console.log(dim("  Backed up existing 'pai' entry as 'pai-legacy'."));
    }

    servers["pai"] = {
      command: "node",
      args: [shimBin],
    };

    try {
      writeClaudeJson(config);
      console.log(ok("  Updated ~/.claude.json to use daemon shim."));
    } catch (e) {
      console.error(err(`  Failed to write ~/.claude.json: ${e}`));
      return 1;
    }
  }

  // 4. Verify binaries exist
  console.log();
  if (!existsSync(daemonBin)) {
    console.log(warn(`  Daemon binary not found: ${daemonBin}`));
    console.log(dim("  Run: bun run build"));
  } else {
    console.log(ok(`  Daemon binary: ${daemonBin}`));
  }

  if (!existsSync(shimBin)) {
    console.log(warn(`  Shim binary not found: ${shimBin}`));
    console.log(dim("  Run: bun run build"));
  } else {
    console.log(ok(`  Shim binary: ${shimBin}`));
  }

  console.log();
  console.log(dim("  Restart Claude Code to activate the daemon-backed PAI tools."));
  console.log();
  return 0;
}

function uninstallServiceDarwin(): void {
  if (existsSync(PLIST_PATH)) {
    if (serviceManagerAllowed(`launchctl unload ${PLIST_PATH}`)) {
      try {
        spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });
        console.log(ok("  Unloaded launchd plist."));
      } catch {
        console.log(warn("  Could not unload plist via launchctl."));
      }
    }
    try {
      unlinkSync(PLIST_PATH);
      console.log(ok(`  Removed plist: ${PLIST_PATH}`));
    } catch (e) {
      console.log(warn(`  Could not remove plist: ${e}`));
    }
  } else {
    console.log(dim("  No launchd plist found."));
  }
}

function uninstallServiceLinux(): void {
  if (existsSync(SYSTEMD_UNIT_PATH)) {
    const managed = serviceManagerAllowed(`systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`);
    if (managed) {
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], {
        encoding: "utf8",
      });
      console.log(ok("  Disabled and stopped via systemd."));
    }
    try {
      unlinkSync(SYSTEMD_UNIT_PATH);
      console.log(ok(`  Removed unit: ${SYSTEMD_UNIT_PATH}`));
    } catch (e) {
      console.log(warn(`  Could not remove unit: ${e}`));
    }
    if (managed) spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  } else {
    console.log(dim("  No systemd unit found."));
  }
}

function cmdUninstall(): number {
  console.log();
  console.log(bold("  PAI Daemon Uninstall"));
  console.log();

  if (process.platform === "darwin") {
    uninstallServiceDarwin();
  } else if (process.platform === "linux") {
    uninstallServiceLinux();
  } else {
    console.error(
      err(`  Unsupported platform: ${process.platform}. Daemon uninstall supports macOS (launchd) and Linux (systemd user) only.`)
    );
    return 1;
  }

  // Revert ~/.claude.json to legacy direct MCP
  const config = readClaudeJson();
  const servers =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  const legacy = servers["pai-legacy"];
  if (legacy) {
    servers["pai"] = legacy;
    delete servers["pai-legacy"];
    try {
      writeClaudeJson(config);
      console.log(ok("  Reverted ~/.claude.json to legacy direct MCP."));
    } catch (e) {
      console.log(warn(`  Could not update ~/.claude.json: ${e}`));
    }
  } else {
    console.log(dim("  No legacy PAI entry found in ~/.claude.json."));
  }

  console.log();
  console.log(dim("  Restart Claude Code to deactivate daemon-backed tools."));
  console.log();
  return 0;
}

async function cmdMigrate(connectionString?: string): Promise<number> {
  console.log();
  console.log(bold("  PAI Daemon Migrate"));
  console.log();
  console.log(dim("  Running SQLite → PostgreSQL migration..."));
  console.log();

  // The migration script is at docker/migrate-sqlite.ts, a package-root
  // sibling of dist/ that is not bundled — walk up to find it regardless of
  // which dist/ chunk this module ended up in.
  const migrationScript = resolveFromModule(import.meta.url, "docker/migrate-sqlite.ts");
  const { spawnSync: spawn } = await import("node:child_process");

  // Use npx tsx to run the TypeScript migration script (bun doesn't support better-sqlite3)
  const spawnArgs = ["tsx", migrationScript];
  if (connectionString) {
    spawnArgs.push("--connection-string", connectionString);
  }

  const result = spawn("npx", spawnArgs, { stdio: "inherit", encoding: "utf8" });

  if (result.status !== 0) {
    console.error(err("  Migration failed. Check output above."));
    return result.status ?? 1;
  }
  return 0;
}

function cmdKeepalive(): number {
  const config = loadConfig().sessions.cacheKeepalive;

  console.log();
  console.log(bold("  Session cache keepalive"));
  console.log();
  console.log(config.enabled ? ok(`  enabled`) : warn(`  disabled`));
  console.log(
    dim(
      `    idleMinutes: ${config.idleMinutes}  maxBeats: ${config.maxBeats}  ` +
        `activeHours: ${config.activeHours}  minContextTokens: ${config.minContextTokens}  prompt: "${config.prompt}"`
    )
  );
  if (!config.enabled) {
    console.log();
    console.log(dim(`  Enable it in ${resolvedMainConfigPath(paiConfigFilePath())}: sessions.cacheKeepalive.enabled: true`));
    console.log(dim(`    pai config set sessions.cacheKeepalive.enabled true`));
  }

  const state = loadSessionKeepaliveState();
  const ids = Object.keys(state);
  console.log();
  if (ids.length === 0) {
    console.log(dim("  No per-session beat counters recorded yet."));
  } else {
    console.log(bold("  Per-session beat counters"));
    for (const id of ids) {
      const e = state[id];
      console.log(dim(`    ${id}: beats=${e.beats} lastBeatAt=${e.lastBeatAt ?? "never"}`));
    }
  }

  const summary = sessionKeepaliveLedgerSummary();
  console.log();
  console.log(bold(`  Ledger: ${summary.sent} sent, ${summary.skipped} skipped`));
  for (const line of summary.lastLines) {
    console.log(dim(`    ${line}`));
  }
  console.log();
  return 0;
}

function cmdLogs(opts: { lines?: string; follow?: boolean }): number {
  const lines = opts.lines ?? "50";

  if (!existsSync(DAEMON_LOG)) {
    console.log(warn(`No daemon log found at ${DAEMON_LOG}.`));
    console.log(dim("The daemon may not have run yet."));
    return 0;
  }

  if (opts.follow) {
    // exec stays running
    try {
      execFileSync("tail", ["-f", "-n", lines, DAEMON_LOG], { stdio: "inherit" });
    } catch {
      // User pressed Ctrl+C — that's fine
    }
  } else {
    try {
      execFileSync("tail", ["-n", lines, DAEMON_LOG], { stdio: "inherit" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(err(`Could not read log: ${msg}`));
      return 1;
    }
  }
  return 0;
}

export async function daemonServeCmd(): Promise<number> {
  const { serve } = await import("../../daemon/daemon.js");
  const { loadConfig: lc, ensureConfigDir } = await import(
    "../../daemon/config.js"
  );
  ensureConfigDir();
  const config = lc();
  await serve(config);
  return 0;
}

export function daemonMigrateCmd(opts: { connectionString?: string }): Promise<number> {
  return cmdMigrate(opts.connectionString);
}

export function daemonQuietCmd(action: string, opts: { until?: string }): number {
  if (action === "status") {
    console.log(`Quiet mode: ${describeQuiet(readQuiet())}`);
    return 0;
  }
  if (action === "off") {
    if (opts.until) { console.error(err("--until only applies to `quiet on`.")); return 1; }
    writeQuiet(false);
    console.log(ok("Quiet mode off. Deferred jobs run once within about 30s."));
    return 0;
  }
  if (action !== "on") { console.error(err(`Unknown action "${action}": use on, off or status.`)); return 1; }
  let until: number | undefined;
  try {
    until = opts.until ? nextOccurrence(opts.until) : undefined;
  } catch (e) {
    console.error(err(e instanceof Error ? e.message : String(e)));
    return 1;
  }
  writeQuiet(true, until);
  console.log(ok(`Quiet mode ${describeQuiet(readQuiet())}.`));
  return 0;
}

export function daemonStatusCmd(): Promise<number> {
  return cmdStatus();
}

export function daemonRestartCmd(): number {
  return cmdRestart();
}

export function daemonInstallCmd(): number {
  return cmdInstall();
}

export function daemonUninstallCmd(): number {
  return cmdUninstall();
}

export function daemonKeepaliveCmd(): number {
  return cmdKeepalive();
}

export function daemonLogsCmd(opts: { lines?: string; follow?: boolean }): number {
  return cmdLogs(opts);
}

// ---------------------------------------------------------------------------
// start / stop (launchd bootstrap/bootout, systemd start/stop)
// ---------------------------------------------------------------------------

export interface ServiceControlDeps {
  plat: NodeJS.Platform;
  uid: number;
  run: (cmd: string, args: string[]) => { status: number | null; stderr?: string };
  installed: () => boolean;
  pid: () => number | undefined;
  sleep: (ms: number) => Promise<void>;
  log: (s: string) => void;
  error: (s: string) => void;
  waitMs: number;
}

const realServiceControlDeps = (): ServiceControlDeps => ({
  plat: process.platform,
  uid: process.getuid?.() ?? userInfo().uid,
  run: (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr ?? "" };
  },
  installed: () => existsSync(process.platform === "linux" ? SYSTEMD_UNIT_PATH : PLIST_PATH),
  pid: () => resolveDaemonPid(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: console.log,
  error: console.error,
  waitMs: 15_000,
});

async function waitFor(cond: () => boolean, d: ServiceControlDeps): Promise<boolean> {
  for (let waited = 0; ; waited += 250) {
    if (cond()) return true;
    if (waited >= d.waitMs) return false;
    await d.sleep(250);
  }
}

/**
 * start: loads the plist into launchd (bootstrap; RunAtLoad starts it) or kickstarts a job that is
 * loaded but idle. stop: bootout unloads the job so KeepAlive cannot respawn it; the plist stays,
 * so `start` and the next login bring it back (uninstall is what removes it).
 */
export async function daemonServiceControl(
  action: "start" | "stop",
  d: ServiceControlDeps = realServiceControlDeps(),
): Promise<number> {
  if (d.plat !== "darwin" && d.plat !== "linux") {
    d.error(err(`Unsupported platform: ${d.plat}. Daemon ${action} supports macOS (launchd) and Linux (systemd user) only.`));
    return 1;
  }
  if (!d.installed()) {
    d.error(err("Daemon service is not installed. Run: pai daemon install"));
    return 1;
  }
  const running = d.pid();
  if (action === "start" && running) {
    d.log(ok(`Daemon already running (pid ${running})`));
    return 0;
  }
  if (action === "stop" && !running) {
    d.log(dim("Daemon is not running"));
    return 0;
  }

  const target = `gui/${d.uid}/${PLIST_LABEL}`;
  let result: { status: number | null; stderr?: string };
  if (d.plat === "linux") {
    result = d.run("systemctl", ["--user", action, SYSTEMD_UNIT_NAME]);
  } else if (action === "stop") {
    result = d.run("launchctl", ["bootout", target]);
  } else {
    result = d.run("launchctl", ["bootstrap", `gui/${d.uid}`, PLIST_PATH]);
    // Already loaded but idle: bootstrap refuses, kickstart runs the loaded job.
    if (result.status !== 0) result = d.run("launchctl", ["kickstart", target]);
  }
  if (result.status !== 0) {
    d.error(err(`${action} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`));
    return 1;
  }

  const done = await waitFor(() => (action === "start" ? d.pid() !== undefined : d.pid() === undefined), d);
  if (!done) {
    d.error(
      err(
        action === "start"
          ? `Daemon did not report running within ${d.waitMs / 1000}s. See ${DAEMON_LOG}`
          : `Daemon still running after ${d.waitMs / 1000}s (pid ${d.pid() ?? "?"})`,
      ),
    );
    return 1;
  }
  if (action === "start") {
    d.log(ok(`Started daemon pid ${d.pid() ?? "?"}`));
  } else {
    d.log(ok(`Stopped daemon pid ${running ?? "?"}. It stays stopped until: pai daemon start`));
    d.log(dim("  Not running while stopped: scheduler passes, router supervision (when router.enabled), IPC and MCP tools."));
  }
  return 0;
}

export function daemonStartCmd(): Promise<number> {
  return daemonServiceControl("start");
}

export function daemonStopCmd(): Promise<number> {
  return daemonServiceControl("stop");
}
