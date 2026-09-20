/**
 * pai audit tokens [section]
 *
 * files    — token count per memory file (CLAUDE.md chain, CORE skill,
 *            whisper rules, project auto-memory) and their total
 * hooks    — token cost of every SessionStart / UserPromptSubmit hook,
 *            plus which PreToolUse hooks rewrite Bash commands
 * session  — cache/input/output token split for one session transcript,
 *            plus a first-turn breakdown attributing turn-1 tokens to the
 *            live-lineage transcript lines (hooks, skill listing, deferred
 *            tools, MCP instructions, prompt) with dead-branch tokens
 *            (abandoned prompts, persisted but never sent) reported
 *            separately; `--history [n]` lists the first-turn context of
 *            the newest n sessions in this project's transcript directory,
 *            newest first; `--turn <n>` attributes API call n's context
 *            growth to the lines injected since the previous call (hooks,
 *            prompts, tool results, the previous call's re-sent output)
 *            plus the cl100k residual against the billing tokenizer
 * spawn    — first-turn context overhead: Agent-tool subagents vs. pai
 *            workers (interactive/pane vs. headless); `--detail` adds
 *            per-log prompt-token/overhead rows and a median-overhead column
 * daemon   — LLM spawns, KG-extraction parse failures, work-queue counts
 *            from the daemon log
 * env      — ANTHROPIC_BASE_URL / model-override env on every live claude
 *            process, MCP server count, configured model/effort
 * schedule — launchd agents / crontab entries that wake up more often than
 *            the measured prompt-cache TTL
 * skills   — token cost of the SKILL.md/command/plugin catalogue, top
 *            entries by tokens, per-source subtotals, case-insensitive
 *            duplicate names
 * ladder   — LIVE (spawns `claude -p`, requires `--live`): first-turn context
 *            at increasing headless-worker configuration (empty MCP/no
 *            tools → tools → real MCP → plain)
 *
 * With no section, all eight non-live sections run and one combined
 * RED/AMBER/GREEN table is printed. `--json` prints the same data as JSON
 * instead of a table.
 */

import type { Command } from "commander";
import { homedir } from "node:os";
import { mkdirSync, readdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { header, ok, warn, err, dim, bold, renderTable } from "../utils.js";
import { TOKEN_ENCODING } from "../../audit/tokens.js";
import { auditFiles, defaultFileSet, type FilesReport } from "../../audit/files.js";
import { auditHooks, type HooksReport } from "../../audit/hooks.js";
import { auditSession, newestSessionLog, sessionHistory, type SessionReportOutput, type SessionHistoryRow } from "../../audit/session.js";
import { turnBreakdown, type TurnBreakdown } from "../../audit/first-turn.js";
import { auditSpawn, type SpawnGroupStats, type SpawnReport } from "../../audit/spawn.js";
import { auditDaemon, type DaemonReport } from "../../audit/daemon.js";
import { auditEnv, type EnvReport } from "../../audit/env.js";
import { auditSchedule, cacheTtlSeconds } from "../../audit/schedule.js";
import { buildFindings, type Finding, type Severity } from "../../audit/severity.js";
import { auditSkills, topByTokens, type SkillsReport } from "../../audit/skills.js";
import { auditLadder, type LadderReport } from "../../audit/ladder.js";
import { auditSubagents, type SubagentsReport } from "../../audit/subagents.js";
import { auditMcp, type McpReport } from "../../audit/mcp.js";
import { shortenPath } from "../utils.js";
import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";

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
  if (report.firstTurn && report.firstTurn.apiContext !== null) {
    const ft = report.firstTurn;
    console.log(header("first-turn breakdown (live lineage, cl100k)"));
    const ftRows = ft.items.filter((i) => i.tokens > 0).map((i) => [i.kind, String(i.tokens), i.label]);
    console.log(renderTable(["kind", "tokens", "label"], ftRows));
    console.log(`transcript-side: ${ft.transcriptTokens}`);
    console.log(`remainder (system prompt + tool schemas + agents + memory): ${ft.remainder}`);
    console.log(`dead-branch: ${ft.deadBranchTokens} tokens on ${ft.deadBranchLines} lines, persisted but never sent`);
  }
  console.log(`context on last turn:  ${report.lastTurnContext ?? "n/a"}`);
  console.log(
    `cache_creation split: ephemeral_5m=${report.cacheCreationSplit.ephemeral5m}, ` +
      `ephemeral_1h=${report.cacheCreationSplit.ephemeral1h}`
  );
  console.log(dim(`models: ${JSON.stringify(report.models)}`));
  console.log(
    `avg context: ${report.avgContext ?? "n/a"}, max context: ${report.maxContext ?? "n/a"}, ` +
      `turns above threshold: ${report.turnsAboveThreshold}, cache-rebuild turns: ${report.cacheRebuildTurns}, ` +
      `user prompts: ${report.userPrompts}, prompt exposure: ${report.promptExposure}`
  );
  console.log(`compactions: ${report.compactions.length}`);
  for (const c of report.compactions) {
    console.log(dim(`  ${c.trigger} at turn ${c.turnIndex}: preTokens=${c.preTokens}`));
  }
  console.log(`model switches: ${report.modelSwitches.length}`);
  for (const s of report.modelSwitches) {
    console.log(dim(`  ${s.from} -> ${s.to} at turn ${s.turnIndex}: cache_read=${s.cacheRead}, cache_creation=${s.cacheCreation}`));
  }
  if (report.fallbacks.length > 0) {
    console.log(`safeguard fallbacks: ${report.fallbacks.length}`);
    for (const f of report.fallbacks) {
      console.log(dim(`  ${f.from} -> ${f.to} before turn ${f.turnIndex}: ${f.category} (${f.scope})`));
    }
  }
  console.log(
    dim(
      `idle gaps > 60min: ${report.idleGapsOver60min}, keepalive beats: ${report.keepaliveBeats ?? "n/a"}`
    )
  );
}

function printTurnBreakdown(tb: TurnBreakdown): void {
  console.log(header(`turn ${tb.turn} attribution (live lineage, cl100k)`));
  const rows = tb.items
    .filter((i) => i.tokens > 0)
    .map((i) => [String(i.tokens), i.kind, i.label.replace(/\s+/g, " ").slice(0, 60)]);
  console.log(renderTable(["tokens", "kind", "label"], rows));
  console.log(`transcript-side ${tb.transcriptTokens}`);
  console.log(`billed delta ${tb.billedDelta ?? "n/a"} (context ${tb.apiContext ?? "n/a"} after ${tb.prevApiContext})`);
  console.log(`previous call output ${tb.prevOutputTokens} (includes thinking, re-sent on tool turns)`);
  console.log(
    `previous call visible output ${tb.prevVisibleTokens} (cl100k, listed as assistant:prev, not in transcript-side)`
  );
  console.log(
    `residual ${tb.residual ?? "n/a"}: positive = cl100k undercount vs the billing tokenizer (1.2-1.45x measured on tool output and markdown tables); negative = the previous call's thinking was not re-sent (only re-sent inside a tool loop)`
  );
}

function printSessionHistory(rows: SessionHistoryRow[]): void {
  console.log(header("Session history (newest first)"));
  const tableRows = rows.map((r) => [
    r.firstTurnAt ?? "n/a",
    r.sessionId,
    r.firstTurnContext === null ? "n/a" : String(r.firstTurnContext),
    String(r.turns),
    String(r.switches),
    Object.entries(r.models)
      .map(([name, count]) => `${name}:${count}`)
      .join(","),
  ]);
  console.log(renderTable(["first turn (UTC)", "session", "first-turn ctx", "turns", "switches", "models"], tableRows));
}

async function cmdSession(
  path: string | undefined,
  opts: { json?: boolean; ctxThreshold?: string; history?: string | boolean; turn?: string }
): Promise<void> {
  if (opts.history !== undefined) {
    const limit = typeof opts.history === "string" ? parseInt(opts.history, 10) : 20;
    const rows = await sessionHistory(process.cwd(), limit);
    if (opts.json) return printJson(rows);
    printSessionHistory(rows);
    return;
  }
  if (opts.turn !== undefined) {
    const target = path ?? newestSessionLog();
    if (!target) {
      console.error(err("  No session transcript found."));
      process.exitCode = 1;
      return;
    }
    const tb = turnBreakdown(target, parseInt(opts.turn, 10));
    if (!tb) {
      console.error(err(`  Turn ${opts.turn} not found in ${target}.`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) return printJson(tb);
    printTurnBreakdown(tb);
    return;
  }
  const threshold = opts.ctxThreshold ? parseInt(opts.ctxThreshold, 10) : undefined;
  const report = await auditSession(path, threshold);
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
    stats.medianOverhead === null ? "n/a" : String(stats.medianOverhead),
    stats.models.join(", "),
  ];
}

const SPAWN_GROUP_LABELS: Record<string, string> = {
  agentSubagents: "Agent-tool subagents",
  workersInteractive: "pai workers (interactive/pane)",
  workersHeadless: "pai workers (headless -p)",
};

function printSpawn(report: SpawnReport, detail?: boolean): void {
  if (detail) {
    console.log(header("Spawn overhead — per-log detail"));
    const rows = report.readings.map((r) => [
      SPAWN_GROUP_LABELS[r.group] ?? r.group,
      r.firstTurnContext === null ? "n/a" : String(r.firstTurnContext),
      r.promptTokens === null ? "n/a" : String(r.promptTokens),
      r.overhead === null ? "n/a" : String(r.overhead),
      r.model ?? "",
      shortenPath(r.path, 70),
    ]);
    console.log(renderTable(["group", "first-turn ctx", "prompt tok", "overhead", "model", "path"], rows));
  }
  console.log(header("Spawn overhead (first-turn context tokens)"));
  const rows = [
    printSpawnGroup("Agent-tool subagents", report.agentSubagents),
    printSpawnGroup("pai workers (interactive/pane)", report.workersInteractive),
    printSpawnGroup("pai workers (headless -p)", report.workersHeadless),
  ];
  console.log(renderTable(["group", "count", "min", "median", "max", "median overhead", "models"], rows));
}

async function cmdSpawn(opts: { json?: boolean; n?: string; detail?: boolean }): Promise<void> {
  const n = opts.n ? parseInt(opts.n, 10) : 10;
  const report = await auditSpawn(n);
  if (opts.json) return printJson(report);
  printSpawn(report, opts.detail);
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
    String(p.mcpServers),
    p.deferral === "OFF" ? err(p.deferral) : p.deferral === "n/a" ? dim(p.deferral) : p.deferral,
    p.workerId ?? "",
    p.age ?? "",
  ]);
  console.log(
    renderTable(
      ["pid", "base url", "auth token", "default models", "tool search", "tools", "deferral", "worker id", "age"],
      rows
    )
  );
  for (const p of report.processes) {
    if (p.baseUrl) console.log(err(`  RED: claude process ${p.pid} is routed through ${p.baseUrl}`));
    const mcpCount = p.mcpServers === "default" ? report.mcpServerCount : p.mcpServers;
    if (p.deferral === "OFF" && mcpCount > 0) {
      console.log(err(`  RED: claude process ${p.pid} has --tools without ToolSearch (${mcpCount} MCP servers registered)`));
    }
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
// skills
// ---------------------------------------------------------------------------

function printSkills(report: SkillsReport, top: number): void {
  console.log(header(`Skill/command/plugin catalogue (encoding: ${report.encoding})`));
  console.log(dim(`${report.entries.length} entries, ${report.enabledTotal} tokens loaded (${report.total} on disk)`));
  const subtotalRows = (["skills", "commands", "plugins"] as const).map((source) => [
    source,
    String(report.countsBySource[source]),
    String(report.totalsBySource[source]),
    String(report.enabledTotalsBySource[source]),
  ]);
  console.log(renderTable(["source", "entries", "tokens", "enabled"], subtotalRows));

  console.log(header(`Top ${top} by tokens`));
  const topRows = topByTokens(report, top).map((e) => [String(e.tokens), e.source, e.enabled ? "yes" : "no", e.name, e.path]);
  console.log(renderTable(["tokens", "source", "on", "name", "path"], topRows));

  console.log(header("Case-insensitive duplicate names"));
  if (report.duplicates.length === 0) {
    console.log(dim("none"));
  } else {
    for (const dup of report.duplicates) {
      console.log(`${bold(dup.name)}:`);
      for (const path of dup.paths) console.log(`  ${path}`);
    }
  }
}

function cmdSkills(opts: { json?: boolean; top?: string }): void {
  const top = opts.top ? parseInt(opts.top, 10) : 15;
  const report = auditSkills();
  if (opts.json) return printJson({ ...report, top: topByTokens(report, top) });
  printSkills(report, top);
}

// ---------------------------------------------------------------------------
// ladder
// ---------------------------------------------------------------------------

function printLadder(report: LadderReport): void {
  console.log(header(`Context ladder (model: ${report.model}, mcp config: ${report.mcpConfigPath})`));
  const rows = report.readings.map((r) => [
    r.id,
    r.description,
    r.timedOut ? "TIMEOUT" : r.firstTurnContext === null ? `n/a${r.error ? ` (${r.error})` : ""}` : String(r.firstTurnContext),
    r.delta === null ? "n/a" : String(r.delta),
  ]);
  console.log(renderTable(["rung", "description", "first-turn tokens", "delta"], rows));
}

async function cmdLadder(opts: { json?: boolean; live?: boolean; model?: string; mcpConfig?: string }): Promise<void> {
  if (!opts.live) {
    console.log(
      warn(
        "Refusing to run: `pai audit tokens ladder` spawns several real `claude -p` calls " +
          "(billed API traffic). Pass --live to run it."
      )
    );
    return;
  }
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  const report = await auditLadder({ model: opts.model, mcpConfigPath: opts.mcpConfig, logDir });
  if (opts.json) return printJson(report);
  printLadder(report);
}

// ---------------------------------------------------------------------------
// subagents
// ---------------------------------------------------------------------------

function printSubagents(report: SubagentsReport): void {
  console.log(header(`Subagent definitions (encoding: ${report.encoding})`));
  if (report.entries.length === 0) {
    console.log(dim("no agent files"));
    return;
  }
  const rows = report.entries.map((e) => [String(e.tokens), e.model === "inherits" ? dim("inherits") : e.model, e.path]);
  console.log(renderTable(["tokens", "model", "path"], rows));
  const inheriting = report.entries.filter((e) => e.model === "inherits").length;
  console.log(dim(`${inheriting} of ${report.entries.length} inherit the caller's model`));
}

function cmdSubagents(opts: { json?: boolean }): void {
  const report = auditSubagents(homedir(), process.cwd());
  if (opts.json) return printJson(report);
  printSubagents(report);
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

function printMcp(report: McpReport): void {
  console.log(header("MCP servers: configured vs. loaded vs. used"));
  const rows = report.servers.map((s) => [
    s.server + (s.disabled ? dim(" (disabled)") : ""),
    s.configuredIn.join(", ") || dim("-"),
    s.pinned ?? dim("all"),
    s.loadedLive,
    String(s.toolsExposed),
    String(s.toolsUsed30d),
    String(s.calls30d),
  ]);
  console.log(
    renderTable(
      ["server", "configured-in", "pinned", "loaded-live", "tools-exposed", "tools-used-30d", "calls-30d"],
      rows
    )
  );
  console.log(dim(`live claude processes: ${report.liveProcesses.length}`));
}

async function cmdMcp(opts: { json?: boolean; connect?: boolean }): Promise<void> {
  const report = await auditMcp({ cwd: process.cwd(), homeDir: homedir(), connect: opts.connect });
  if (opts.json) return printJson(report);
  printMcp(report);
}

// ---------------------------------------------------------------------------
// combined
// ---------------------------------------------------------------------------

const DEFAULT_CTX_THRESHOLD = 200_000;

export interface CombinedData {
  encoding: string;
  findings: Finding[];
  files: FilesReport;
  hooks: HooksReport;
  session: SessionReportOutput | null;
  spawn: SpawnReport;
  daemon: DaemonReport;
  env: EnvReport;
  schedule: Awaited<ReturnType<typeof auditSchedule>>;
  skills: SkillsReport;
  subagents: SubagentsReport;
  mcp: McpReport;
}

async function gatherCombined(): Promise<CombinedData> {
  const cwd = process.cwd();
  const files = auditFiles(defaultFileSet(cwd));
  const hooks = auditHooks(cwd);
  const session = await auditSession(newestSessionLog() ?? undefined, DEFAULT_CTX_THRESHOLD).catch(() => null);
  const daemon = auditDaemon();
  const env = auditEnv();
  const spawn = await auditSpawn();
  const ttl = cacheTtlSeconds(session?.cacheCreationSplit);
  const schedule = auditSchedule(ttl);
  const skills = auditSkills();
  const subagents = auditSubagents(homedir(), cwd);
  const mcp = await auditMcp({ cwd, homeDir: homedir() });

  const findings = buildFindings({ files, hooks, session, daemon, env, skills, subagents, mcp, ctxThreshold: DEFAULT_CTX_THRESHOLD });

  return { encoding: TOKEN_ENCODING, findings, files, hooks, session, spawn, daemon, env, schedule, skills, subagents, mcp };
}

/** Strip ANSI escape sequences (chalk colour codes) from captured console output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run `fn`, capturing everything it sends through `console.log` as plain text. */
function captureOutput(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map((a) => String(a)).join(" ")));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function combinedSectionOutputs(data: CombinedData): { name: string; text: string }[] {
  const sections: { name: string; text: string }[] = [];
  sections.push({ name: "files", text: captureOutput(() => printFiles(data.files)) });
  sections.push({ name: "hooks", text: captureOutput(() => printHooks(data.hooks)) });
  if (data.session) sections.push({ name: "session", text: captureOutput(() => printSession(data.session!)) });
  sections.push({ name: "spawn", text: captureOutput(() => printSpawn(data.spawn)) });
  sections.push({ name: "daemon", text: captureOutput(() => printDaemon(data.daemon)) });
  sections.push({ name: "env", text: captureOutput(() => printEnv(data.env)) });
  sections.push({ name: "schedule", text: captureOutput(() => printSchedule(data.schedule)) });
  sections.push({ name: "skills", text: captureOutput(() => printSkills(data.skills, 15)) });
  sections.push({ name: "subagents", text: captureOutput(() => printSubagents(data.subagents)) });
  sections.push({ name: "mcp", text: captureOutput(() => printMcp(data.mcp)) });
  return sections;
}

/**
 * Replace the home directory with `~` in both its plain form and the encoded
 * form Claude Code uses for transcript directories (`/Users/name/x` →
 * `-Users-name-x`), so a recorded run carries no account name.
 */
export function redactHome(text: string, home = homedir()): string {
  const encoded = home.replace(/[\/\\]/g, "-");
  return text.split(home).join("~").split(encoded).join("~");
}

/** `--record <dir>`: write a dated, numbered markdown+JSON snapshot of the combined report, plus one summary line in `runs.md`. */
export function recordCombinedReport(dir: string, data: CombinedData): void {
  mkdirSync(dir, { recursive: true });

  // Next number is max(existing)+1, not count+1: a directory holding only
  // run4 (earlier runs recorded elsewhere) must produce run5, not run2.
  const existingNumbers = existsSync(dir)
    ? readdirSync(dir).map((f) => /-run(\d+)\.md$/.exec(f)?.[1]).filter((n): n is string => n !== undefined).map(Number)
    : [];
  const runNumber = (existingNumbers.length ? Math.max(...existingNumbers) : 0) + 1;
  const date = new Date().toISOString().slice(0, 10);
  const baseName = `${date}-run${runNumber}`;

  const findingsTable = [
    "| FINDING | SEVERITY | EVIDENCE |",
    "|---------|----------|----------|",
    ...data.findings.map((f) => `| ${f.finding} | ${f.severity} | ${f.evidence} |`),
  ].join("\n");

  const sections = combinedSectionOutputs(data);
  const sectionBlocks = sections.map((s) => `### ${s.name}\n\n\`\`\`\n${s.text}\n\`\`\`\n`).join("\n");

  const md = [
    "# pai audit tokens — recorded run",
    "",
    `date: ${date}`,
    `encoding: ${data.encoding}`,
    "",
    findingsTable,
    "",
    sectionBlocks,
  ].join("\n");

  const json = JSON.stringify(data, null, 2);

  const mdRedacted = redactHome(md);
  const jsonRedacted = redactHome(json);

  writeFileSync(join(dir, `${baseName}.md`), mdRedacted, "utf8");
  writeFileSync(join(dir, `${baseName}.json`), jsonRedacted, "utf8");

  const runsPath = join(dir, "runs.md");
  if (!existsSync(runsPath)) {
    writeFileSync(runsPath, "# Audit token-waste runs\n\n", "utf8");
  }
  const counts = { RED: 0, AMBER: 0, GREEN: 0 } as Record<Severity, number>;
  for (const f of data.findings) counts[f.severity]++;
  appendFileSync(
    runsPath,
    `- ${date} run${runNumber}: ${counts.RED} RED, ${counts.AMBER} AMBER, ${counts.GREEN} GREEN — ${baseName}.md\n`,
    "utf8"
  );
}

async function cmdCombined(opts: { json?: boolean; record?: string }): Promise<void> {
  const data = await gatherCombined();

  if (opts.json) {
    printJson(data);
  } else {
    console.log(header("pai audit tokens — combined report"));
    console.log(dim(`token encoding: ${data.encoding}`));
    const rows = data.findings.map((f) => [severityColor(f.severity, f.finding), severityColor(f.severity, f.severity), f.evidence]);
    console.log(renderTable(["FINDING", "SEVERITY", "EVIDENCE"], rows));
  }

  if (opts.record) {
    recordCombinedReport(opts.record, data);
  }
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
    .description(
      "Token-waste audit: memory files, hooks, session usage, spawn overhead, daemon, env, schedule, skill catalogue, subagents, MCP"
    )
    .option("--json", "Print JSON instead of a table")
    .option("--record <dir>", "Write a dated, numbered markdown+JSON snapshot of the combined report to <dir>")
    .action(async () => {
      await cmdCombined(jsonOpt() as { json?: boolean; record?: string });
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
    .option("--ctx-threshold <n>", "Per-turn context size above which a turn counts as 'above threshold' (default 200000)")
    .option("--history [n]", "List first-turn context of the newest n sessions in this project's transcript directory (default 20)")
    .option("--turn <n>", "Attribute API call n's context growth to the transcript lines injected since the previous call")
    .action(async (path: string | undefined, opts: { ctxThreshold?: string; history?: string | boolean; turn?: string }) => {
      await cmdSession(path, { ...jsonOpt(), ...opts });
    });

  tokensCmd
    .command("spawn")
    .description("Spawn-overhead comparison: Agent-tool subagents vs. pai workers")
    .option("-n, --n <count>", "How many of the newest logs per group to read (default 10)")
    .option("--detail", "Print one row per log (first-turn ctx, prompt tokens, overhead, model, path)")
    .action(async (opts: { n?: string; detail?: boolean }) => {
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

  tokensCmd
    .command("skills")
    .description("Token cost of the SKILL.md / command / plugin catalogue, top entries, duplicate names")
    .option("--top <n>", "How many top-by-tokens entries to show (default 15)")
    .action((opts: { top?: string }) => {
      cmdSkills({ ...jsonOpt(), ...opts });
    });

  tokensCmd
    .command("subagents")
    .description("Token cost of Claude Code subagent definitions (~/.claude/agents, <cwd>/.claude/agents) and their model pinning")
    .action(() => cmdSubagents(jsonOpt()));

  tokensCmd
    .command("mcp")
    .description("MCP servers: configured vs. pinned vs. loaded-live vs. used in the last 30 days")
    .option("--connect", "Actually connect to every stdio MCP server to count exposed tools (side-effecting; never on by default)")
    .action(async (opts: { connect?: boolean }) => {
      await cmdMcp({ ...jsonOpt(), ...opts });
    });

  tokensCmd
    .command("ladder")
    .description("LIVE: first-turn context at increasing headless-worker configuration (spawns real claude -p calls)")
    .option("--live", "Actually spawn claude -p (billed API traffic); refuses without this flag")
    .option("--model <model>", "Model to probe with (default haiku)")
    .option("--mcp-config <path>", "MCP config for the L2 rung (default: newest *.mcp.json in the workers log dir)")
    .action(async (opts: { live?: boolean; model?: string; mcpConfig?: string }) => {
      await cmdLadder({ ...jsonOpt(), ...opts });
    });
}
