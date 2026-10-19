import { describe, expect, it } from "vitest";
import { mergeHooks } from "../../../lib/settings-manager.js";
import { slimSettings } from "../../../../workers/slim-profile.js";
import { SETTINGS_HOOKS } from "./10-settings.js";

const guard = SETTINGS_HOOKS.filter((h) => h.command.includes("worker-guard.mjs"));
const OLD = "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*";
const matchers = (s: Record<string, unknown>) =>
  ((s.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }).PreToolUse)
    .filter((r) => r.hooks.some((h) => h.command.includes("worker-guard")))
    .map((r) => r.matcher);

describe("worker-guard matcher", () => {
  it("setup registers it for every tool", () => {
    expect(guard).toHaveLength(1);
    expect(guard[0].matcher).toBe("*");
  });

  it("generated worker settings carry the * matcher", () => {
    const user: Record<string, unknown> = {};
    mergeHooks(user, SETTINGS_HOOKS, []);
    expect(matchers(slimSettings(user))).toEqual(["*"]);
  });

  it("migrates an old matcher once and is idempotent", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: OLD, hooks: [{ type: "command", command: "/h/Hooks/worker-guard.mjs" }, { type: "command", command: "/h/Hooks/other.mjs" }] },
        ],
      },
    };
    expect(mergeHooks(settings, guard, [])).toBe(true);
    const rules = (settings.hooks as { PreToolUse: Array<{ matcher?: string; hooks: unknown[] }> }).PreToolUse;
    expect(matchers(settings)).toEqual(["*"]);
    expect(rules.find((r) => r.matcher === OLD)?.hooks).toHaveLength(1);
    const snapshot = JSON.stringify(settings);
    expect(mergeHooks(settings, guard, [])).toBe(false);
    expect(JSON.stringify(settings)).toBe(snapshot);
  });
});
