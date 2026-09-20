/**
 * severity.ts — the combined report's RED/AMBER/GREEN thresholds, kept in
 * one place so tightening or loosening a rule never means hunting through
 * each section's module.
 */

import type { FilesReport } from "./files.js";
import type { HooksReport } from "./hooks.js";
import type { SessionReportOutput } from "./session.js";
import type { DaemonReport } from "./daemon.js";
import type { EnvReport } from "./env.js";
import type { SkillsReport } from "./skills.js";
import type { SubagentsReport } from "./subagents.js";
import type { McpReport } from "./mcp.js";
import { SINGLE_FILE_LIMIT, TOTAL_LIMIT } from "./files.js";
import { SKILL_CATALOGUE_AMBER, SKILL_CATALOGUE_RED } from "./skills.js";

export const HOOK_TOKEN_LIMIT = 1000;
export const PER_PROMPT_HOOK_COST_AMBER = 0.05;
export const PER_PROMPT_HOOK_COST_RED = 0.15;
export const FIRST_TURN_CONTEXT_LIMIT = 30_000;
export const DAEMON_FAILURE_RATE_LIMIT = 0.05;
export const CONTEXT_GROWTH_AVG_RED = 100_000;
export const CONTEXT_GROWTH_MAX_AMBER = 150_000;
export const MODEL_SWITCH_REBUILD_LIMIT = 20_000;

export type Severity = "RED" | "AMBER" | "GREEN";

export interface Finding {
  finding: string;
  severity: Severity;
  evidence: string;
}

const SEVERITY_RANK: Record<Severity, number> = { RED: 0, AMBER: 1, GREEN: 2 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function buildFindings(input: {
  files: FilesReport;
  hooks: HooksReport;
  session: SessionReportOutput | null;
  daemon: DaemonReport;
  env: EnvReport;
  skills: SkillsReport;
  subagents: SubagentsReport;
  mcp: McpReport;
  ctxThreshold: number;
}): Finding[] {
  const findings: Finding[] = [];

  for (const proc of input.env.processes) {
    if (proc.baseUrl) {
      findings.push({
        finding: `claude process ${proc.pid} routed through a proxy`,
        severity: "RED",
        evidence: `ANTHROPIC_BASE_URL=${proc.baseUrl}`,
      });
    }
  }

  const bigFiles = input.files.readings.filter((r) => r.tokens > SINGLE_FILE_LIMIT);
  for (const f of bigFiles) {
    findings.push({
      finding: `memory file over ${SINGLE_FILE_LIMIT} tokens`,
      severity: "AMBER",
      evidence: `${f.path}: ${f.tokens} tokens`,
    });
  }
  findings.push({
    finding: "total memory-file tokens",
    severity: input.files.total > TOTAL_LIMIT ? "AMBER" : "GREEN",
    evidence: `${input.files.total} tokens across ${input.files.readings.length} files`,
  });

  const bigHooks = input.hooks.readings.filter((r) => r.tokens > HOOK_TOKEN_LIMIT);
  for (const h of bigHooks) {
    findings.push({
      finding: `${h.event} hook over ${HOOK_TOKEN_LIMIT} tokens`,
      severity: "AMBER",
      evidence: `${h.command}: ${h.tokens} tokens`,
    });
  }
  if (bigHooks.length === 0 && input.hooks.readings.length > 0) {
    findings.push({
      finding: "SessionStart / UserPromptSubmit hook output",
      severity: "GREEN",
      evidence: `${input.hooks.readings.length} hooks, all under ${HOOK_TOKEN_LIMIT} tokens`,
    });
  }

  if (input.session) {
    const first = input.session.firstTurnContext ?? 0;
    findings.push({
      finding: "first-turn context size",
      severity: first > FIRST_TURN_CONTEXT_LIMIT ? "AMBER" : "GREEN",
      evidence: `${first} tokens (${input.session.path})`,
    });
  }

  const rate = input.daemon.kgParseFailureRate;
  findings.push({
    finding: "daemon KG-extraction JSON parse failure rate",
    severity: rate > DAEMON_FAILURE_RATE_LIMIT ? "AMBER" : "GREEN",
    evidence: `${(rate * 100).toFixed(1)}% (${input.daemon.kgParseFailures} failures over session-summary spawns)`,
  });

  if (!input.env.processes.some((p) => p.baseUrl)) {
    findings.push({
      finding: "claude process base URL",
      severity: "GREEN",
      evidence: `${input.env.processes.length} claude process(es), none proxied`,
    });
  }

  const deferralOff = input.env.processes.filter((p) => {
    const mcpCount = p.mcpServers === "default" ? input.env.mcpServerCount : p.mcpServers;
    return p.deferral === "OFF" && mcpCount > 0;
  });
  findings.push({
    finding: "tool deferral on live processes",
    severity: deferralOff.length > 0 ? "RED" : "GREEN",
    evidence:
      deferralOff.length > 0
        ? deferralOff
            .map((p) => `pid ${p.pid}: ${p.mcpServers === "default" ? input.env.mcpServerCount : p.mcpServers} mcp servers, tools=${p.toolsArg}`)
            .join("; ")
        : `${input.env.processes.length} claude process(es) checked, none with an explicit --tools list missing ToolSearch and MCP servers registered`,
  });

  const skillTokens = input.skills.enabledTotal;
  findings.push({
    finding: "skill catalogue tokens",
    severity: skillTokens > SKILL_CATALOGUE_RED ? "RED" : skillTokens > SKILL_CATALOGUE_AMBER ? "AMBER" : "GREEN",
    evidence: `${skillTokens} tokens loaded (${input.skills.total} on disk) across ${input.skills.entries.length} entries` +
      (input.skills.duplicates.length ? `, ${input.skills.duplicates.length} case-insensitive duplicate name(s)` : ""),
  });

  const inheriting = input.subagents.entries.filter((e) => e.model === "inherits");
  if (input.subagents.entries.length === 0) {
    findings.push({ finding: "subagent model pinning", severity: "GREEN", evidence: "no agent files" });
  } else {
    findings.push({
      finding: "subagent model pinning",
      severity: inheriting.length > 0 ? "AMBER" : "GREEN",
      evidence: `${inheriting.length} of ${input.subagents.entries.length} inherit`,
    });
  }

  const configuredCount = input.mcp.servers.filter((s) => s.configuredIn.length > 0).length;
  const plainLaunch = input.mcp.liveProcesses.find((p) => p.mcpConfigPath === null);
  if (!plainLaunch) {
    findings.push({
      finding: "MCP servers loaded vs. used",
      severity: "GREEN",
      evidence: `${configuredCount} configured, no plain launch found`,
    });
  } else {
    const zeroCallServers = input.mcp.servers.filter((s) => s.configuredIn.length > 0 && s.calls30d === 0);
    findings.push({
      finding: "MCP servers loaded vs. used",
      severity: zeroCallServers.length > 0 ? "AMBER" : "GREEN",
      evidence: `${configuredCount} configured, ${zeroCallServers.length} loaded by pid ${plainLaunch.pid}`,
    });
  }

  if (input.session) {
    const avg = input.session.avgContext ?? 0;
    const max = input.session.maxContext ?? 0;
    const severity: Severity =
      avg > CONTEXT_GROWTH_AVG_RED || input.session.turnsAboveThreshold > 0
        ? "RED"
        : max > CONTEXT_GROWTH_MAX_AMBER
          ? "AMBER"
          : "GREEN";
    findings.push({
      finding: "context growth",
      severity,
      evidence: `avg ${avg}, max ${max}, ${input.session.turnsAboveThreshold} turns > ${input.ctxThreshold}, ${input.session.turns} turns`,
    });

    const perPromptHookCost = input.hooks.totalsByEvent.UserPromptSubmit;
    const inputSent =
      input.session.totals.cache_read_input_tokens +
      input.session.totals.cache_creation_input_tokens +
      input.session.totals.input_tokens;
    if (perPromptHookCost !== undefined && inputSent > 0) {
      const prompts = input.session.userPrompts;
      const turns = input.session.turns;
      const total = perPromptHookCost * input.session.promptExposure;
      const pct = (total / inputSent) * 100;
      findings.push({
        finding: "per-prompt hook cost",
        severity:
          pct > PER_PROMPT_HOOK_COST_RED * 100
            ? "RED"
            : pct > PER_PROMPT_HOOK_COST_AMBER * 100
              ? "AMBER"
              : "GREEN",
        evidence: `${perPromptHookCost} tokens/prompt x ${prompts} prompts, carried over ${turns} turns = ${total} tokens (${pct.toFixed(1)}% of ${inputSent} input tokens sent)`,
      });
    }

    const compactions = input.session.compactions;
    const autoCompactions = compactions.filter((c) => c.trigger === "auto");
    const overshoots = autoCompactions.filter((c) => c.preTokens > 1.25 * input.ctxThreshold);
    findings.push({
      finding: "compaction trigger",
      severity: overshoots.length > 0 ? "RED" : "GREEN",
      evidence:
        overshoots.length > 0
          ? `override not honoured: ${overshoots.map((c) => `preTokens=${c.preTokens}`).join(", ")} vs configured ${input.ctxThreshold}`
          : compactions.length === 0
            ? `0 compactions in ${input.session.turns} turns`
            : `${compactions.length} compaction(s), all within 25% of configured ${input.ctxThreshold}`,
    });

    const switches = input.session.modelSwitches;
    const fallbacks = input.session.fallbacks;
    const rebuilds = switches.filter((s) => s.cacheCreation > MODEL_SWITCH_REBUILD_LIMIT);
    const short = (model: string) => model.replace(/^claude-/, "");
    let switchEvidence: string;
    if (switches.length === 0) {
      switchEvidence = `0 switches in ${input.session.turns} turns, models ${JSON.stringify(input.session.models)}`;
    } else {
      const list = switches
        .map(
          (s) =>
            `${short(s.from)}->${short(s.to)} at turn ${s.turnIndex} (cache_read ${s.cacheRead}, cache_creation ${s.cacheCreation})`
        )
        .join("; ");
      switchEvidence = `${switches.length} switch(es): ${list}`;
      if (fallbacks.length > 0) {
        switchEvidence += `; ${fallbacks.length} safeguard fallback(s): ${fallbacks.map((f) => f.category).join(",")}`;
      }
    }
    findings.push({
      finding: "mid-session model switches",
      severity: switches.length === 0 ? "GREEN" : rebuilds.length > 0 ? "RED" : "AMBER",
      evidence: switchEvidence,
    });
  }

  return sortFindings(findings);
}
