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
import type { CompactionEvent, ModelSwitch, FallbackEvent } from "./session-usage.js";

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
    promptExposure: 0,
    compactions,
    firstTurnAt: null,
    lastModel: null,
    modelSwitches: [],
    fallbacks: [],
    lastTurnAtMs: null,
    idleGapsOver60min: 0,
    keepaliveBeats: null,
    totalTokens: 1,
    percentages: {},
    firstTurn: null,
    window: 200_000,
    windowSource: "default",
    trigger: 200_000,
    autocompactPct: 80,
    triggerSource: "configured",
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

function sessionWithInputSent(inputSent: number, prompts: number, promptExposure: number): SessionReportOutput {
  return {
    ...sessionWith([]),
    userPrompts: prompts,
    promptExposure,
    totals: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: inputSent, output_tokens: 0 },
  };
}

describe("buildFindings — per-prompt hook cost", () => {
  it("is GREEN when cumulative cost is under 5% of input tokens sent", () => {
    const session = sessionWithInputSent(100_000, 10, 10);
    const finding = perPromptFinding(hooksWith(400), session);
    expect(finding!.severity).toBe("GREEN");
    expect(finding!.evidence).toBe(
      "400 tokens/prompt x 10 prompts, carried over 2 turns = 4000 tokens (4.0% of 100000 input tokens sent)"
    );
  });

  it("is AMBER between 5% and 15% of input tokens sent", () => {
    const session = sessionWithInputSent(100_000, 10, 10);
    const finding = perPromptFinding(hooksWith(1000), session);
    expect(finding!.severity).toBe("AMBER");
  });

  it("is RED above 15% of input tokens sent", () => {
    const session = sessionWithInputSent(100_000, 10, 10);
    const finding = perPromptFinding(hooksWith(2000), session);
    expect(finding!.severity).toBe("RED");
  });

  it("is omitted when the session report is missing", () => {
    const finding = perPromptFinding(hooksWith(400), null);
    expect(finding).toBeUndefined();
  });

  it("is omitted when the hooks report has no UserPromptSubmit reading", () => {
    const session = sessionWithInputSent(100_000, 10, 10);
    const finding = perPromptFinding(hooksWith(undefined), session);
    expect(finding).toBeUndefined();
  });

  it("reads the same share in a short and a long session with the same prompt density", () => {
    // Session A: 4 turns, 9 prompt-exposure units, 34_075 input tokens sent.
    // Session B: same density scaled x2 (8 turns, 18 exposure, 68_150 input tokens).
    const sessionA = { ...sessionWithInputSent(34_075, 3, 9), turns: 4 };
    const sessionB = { ...sessionWithInputSent(68_150, 6, 18), turns: 8 };
    const findingA = perPromptFinding(hooksWith(596), sessionA)!;
    const findingB = perPromptFinding(hooksWith(596), sessionB)!;
    expect(findingA.severity).toBe(findingB.severity);
    const pctA = findingA.evidence.match(/\(([\d.]+)% of/)![1];
    const pctB = findingB.evidence.match(/\(([\d.]+)% of/)![1];
    expect(pctA).toBe(pctB);
    expect(pctA).toBe("15.7");
  });
});

function contextGrowthFinding(overrides: Partial<SessionReportOutput>, ctxThreshold: number) {
  const session: SessionReportOutput = { ...sessionWith([]), ...overrides };
  const findings = buildFindings({ files, hooks, session, daemon, env, skills, subagents, mcp, ctxThreshold });
  return findings.find((f) => f.finding === "context growth")!;
}

describe("buildFindings — context growth", () => {
  it("is GREEN on a 1M-window session whose avg/max sit well under its own trigger", () => {
    // trigger 784,000 = 80% of a 1,000,000 window (this project's own
    // measured/configured derivation) — avg 300k is far below 0.5x that,
    // and max 500k is far below 0.75x that. The exact defect this replaces:
    // rating this session against a flat 200k would have called it RED.
    const finding = contextGrowthFinding(
      { avgContext: 300_000, maxContext: 500_000, turnsAboveThreshold: 0, window: 1_000_000, autocompactPct: 80 },
      784_000
    );
    expect(finding.severity).toBe("GREEN");
    expect(finding.evidence).toContain("trigger 784,000");
    expect(finding.evidence).toContain("window 1,000,000");
  });

  it("is RED on a 200k-window session whose avg exceeds half its own trigger", () => {
    // trigger 144,000 = 80% of a 200,000 window — avg 90k is above 0.5x
    // that (72k).
    const finding = contextGrowthFinding(
      { avgContext: 90_000, maxContext: 130_000, turnsAboveThreshold: 0, window: 200_000, autocompactPct: 80 },
      144_000
    );
    expect(finding.severity).toBe("RED");
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

function modelSwitchFinding(
  modelSwitches: ModelSwitch[],
  fallbacks: FallbackEvent[] = []
) {
  const session: SessionReportOutput = { ...sessionWith([]), modelSwitches, fallbacks };
  const findings = buildFindings({ files, hooks, session, daemon, env, skills, subagents, mcp, ctxThreshold: 200_000 });
  return findings.find((f) => f.finding === "mid-session model switches")!;
}

describe("buildFindings — mid-session model switches", () => {
  it("is GREEN with no switches", () => {
    const finding = modelSwitchFinding([]);
    expect(finding.severity).toBe("GREEN");
    expect(finding.evidence).toContain("0 switches in 2 turns");
  });

  it("is AMBER with one switch under the rebuild limit, and notes a fallback", () => {
    const finding = modelSwitchFinding(
      [{ turnIndex: 126, from: "claude-fable-5-1", to: "claude-opus-5", cacheRead: 82795, cacheCreation: 0 }],
      [{ turnIndex: 126, from: "claude-fable-5-1", to: "claude-opus-5", category: "cyber", scope: "session" }]
    );
    expect(finding.severity).toBe("AMBER");
    expect(finding.evidence).toContain("fable-5-1->opus-5 at turn 126 (cache_read 82795, cache_creation 0)");
    expect(finding.evidence).toContain("1 safeguard fallback(s): cyber");
  });

  it("is RED when a switch's cache_creation exceeds the rebuild limit", () => {
    const finding = modelSwitchFinding([
      { turnIndex: 144, from: "claude-opus-5", to: "claude-fable-5-1", cacheRead: 98783, cacheCreation: 90000 },
    ]);
    expect(finding.severity).toBe("RED");
  });
});
