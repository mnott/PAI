import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { slimProfileArgs, slimSettings } from "./slim-profile.js";

const USER = {
  env: { A: "1" },
  permissions: { allow: ["Bash"] },
  enabledPlugins: { x: true },
  outputStyle: "Concise",
  hooks: {
    SessionStart: [{ hooks: [{ command: "${PAI_DIR}/Hooks/load-core-context.mjs" }] }],
    UserPromptSubmit: [{ hooks: [{ command: "${PAI_DIR}/Hooks/whisper-rules.mjs" }] }],
    PreToolUse: [
      { hooks: [{ command: "${PAI_DIR}/Hooks/security-validator.mjs" }, { command: "node x/aibroker-progress.mjs" }] },
      { hooks: [{ command: "node ${PAI_DIR}/Hooks/ab-levers.mjs pre" }] },
    ],
  },
};

describe("slim worker profile", () => {
  it("keeps env, permissions and guard hooks only", () => {
    const s = slimSettings(USER) as any;
    expect(s.env).toEqual({ A: "1" });
    expect(s.permissions).toEqual({ allow: ["Bash"] });
    expect(s.enabledPlugins).toBeUndefined();
    expect(s.outputStyle).toBeUndefined();
    expect(Object.keys(s.hooks)).toEqual(["PreToolUse"]);
    expect(s.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(s.hooks.PreToolUse[1].hooks[0].command).toContain("ab-levers");
  });

  it("writes the file and drops the user source; opt-outs yield no args", () => {
    const dir = mkdtempSync(join(tmpdir(), "slim-"));
    const user = join(dir, "settings.json");
    writeFileSync(user, JSON.stringify(USER));
    const args = slimProfileArgs(dir, "w1", [], {}, user);
    expect(args.slice(0, 2)).toEqual(["--setting-sources", "project,local"]);
    expect(JSON.parse(readFileSync(args[3], "utf8")).hooks.PreToolUse).toBeDefined();
    expect(slimProfileArgs(dir, "w1", [], { PAI_WORKER_FULL_PROFILE: "1" }, user)).toEqual([]);
    expect(slimProfileArgs(dir, "w1", ["--settings", "x"], {}, user)).toEqual([]);
    expect(slimProfileArgs(dir, "w1", [], {}, join(dir, "missing.json"))).toEqual([]);
  });
});
