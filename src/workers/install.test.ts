import { describe, it, expect } from "vitest";
import { patchAgentHookSettings, AGENT_MATCHER, NEW_AGENT_HOOK, shim } from "./install.js";

describe("shell shims", () => {
  const pai = "/usr/local/bin/pai";

  it("glm is a thin alias of `pai launch --provider glm`", () => {
    expect(shim("glm", pai)).toContain(`exec ${pai} launch --provider glm "$@"`);
  });

  it("kimi is a thin alias of `pai launch --provider kimi`", () => {
    expect(shim("kimi", pai)).toContain(`exec ${pai} launch --provider kimi "$@"`);
  });

  it("glm-run still runs a headless/worker run, not pai launch", () => {
    const body = shim("glm-run", pai);
    expect(body).toContain(`exec ${pai} worker run "$@"`);
    expect(body).not.toContain("launch");
  });

  it("glm-ps, glm-log and worker-say keep their existing behaviour", () => {
    expect(shim("glm-ps", pai)).toContain(`exec ${pai} worker ps`);
    expect(shim("glm-log", pai)).toContain(`exec ${pai} worker log "$@"`);
    expect(shim("worker-say", pai)).toContain(`exec ${pai} worker say "$@"`);
  });
});

/** The rule as a previous PAI version wrote it: correct command, narrow matcher. */
function settingsWithNarrowMatcher(): Record<string, unknown> {
  return {
    env: { PAI_DIR: "/home/somebody/.claude" },
    hooks: {
      PreToolUse: [
        { matcher: "Agent", hooks: [{ type: "command", command: NEW_AGENT_HOOK, timeout: 5 }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "${PAI_DIR}/Hooks/other.mjs" }] },
      ],
    },
  };
}

function rules(settings: Record<string, unknown>): Array<Record<string, unknown>> {
  return (settings["hooks"] as Record<string, unknown>)["PreToolUse"] as Array<
    Record<string, unknown>
  >;
}

function agentRule(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  return rules(settings).find((r) =>
    (r["hooks"] as Array<Record<string, unknown>>).some((h) => h["command"] === NEW_AGENT_HOOK)
  );
}

describe("subagent hook registration", () => {
  it("covers both subagent tool names", () => {
    expect(AGENT_MATCHER).toBe("Agent|Task");
  });

  it("widens a narrow legacy matcher in place", () => {
    const s = settingsWithNarrowMatcher();
    const lines: string[] = [];
    expect(patchAgentHookSettings(s, lines)).toBe(true);
    expect(agentRule(s)?.["matcher"]).toBe(AGENT_MATCHER);
    expect(lines.join("\n")).toContain("widened");
    // untouched neighbours stay untouched
    expect(rules(s)).toHaveLength(2);
    expect(rules(s)[1]?.["matcher"]).toBe("Bash");
    // the timeout the user set survives
    expect((agentRule(s)?.["hooks"] as Array<Record<string, unknown>>)[0]?.["timeout"]).toBe(5);
  });

  it("is idempotent once current", () => {
    const s = settingsWithNarrowMatcher();
    patchAgentHookSettings(s, []);
    const lines: string[] = [];
    expect(patchAgentHookSettings(s, lines)).toBe(false);
    expect(lines.join("\n")).toContain("already current");
  });

  it("adds the rule when settings have no hooks at all", () => {
    const s: Record<string, unknown> = {};
    expect(patchAgentHookSettings(s, [])).toBe(true);
    expect(agentRule(s)?.["matcher"]).toBe(AGENT_MATCHER);
  });

  it("migrates the pre-worker glm hook and widens its matcher", () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Agent",
            hooks: [{ type: "command", command: "${PAI_DIR}/Hooks/route-agents-to-glm.sh" }],
          },
        ],
      },
    };
    expect(patchAgentHookSettings(s, [])).toBe(true);
    const r = agentRule(s);
    expect(r?.["matcher"]).toBe(AGENT_MATCHER);
    expect((r?.["hooks"] as Array<Record<string, unknown>>)[0]?.["command"]).toBe(NEW_AGENT_HOOK);
    expect(rules(s)).toHaveLength(1);
  });

  it("leaves someone else's rule on the same matcher alone and adds its own", () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: "Agent", hooks: [{ type: "command", command: "/opt/other/guard.sh" }] },
        ],
      },
    };
    expect(patchAgentHookSettings(s, [])).toBe(true);
    expect(rules(s)).toHaveLength(2);
    expect(rules(s)[0]?.["matcher"]).toBe("Agent");
    expect((rules(s)[0]?.["hooks"] as Array<Record<string, unknown>>)[0]?.["command"]).toBe(
      "/opt/other/guard.sh"
    );
    expect(agentRule(s)?.["matcher"]).toBe(AGENT_MATCHER);
  });
});
