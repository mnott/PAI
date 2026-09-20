/**
 * The one behaviour that matters here: "compaction trigger" severity must
 * reflect whether an auto compaction fired well above the configured
 * ctxThreshold (override not honoured), regardless of manual compactions.
 */

import { describe, it, expect } from "vitest";
import { buildFindings } from "./severity.js";
import type { FilesReport } from "./files.js";
import type { HooksReport } from "./hooks.js";
import type { SessionReportOutput } from "./session.js";
import type { DaemonReport } from "./daemon.js";
import type { EnvReport } from "./env.js";
import type { SkillsReport } from "./skills.js";
import type { SubagentsReport } from "./subagents.js";
import type { McpReport } from "./mcp.js";
import type { CompactionEvent } from "./session-usage.js";

const files: FilesReport = { encoding: "cl100k_base", readings: [], total: 0 };
const hooks: HooksReport = {
  encoding: "cl100k_base",
  settingsFiles: [],
  readings: [],
  totalsByEvent: {},
  preToolUseHooks: [],
  preToolUseRewritesBash: false,
};
const daemon: DaemonReport = {
  logPath: "",
  windowStart: null,
  spawnsByModel: {},
  kgParseFailures: 0,
  kgExtractionLines: 0,
  kgParseFailureRate: 0,
  jobCounts: {},
};
const env: EnvReport = { processes: [], mcpServerCount: 0, settingsModel: null, settingsEffortLevel: null };
const skills: SkillsReport = {
  encoding: "cl100k_base",
  entries: [],
  total: 0,
  totalsBySource: {} as SkillsReport["totalsBySource"],
  countsBySource: {} as SkillsReport["countsBySource"],
  enabledTotal: 0,
  enabledTotalsBySource: {} as SkillsReport["enabledTotalsBySource"],
  duplicates: [],
};
const subagents: SubagentsReport = { encoding: "cl100k_base", entries: [] };
const mcp: McpReport = { servers: [], liveProcesses: [] };

function sessionWith(compactions: CompactionEvent[]): SessionReportOutput {
  return {
    path: "fixture.jsonl",
    sizeBytes: 0,
    turns: 2,
    totals: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 },
    models: {},
    firstTurnContext: 0,
    lastTurnContext: 0,
    cacheCreationSplit: { ephemeral5m: 0, ephemeral1h: 0 },
    avgContext: 0,
    maxContext: 0,
    turnsAboveThreshold: 0,
    cacheRebuildTurns: 0,
    userPrompts: 0,
    compactions,
    totalTokens: 1,
    percentages: {},
  };
}

function compactionFinding(session: SessionReportOutput, ctxThreshold: number) {
  const findings = buildFindings({ files, hooks, session, daemon, env, skills, subagents, mcp, ctxThreshold });
  return findings.find((f) => f.finding === "compaction trigger")!;
}

function hooksWith(userPromptSubmitTokens: number | undefined): HooksReport {
  return {
    ...hooks,
    totalsByEvent: userPromptSubmitTokens === undefined ? {} : { UserPromptSubmit: userPromptSubmitTokens },
  };
}

function perPromptFinding(hooksReport: HooksReport, session: SessionReportOutput | null, ctxThreshold = 200_000) {
  const findings = buildFindings({ files, hooks: hooksReport, session, daemon, env, skills, subagents, mcp, ctxThreshold });
  return findings.find((f) => f.finding === "per-prompt hook cost");
}

describe("buildFindings — per-prompt hook cost", () => {
  it("is GREEN when cumulative cost is under 5% of last-turn context", () => {
    const session = { ...sessionWith([]), userPrompts: 10, lastTurnContext: 100_000 };
    const finding = perPromptFinding(hooksWith(400), session);
    expect(finding!.severity).toBe("GREEN");
    expect(finding!.evidence).toBe("400 tokens/prompt x 10 prompts = 4000 tokens (4.0% of last-turn context 100000)");
  });

  it("is AMBER between 5% and 15% of last-turn context", () => {
    const session = { ...sessionWith([]), userPrompts: 10, lastTurnContext: 100_000 };
    const finding = perPromptFinding(hooksWith(1000), session);
    expect(finding!.severity).toBe("AMBER");
  });

  it("is RED above 15% of last-turn context", () => {
    const session = { ...sessionWith([]), userPrompts: 10, lastTurnContext: 100_000 };
    const finding = perPromptFinding(hooksWith(2000), session);
    expect(finding!.severity).toBe("RED");
  });

  it("is omitted when the session report is missing", () => {
    const finding = perPromptFinding(hooksWith(400), null);
    expect(finding).toBeUndefined();
  });

  it("is omitted when the hooks report has no UserPromptSubmit reading", () => {
    const session = { ...sessionWith([]), userPrompts: 10, lastTurnContext: 100_000 };
    const finding = perPromptFinding(hooksWith(undefined), session);
    expect(finding).toBeUndefined();
  });
});

describe("buildFindings — compaction trigger", () => {
  it("is GREEN with no compactions", () => {
    const finding = compactionFinding(sessionWith([]), 200_000);
    expect(finding.severity).toBe("GREEN");
    expect(finding.evidence).toContain("0 compactions in 2 turns");
  });

  it("is RED when an auto compaction fires above 1.25x the configured threshold", () => {
    const finding = compactionFinding(
      sessionWith([
        { trigger: "auto", preTokens: 784_000, turnIndex: 1 },
        { trigger: "manual", preTokens: 150_000, turnIndex: 2 },
      ]),
      200_000
    );
    expect(finding.severity).toBe("RED");
    expect(finding.evidence).toContain("784000");
    expect(finding.evidence).toContain("200000");
  });

  it("is GREEN when the auto compaction's preTokens is within 25% of the configured threshold", () => {
    const finding = compactionFinding(sessionWith([{ trigger: "auto", preTokens: 190_000, turnIndex: 1 }]), 200_000);
    expect(finding.severity).toBe("GREEN");
  });

  it("manual compactions alone never turn the finding RED", () => {
    const finding = compactionFinding(sessionWith([{ trigger: "manual", preTokens: 900_000, turnIndex: 1 }]), 200_000);
    expect(finding.severity).toBe("GREEN");
  });
});
