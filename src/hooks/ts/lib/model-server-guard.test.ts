import { describe, expect, it } from "vitest";
import { modelServerReason } from "./model-server-guard.js";
import { isLocalPrompt, localModelHint } from "./local-model-hint.js";

const ANSWER = "local: flashnext-iq3 (qwen3.8-flash-next-iq3_s) running — use `pai worker run --local`";
const check = (cmd: string, env: Record<string, string> = {}) => modelServerReason(cmd, env, ANSWER);

describe("modelServerReason", () => {
  it.each([
    "vllm-mlx serve model --port 8011",
    "nohup python3 -m mlx_lm.server --model x &",
    "llama-server -m m.gguf",
    "ollama serve",
    "strata serve",
    "sh serve-8011.sh",
    "bash ~/models/run-local30.sh",
    "./serve-8035.sh",
    "FOO=1 nohup sh run-strata.sh > /tmp/l 2>&1 &",
    "sh -c 'vllm-mlx serve x'",
    "launchctl load ~/Library/LaunchAgents/com.example.mlx-server.plist",
    "launchctl kickstart -k gui/501/com.example.local30",
  ])("denies the launcher %s", (cmd) => {
    const r = check(cmd);
    expect(r).toContain("started by the operator, not by sessions");
    expect(r).toContain(`Running now: ${ANSWER}`);
    expect(r).toContain("pai worker run --local");
  });

  it.each([
    "curl -s 127.0.0.1:8010; curl -s 127.0.0.1:8011; curl -s 127.0.0.1:8020",
    "for p in 8010 8011 8020; do curl -s http://127.0.0.1:$p/v1/models; done",
    "for p in $(seq 8000 8099); do curl -s -m1 localhost:$p; done",
  ])("denies the port scan %s", (cmd) => {
    expect(check(cmd)).toContain("started by the operator");
  });

  it.each([
    "curl -s http://127.0.0.1:8035/v1/models",
    "grep -n vllm-mlx notes.md",
    "echo ollama serve",
    "launchctl list",
    "launchctl load ~/Library/LaunchAgents/com.example.backup.plist",
    "pai worker run --local -p x",
    "curl -s 127.0.0.1:3000; curl -s 127.0.0.1:3000",
  ])("allows %s", (cmd) => {
    expect(check(cmd)).toBeNull();
  });

  it("the operator override env disables the guard", () => {
    expect(check("sh serve-8011.sh", { PAI_ALLOW_MODEL_SERVER: "1" })).toBeNull();
  });
});

describe("local model hint", () => {
  it("fires only for local-ish prompts", () => {
    for (const p of ["use your local worker", "run it locally", "with the local model please", "Local"]) {
      expect(isLocalPrompt(p)).toBe(true);
    }
    for (const p of ["fix the bug", "deploy to production", "localization strings"]) {
      expect(isLocalPrompt(p)).toBe(false);
      expect(localModelHint(p, ANSWER)).toBeNull();
    }
  });

  it("carries the answer and the no-probe rule", () => {
    const h = localModelHint("use your local worker", ANSWER)!;
    expect(h).toContain(ANSWER);
    expect(h).toContain("Do not probe ports or start model servers; `--local` picks the running model.");
  });
});
