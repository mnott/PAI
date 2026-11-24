import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { bashResultHint, isLocalWorkerProvider, toolResultText, EMPTY_SUCCESS_HINT, SEARCH_MISS_HINT, NO_OUTPUT_SENTINEL } from "./worker-result-hint.js";
import type { WorkersConfig } from "../../../workers/config.js";

const cfg = (providers: Record<string, { baseUrl: string }>): WorkersConfig =>
  ({ providers }) as unknown as WorkersConfig;

describe("bashResultHint", () => {
  it("returns the success hint for empty output (tsc with no errors)", () => {
    expect(bashResultHint("npx tsc --noEmit 2>&1 | head -20", "")).toBe(EMPTY_SUCCESS_HINT);
    expect(bashResultHint("npx tsc --noEmit", "   \n")).toBe(EMPTY_SUCCESS_HINT);
  });

  it("treats the harness no-output sentinel as success (worker 20261124-050119-64084 re-ran tsc 5x)", () => {
    expect(bashResultHint("npx tsc --noEmit 2>&1 | head -20", NO_OUTPUT_SENTINEL)).toBe(EMPTY_SUCCESS_HINT);
  });

  it("returns the search hint when a grep output contains none of the searched names", () => {
    const out = "src/foo.ts:12:export async function handleOtherCommand";
    expect(bashResultHint('grep -n "handleMqttCommand\\|handleCreateCommand" src/foo.ts', out)).toBe(SEARCH_MISS_HINT);
    expect(bashResultHint("grep handleMqttCommand src/foo.ts", out)).toBe(SEARCH_MISS_HINT);
    expect(bashResultHint("rg handleCreateCommand src", out)).toBe(SEARCH_MISS_HINT);
  });

  it("returns null when the grep output contains a searched name", () => {
    const out = "src/foo.ts:12:export async function handleMqttCommand";
    expect(bashResultHint('grep -n "handleMqttCommand" src/foo.ts', out)).toBeNull();
  });

  it("returns null for non-empty output of a non-search command", () => {
    expect(bashResultHint("git config --list --show-origin | grep user", "file:/x/user.name=me")).toBeNull();
    expect(bashResultHint("ls", "a.ts\nb.ts")).toBeNull();
  });

  it("checks every grep segment of a chained command", () => {
    const out = "src/foo.ts:1:other";
    expect(bashResultHint("ls; grep handleMqttCommand src/foo.ts", out)).toBe(SEARCH_MISS_HINT);
    expect(bashResultHint("grep handleMqttCommand src/foo.ts; ls", out)).toBe(SEARCH_MISS_HINT);
  });
});

describe("toolResultText", () => {
  it("reads stdout+stderr from the Bash result object (the shape Claude Code sends)", () => {
    expect(toolResultText({ stdout: "", stderr: "", interrupted: false })).toBe("");
    expect(toolResultText({ stdout: "   \n", stderr: "", interrupted: false })).toBe("   \n");
    expect(toolResultText({ stdout: "out", stderr: "err", interrupted: false })).toBe("out\nerr");
    expect(toolResultText({ stdout: "out", stderr: "", interrupted: false })).toBe("out");
  });

  it("never treats an interrupted result as empty", () => {
    expect(toolResultText({ stdout: "", stderr: "", interrupted: true })).toBe("(interrupted)");
    expect(toolResultText({ stdout: "partial", stderr: "", interrupted: true })).toBe("partial");
  });

  it("keeps accepting the string shape", () => {
    expect(toolResultText("(Bash completed with no output)")).toBe("(Bash completed with no output)");
    expect(toolResultText("plain output")).toBe("plain output");
  });

  it("returns empty for missing or non-object shapes", () => {
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText(null)).toBe("");
    expect(toolResultText(42)).toBe("");
  });
});

describe("isLocalWorkerProvider", () => {
  it("is false for an interactive session (no provider set)", () => {
    expect(isLocalWorkerProvider({}, cfg({}))).toBe(false);
  });

  it("is false for the native anthropic provider", () => {
    expect(isLocalWorkerProvider({ PAI_WORKER_PROVIDER: "anthropic" }, cfg({}))).toBe(false);
  });

  it("is false for a cloud provider", () => {
    expect(isLocalWorkerProvider({ PAI_WORKER_PROVIDER: "openrouter" }, cfg({ openrouter: { baseUrl: "https://openrouter.ai/api/v1" } }))).toBe(false);
  });

  it("is true for a loopback provider", () => {
    expect(isLocalWorkerProvider({ PAI_WORKER_PROVIDER: "gyro-l" }, cfg({ "gyro-l": { baseUrl: "http://127.0.0.1:8000/v1" } }))).toBe(true);
    expect(isLocalWorkerProvider({ PAI_WORKER_PROVIDER: "gyro-l" }, cfg({ "gyro-l": { baseUrl: "http://localhost:8000/v1" } }))).toBe(true);
  });

  it("is false when the provider name is unknown (never guessed local)", () => {
    expect(isLocalWorkerProvider({ PAI_WORKER_PROVIDER: "typo" }, cfg({}))).toBe(false);
  });
});

describe("isLocalWorkerProvider url lists", () => {
  const env = { PAI_WORKER_PROVIDER: "signal-2" };
  it("is local when every entry of a url list is loopback", () => {
    expect(isLocalWorkerProvider(env, { providers: { "signal-2": { url: ["http://127.0.0.1:8044", "http://127.0.0.1:8045"] } } } as unknown as WorkersConfig)).toBe(true);
    expect(isLocalWorkerProvider(env, { providers: { "signal-2": { baseUrl: "http://127.0.0.1:8044", instances: ["http://127.0.0.1:8044", "http://localhost:8045"] } } } as unknown as WorkersConfig)).toBe(true);
  });
  it("is not local when one entry of the list is remote", () => {
    expect(isLocalWorkerProvider(env, { providers: { "signal-2": { url: ["http://127.0.0.1:8044", "https://example.com"] } } } as unknown as WorkersConfig)).toBe(false);
  });
});

describe("built worker-result-hint hook", () => {
  const hook = join(process.cwd(), "dist/hooks/worker-result-hint.mjs");
  const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" }, tool_response: { stdout: "", stderr: "", interrupted: false } });
  function run(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "wrh-"));
    try {
      writeFileSync(join(dir, "workers.yaml"), yaml);
      return execFileSync("node", [hook], {
        input,
        encoding: "utf8",
        env: { ...process.env, PAI_WORKER: "1", PAI_WORKER_PROVIDER: "signal-2", PAI_WORKERS_YAML: join(dir, "workers.yaml"), PAI_CONFIG_FILE: join(dir, "config.json") },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const list = "providers:\n  signal-2:\n    enabled: true\n    url:\n      - http://127.0.0.1:8044\n      - http://127.0.0.1:8045\n    models:\n      default: m\n      fast: m\n";
  it.skipIf(!existsSync(hook))("prints the success hint for a provider with a url list", () => {
    expect(run(list)).toContain(EMPTY_SUCCESS_HINT);
  });
  it.skipIf(!existsSync(hook))("still prints it when the entry fails validation (unknown key)", () => {
    expect(run(list + "    bogus_key: 1\n")).toContain(EMPTY_SUCCESS_HINT);
  });
  it.skipIf(!existsSync(hook))("prints nothing for a remote url list", () => {
    expect(run(list.replace("127.0.0.1:8045", "example.com"))).toBe("");
  });
});
