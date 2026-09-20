/**
 * pai audit tokens [section]
 *
 * files    — token count per memory file (CLAUDE.md chain, CORE skill,
 *            whisper rules, project auto-memory) and their total
 * hooks    — token cost of every SessionStart / UserPromptSubmit hook,
 *            plus which PreToolUse hooks rewrite Bash commands
 * session  — cache/input/output token split for one session transcript
 * spawn    — first-turn context overhead: Agent-tool subagents vs. pai
 *            workers (interactive/pane vs. headless)
 * daemon   — LLM spawns, KG-extraction parse failures, work-queue counts
 *            from the daemon log
 * env      — ANTHROPIC_BASE_URL / model-override env on every live claude
 *            process, MCP server count, configured model/effort
 * schedule — launchd agents / crontab entries that wake up more often than
 *            the measured prompt-cache TTL
 *
 * With no section, all seven run and one combined RED/AMBER/GREEN table is
 * printed. `--json` prints the same data as JSON instead of a table.
 */

import type { Command } from "commander";
import { header, ok, warn, err, dim, bold, renderTable } from "../utils.js";
import { TOKEN_ENCODING } from "../../audit/tokens.js";
import { auditFiles, defaultFileSet, type FilesReport } from "../../audit/files.js";
import { auditHooks, type HooksReport } from "../../audit/hooks.js";
import { auditSession, newestSessionLog, type SessionReportOutput } from "../../audit/session.js";
import { auditSpawn, type SpawnGroupStats, type SpawnReport } from "../../audit/spawn.js";
import { auditDaemon, type DaemonReport } from "../../audit/daemon.js";
import { auditEnv, type EnvReport } from "../../audit/env.js";
import { auditSchedule, cacheTtlSeconds } from "../../audit/schedule.js";
import { buildFindings, type Finding, type Severity } from "../../audit/severity.js";

function severityColor(sev: Severity, text: string): string {
  if (sev === "RED") return err(text);
  if (sev === "AMBER") return warn(text);
  return ok(text);
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function printFiles(report: FilesReport): void {
  console.log(header(`Memory files (encoding: ${report.encoding})`));
  const rows = report.readings.map((r) => [
    r.missing ? dim("MISSING") : String(r.tokens),
    r.path,
  ]);
  console.log(renderTable(["tokens", "path"], rows));
  console.log(bold(`total: ${report.total} tokens`));
}

async function cmdFiles(paths: string[], opts: { json?: boolean }): Promise<void> {
  const targets = paths.length > 0 ? paths : defaultFileSet(process.cwd());
  const report = auditFiles(targets);
  if (opts.json) return printJson(report);
  printFiles(report);
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

function printHooks(report: HooksReport): void {
  console.log(header(`Hook output (encoding: ${report.encoding})`));
  console.log(dim(`settings.json: ${report.settingsFiles.join(", ") || "none found"}`));
  const rows = report.readings.map((r) => [
    r.event,
    r.matcher ?? "",
    String(r.tokens),
    r.error ? err(r.error) : "",
    r.command,
  ]);
  console.log(renderTable(["event", "matcher", "tokens", "error", "command"], rows));
  for (const [event, total] of Object.entries(report.totalsByEvent)) {
    console.log(bold(`${event} total: ${total} tokens`));
  }
  console.log(
    dim(
      `PreToolUse hooks: ${report.preToolUseHooks.length}` +
        (report.preToolUseRewritesBash ? ", including a Bash-matcher rewrite hook" : "")
    )
  );
}

function cmdHooks(opts: { json?: boolean }): void {
  const report = auditHooks(process.cwd());
  if (opts.json) return printJson(report);
  printHooks(report);
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

function printSession(report: SessionReportOutput): void {
  console.log(header(`Session usage: ${report.path}`));
  console.log(dim(`size: ${report.sizeBytes} bytes, assistant turns with usage: ${report.turns}`));
  const rows = Object.entries(report.totals).map(([key, value]) => [
    key,
    value.toLocaleString("en-US"),
    `${report.percentages[key].toFixed(1)}%`,
  ]);
  rows.push(["TOTAL", report.totalTokens.toLocaleString("en-US"), "100.0%"]);
  console.log(renderTable(["metric", "tokens", "share"], rows));
  console.log(`context on first turn: ${report.firstTurnContext ?? "n/a"}`);
  console.log(`context on last turn:  ${report.lastTurnContext ?? "n/a"}`);
  console.log(
    `cache_creation split: ephemeral_5m=${report.cacheCreationSplit.ephemeral5m}, ` +
      `ephemeral_1h=${report.cacheCreationSplit.ephemeral1h}`
  );
  console.log(dim(`models: ${JSON.stringify(report.models)}`));
}

async function cmdSession(path: string | undefined, opts: { json?: boolean }): Promise<void> {
  const report = await auditSession(path);
  if (!report) {
    console.error(err("  No session transcript found."));
    process.exitCode = 1;
    return;
  }
  if (opts.json) return printJson(report);
  printSession(report);
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

function printSpawnGroup(name: string, stats: SpawnGroupStats): string[] {
  return [
    name,
    String(stats.count),
    stats.min === null ? "n/a" : String(stats.min),
    stats.median === null ? "n/a" : String(stats.median),
    stats.max === null ? "n/a" : String(stats.max),
    stats.models.join(", "),
  ];
}

function printSpawn(report: SpawnReport): void {
  console.log(header("Spawn overhead (first-turn context tokens)"));
  const rows = [
    printSpawnGroup("Agent-tool subagents", report.agentSubagents),
    printSpawnGroup("pai workers (interactive/pane)", report.workersInteractive),
    printSpawnGroup("pai workers (headless -p)", report.workersHeadless),
  ];
  console.log(renderTable(["group", "count", "min", "median", "max", "models"], rows));
}

async function cmdSpawn(opts: { json?: boolean; n?: string }): Promise<void> {
  const n = opts.n ? parseInt(opts.n, 10) : 10;
  const report = await auditSpawn(n);
  if (opts.json) return printJson(report);
  printSpawn(report);
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

function printDaemon(report: DaemonReport): void {
  console.log(header(`Daemon log: ${report.logPath}`));
  console.log(dim(`window start (log file birth time): ${report.windowStart ?? "unknown"}`));
  const spawnRows = Object.entries(report.spawnsByModel).map(([model, s]) => [
    model,
    String(s.count),
    String(s.avgPromptChars),
  ]);
  console.log(renderTable(["model", "spawns", "avg prompt chars"], spawnRows));
  console.log(
    `kg-extraction JSON parse failures: ${report.kgParseFailures} ` +
      `(${(report.kgParseFailureRate * 100).toFixed(1)}% of session-summary spawns; ` +
      `${report.kgExtractionLines} kg-extraction log lines total)`
  );
  const jobRows = Object.entries(report.jobCounts).map(([job, c]) => [job, String(c.processing), String(c.completed)]);
  console.log(renderTable(["job type", "processing", "completed"], jobRows));
}

function cmdDaemon(opts: { json?: boolean }): void {
  const report = auditDaemon();
  if (opts.json) return printJson(report);
  printDaemon(report);
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

function printEnv(report: EnvReport): void {
  console.log(header("Live claude processes"));
  const rows = report.processes.map((p) => [
    String(p.pid),
    p.baseUrl ? err(p.baseUrl) : dim("(default)"),
    p.authTokenPresent ? "present" : "absent",
    JSON.stringify(p.defaultModels),
    p.enableToolSearch ?? "",
    p.workerId ?? "",
    p.age ?? "",
  ]);
  console.log(renderTable(["pid", "base url", "auth token", "default models", "tool search", "worker id", "age"], rows));
  for (const p of report.processes) {
    if (p.baseUrl) console.log(err(`  RED: claude process ${p.pid} is routed through ${p.baseUrl}`));
  }
  console.log(dim(`MCP servers registered: ${report.mcpServerCount}`));
  console.log(dim(`settings.json model: ${report.settingsModel ?? "unset"}, effortLevel: ${report.settingsEffortLevel ?? "unset"}`));
}

function cmdEnv(opts: { json?: boolean }): void {
  const report = auditEnv();
  if (opts.json) return printJson(report);
  printEnv(report);
}

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

async function scheduleTtlSeconds(): Promise<number> {
  const session = await auditSession(newestSessionLog() ?? undefined).catch(() => null);
  return cacheTtlSeconds(session?.cacheCreationSplit);
}

function printSchedule(report: Awaited<ReturnType<typeof auditSchedule>>): void {
  console.log(header(`Launchd agents (cache TTL: ${report.ttlSeconds}s)`));
  const rows = report.agents.map((a) => [
    a.label ?? "",
    a.startInterval === null ? "" : String(a.startInterval),
    a.startCalendarInterval ? "yes" : "",
    a.keepAlive ? "yes" : "",
    a.programArgs.join(" "),
    a.exceedsTtl ? warn("exceeds TTL") : "",
  ]);
  console.log(renderTable(["label", "interval(s)", "calendar", "keepAlive", "program", ""], rows));
  console.log(header("crontab -l"));
  for (const line of report.crontabLines) console.log(dim(line));
}

async function cmdSchedule(opts: { json?: boolean }): Promise<void> {
  const ttl = await scheduleTtlSeconds();
  const report = auditSchedule(ttl);
  if (opts.json) return printJson(report);
  printSchedule(report);
}

// ---------------------------------------------------------------------------
// combined
// ---------------------------------------------------------------------------

async function cmdCombined(opts: { json?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const files = auditFiles(defaultFileSet(cwd));
  const hooks = auditHooks(cwd);
  const session = await auditSession(newestSessionLog() ?? undefined).catch(() => null);
  const daemon = auditDaemon();
  const env = auditEnv();
  const spawn = await auditSpawn();
  const ttl = cacheTtlSeconds(session?.cacheCreationSplit);
  const schedule = auditSchedule(ttl);

  const findings: Finding[] = buildFindings({ files, hooks, session, daemon, env });

  if (opts.json) {
    return printJson({ encoding: TOKEN_ENCODING, findings, files, hooks, session, spawn, daemon, env, schedule });
  }

  console.log(header("pai audit tokens — combined report"));
  console.log(dim(`token encoding: ${TOKEN_ENCODING}`));
  const rows = findings.map((f) => [severityColor(f.severity, f.finding), severityColor(f.severity, f.severity), f.evidence]);
  console.log(renderTable(["FINDING", "SEVERITY", "EVIDENCE"], rows));
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/**
 * `--json` is declared once, on `tokensCmd` itself, and read back from there
 * in every subcommand action below — not redeclared per subcommand. Commander
 * resolves an option to whichever command in the chain first declares it, so
 * a child command that *also* declares `--json` never sees the flag: it gets
 * consumed by the parent before the child's own `opts()` is populated, and
 * `--json` on `pai audit tokens files` silently produced the table output.
 */
export function registerAuditCommands(auditCmd: Command): void {
  const tokensCmd = auditCmd
    .command("tokens")
    .description("Token-waste audit: memory files, hooks, session usage, spawn overhead, daemon, env, schedule")
    .option("--json", "Print JSON instead of a table")
    .action(async () => {
      await cmdCombined(jsonOpt());
    });

  const jsonOpt = (): { json?: boolean } => tokensCmd.opts() as { json?: boolean };

  tokensCmd
    .command("files")
    .description("Token count per memory file (CLAUDE.md chain, CORE skill, whisper rules, auto-memory)")
    .argument("[paths...]", "Files to count (default: the standard memory set)")
    .action(async (paths: string[]) => {
      await cmdFiles(paths, jsonOpt());
    });

  tokensCmd
    .command("hooks")
    .description("Token cost of every SessionStart / UserPromptSubmit hook")
    .action(() => cmdHooks(jsonOpt()));

  tokensCmd
    .command("session")
    .description("Cache/input/output token split for a session transcript (default: newest)")
    .argument("[path]", "Session JSONL path (default: newest under ~/.claude/projects)")
    .action(async (path: string | undefined) => {
      await cmdSession(path, jsonOpt());
    });

  tokensCmd
    .command("spawn")
    .description("Spawn-overhead comparison: Agent-tool subagents vs. pai workers")
    .option("-n, --n <count>", "How many of the newest logs per group to read (default 10)")
    .action(async (opts: { n?: string }) => {
      await cmdSpawn({ ...jsonOpt(), ...opts });
    });

  tokensCmd
    .command("daemon")
    .description("LLM spawns, KG-extraction parse failures, work-queue counts from the daemon log")
    .action(() => cmdDaemon(jsonOpt()));

  tokensCmd
    .command("env")
    .description("ANTHROPIC_BASE_URL / model-override env on every live claude process")
    .action(() => cmdEnv(jsonOpt()));

  tokensCmd
    .command("schedule")
    .description("Launchd agents / crontab entries that outpace the measured prompt-cache TTL")
    .action(async () => {
      await cmdSchedule(jsonOpt());
    });
}
