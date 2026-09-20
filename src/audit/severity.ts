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
import { SINGLE_FILE_LIMIT, TOTAL_LIMIT } from "./files.js";

export const HOOK_TOKEN_LIMIT = 1000;
export const FIRST_TURN_CONTEXT_LIMIT = 30_000;
export const DAEMON_FAILURE_RATE_LIMIT = 0.05;

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

  return sortFindings(findings);
}
