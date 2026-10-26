/**
 * Tests for the opencode engine — argument building, env building (the
 * per-worker OPENCODE_CONFIG, XDG_DATA_HOME, no real key in the env) and the
 * event folding from the recorded `opencode run --format json` JSONL fixtures
 * into the same status fields a Claude run carries. The opencode CLI itself
 * is never invoked.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpencodeArgs,
  buildOpencodeEnv,
  emptyOpencodeResult,
  foldOpencodeLine,
  opencodeConfigJson,
  opencodeDroppedFlags,
  parseOpencodeLine,
} from "./opencode.js";
import type { WorkerProvider } from "./config.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("buildOpencodeArgs", () => {
  it("the fixed flags, model namespaced pai/, prompt after --", () => {
    expect(buildOpencodeArgs("fix the bug", "glm-5.3")).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "pai/glm-5.3",
      "--auto",
      "--pure",
      "--thinking",
      "--",
      "fix the bug",
    ]);
  });
  it("--session rides before -- when a session id is given", () => {
    const argv = buildOpencodeArgs("continue", "m", "ses_abc123");
    expect(argv).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "pai/m",
      "--auto",
      "--pure",
      "--thinking",
      "--session",
      "ses_abc123",
      "--",
      "continue",
    ]);
  });
  it("no model → no --model flag; empty session → no --session flag", () => {
    expect(buildOpencodeArgs("t", undefined)).not.toContain("--model");
    expect(buildOpencodeArgs("t", "m", null)).not.toContain("--session");
  });
});

describe("opencodeDroppedFlags", () => {
  it("drops tool and MCP flags with their values", () => {
    expect(
      opencodeDroppedFlags(["-p", "task", "--allowedTools", "Read,Edit", "--mcp-config", "/tmp/x.json"])
    ).toEqual(["--allowedTools", "--mcp-config"]);
  });
  it("drops the =-forms", () => {
    expect(opencodeDroppedFlags(["--allowedTools=Read", "--verbose", "-p", "t"])).toEqual(["--allowedTools"]);
  });
});

describe("buildOpencodeEnv", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const provider = (over: Partial<WorkerProvider> = {}): WorkerProvider => ({
    enabled: true,
    protocol: "anthropic",
    baseUrl: "https://api.example.invalid",
    keyFile: null,
    models: { default: "glm-5.3" },
    env: {},
    ...over,
  } as WorkerProvider);

  it("OPENCODE_CONFIG: baseURL carries the /p/<provider>/v1 prefix, model declared, apiKey placeholder", () => {
    root = mkdtempSync(join(tmpdir(), "oc-env-"));
    const env = buildOpencodeEnv(provider(), "glm", "glm-5.3", root, "http://127.0.0.1:8790");
    expect(env.OPENCODE_CONFIG).toBe(join(root, "opencode-config.json"));
    const cfg = JSON.parse(readFileSync(env.OPENCODE_CONFIG!, "utf8")) as {
      provider: { pai: { npm: string; options: { baseURL: string; apiKey: string }; models: Record<string, unknown> } };
    };
    expect(cfg.provider.pai.npm).toBe("@ai-sdk/openai-compatible");
    expect(cfg.provider.pai.options.baseURL).toBe("http://127.0.0.1:8790/p/glm/v1");
    expect(cfg.provider.pai.options.apiKey).toBe("pai");
    expect(cfg.provider.pai.models).toEqual({ "glm-5.3": { name: "glm-5.3" } });
  });

  it("XDG_DATA_HOME is per worker under the scratch dir", () => {
    root = mkdtempSync(join(tmpdir(), "oc-env-"));
    const env = buildOpencodeEnv(provider(), "glm", "m", root, "http://127.0.0.1:8790");
    expect(env.XDG_DATA_HOME).toBe(join(root, "xdg-data"));
  });

  it("no real provider key anywhere in the env", () => {
    root = mkdtempSync(join(tmpdir(), "oc-env-"));
    const secret = "sk-real-secret-token-1234567890";
    const env = buildOpencodeEnv(provider({ key: secret }), "glm", "m", root, "http://127.0.0.1:8790");
    for (const [k, v] of Object.entries(env)) {
      if (v && v.includes(secret)) throw new Error(`key leaked in ${k}`);
    }
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PAI_WORKER).toBe("1");
    expect(env.PAI_WORKER_PROVIDER).toBe("glm");
    expect(env.PAI_WORKER_MODEL).toBe("m");
  });

  it("opencodeConfigJson names the router prefix path for any provider name", () => {
    const cfg = JSON.parse(opencodeConfigJson("kimi", "k2", "http://127.0.0.1:9/v1")) as {
      provider: { pai: { options: { baseURL: string } } };
    };
    expect(cfg.provider.pai.options.baseURL).toBe("http://127.0.0.1:9/v1/p/kimi/v1");
  });
});

describe("foldOpencodeLine — recorded fixtures", () => {
  it("tool run: 2 turns, 1 tool, final text \"ok\", session id, context tokens from step_finish", () => {
    const r = emptyOpencodeResult();
    for (const line of fixture("opencode-tool-run.jsonl").split("\n")) {
      const parsed = parseOpencodeLine(line);
      if (parsed !== null) foldOpencodeLine(parsed, r);
    }
    expect(r.turns).toBe(2);
    expect(r.tools).toBe(1);
    expect(r.finalText).toBe("ok");
    expect(r.isError).toBe(false);
    expect(r.sessionId).toBe("ses_e8dd6eba5ffeRcl3iK0COoMY4F");
    // the last step_finish: input 21 + cache.read 17274 = the turn's fill
    expect(r.contextTokens).toBe(21 + 17274);
    expect(r.last).toBe("says: ok");
    const assistantTexts = r.events.filter((e) => e.type === "assistant" && JSON.stringify(e).includes('"text"'));
    expect(assistantTexts.length).toBe(1);
    const toolUses = r.events.filter((e) => JSON.stringify(e).includes("tool_use"));
    expect(toolUses.length).toBe(2); // one tool_use + one tool_result
    expect(JSON.stringify(r.events)).toContain("echo hi > hello.txt");
  });

  it("error fixture: failure with the error text", () => {
    const r = emptyOpencodeResult();
    for (const line of fixture("opencode-error.jsonl").split("\n")) {
      const parsed = parseOpencodeLine(line);
      if (parsed !== null) foldOpencodeLine(parsed, r);
    }
    expect(r.isError).toBe(true);
    expect(r.last).toBe("Unexpected server error. Check server logs for details.");
    expect(r.finalText).toBeNull();
  });

  it("tool_use with error status marks the tool_result as an error", () => {
    const r = emptyOpencodeResult();
    foldOpencodeLine(
      { type: "tool_use", part: { tool: "bash", state: { status: "error", input: { command: "false" }, output: "boom" } } },
      r
    );
    expect(r.tools).toBe(1);
    expect(JSON.stringify(r.events)).toContain('"is_error":true');
  });

  it("non-JSON and blank lines parse to null", () => {
    expect(parseOpencodeLine("")).toBeNull();
    expect(parseOpencodeLine("plain text")).toBeNull();
    expect(parseOpencodeLine("{not json")).toBeNull();
  });
});
