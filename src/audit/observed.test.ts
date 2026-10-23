import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { observedHookEvents, observedMcpServers, auditHooks, DEFAULT_SINCE_HOURS } from "./hooks.js";
import { localCaptureDate } from "../hooks/ts/lib/raw-capture.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-observed-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** One month dir under the capture root, like capture-all-events writes. */
function captureDir(root: string): string {
  const month = join(root, "raw-outputs", localCaptureDate().substring(0, 7));
  mkdirSync(month, { recursive: true });
  return month;
}

/** Today's capture file name, same local-date naming the hooks use. */
const today = localCaptureDate();

function eventLine(event: string, ts: number): string {
  return JSON.stringify({ hook_event_type: event, timestamp: ts, session_id: "s", source: "hook" }) + "\n";
}

describe("observedHookEvents", () => {
  it("counts events and keeps the newest timestamp as last", async () => {
    const month = captureDir(newDir());
    const now = Date.now();
    writeFileSync(
      join(month, `${today}_all-events.jsonl`),
      eventLine("PreToolUse", now - 5_000) + eventLine("PreToolUse", now - 1_000) + eventLine("Stop", now - 2_000),
      "utf8"
    );

    const observed = await observedHookEvents(join(month, ".."), now - 3_600_000);
    expect(observed.get("PreToolUse")?.count).toBe(2);
    expect(observed.get("PreToolUse")?.last).toBe(new Date(now - 1_000).toISOString());
    expect(observed.get("Stop")?.count).toBe(1);
  });

  it("skips malformed lines without throwing", async () => {
    const month = captureDir(newDir());
    const now = Date.now();
    writeFileSync(
      join(month, `${today}_all-events.jsonl`),
      "{ not json\n" + eventLine("UserPromptSubmit", now) + "\n\n",
      "utf8"
    );

    const observed = await observedHookEvents(join(month, ".."), now - 3_600_000);
    expect(observed.get("UserPromptSubmit")?.count).toBe(1);
  });

  it("ignores files not modified since sinceMs", async () => {
    const root = newDir();
    const month = captureDir(root);
    const now = Date.now();
    const old = join(month, `${today}_all-events.jsonl`);
    writeFileSync(old, eventLine("SessionStart", now), "utf8");
    const d = new Date(now - 48 * 3_600_000);
    utimesSync(old, d, d);

    const observed = await observedHookEvents(join(root, "raw-outputs"), now - 24 * 3_600_000);
    expect(observed.size).toBe(0);
  });

  it("returns an empty map for a missing capture dir", async () => {
    const observed = await observedHookEvents(join(newDir(), "nope"), Date.now());
    expect(observed.size).toBe(0);
  });
});

describe("observedMcpServers", () => {
  it("counts mcp__<server>__<tool> calls by server", async () => {
    const root = newDir();
    const month = captureDir(root);
    const now = Date.now();
    writeFileSync(
      join(month, `${today}_all-events.jsonl`),
      JSON.stringify({ hook_event_type: "PostToolUse", timestamp: now, payload: { tool_name: "mcp__alpha__do_thing" } }) +
        "\n" +
        JSON.stringify({ hook_event_type: "PostToolUse", timestamp: now - 1_000, payload: { tool_name: "mcp__alpha__other" } }) +
        "\n" +
        JSON.stringify({ hook_event_type: "PostToolUse", timestamp: now - 2_000, payload: { tool_name: "Bash" } }) +
        "\n",
      "utf8"
    );
    writeFileSync(
      join(month, `${today}_tool-outputs.jsonl`),
      JSON.stringify({ timestamp: new Date(now - 500).toISOString(), tool: "mcp__beta__x" }) + "\n",
      "utf8"
    );

    const observed = await observedMcpServers(join(root, "raw-outputs"), now - 3_600_000);
    expect(observed.get("alpha")?.count).toBe(2);
    expect(observed.get("beta")?.count).toBe(1);
    expect(observed.get("beta")?.last).toBe(new Date(now - 500).toISOString());
    expect(observed.has("Bash")).toBe(false);
  });
});

describe("auditHooks observed state", () => {
  function writeSettings(cwd: string, hooks: unknown): void {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks }), "utf8");
  }

  it("marks a hook observed when its event has a recent capture", () => {
    const cwd = newDir();
    const root = newDir();
    const month = captureDir(root);
    const now = Date.now();
    writeFileSync(join(month, `${today}_all-events.jsonl`), eventLine("SessionStart", now - 60_000), "utf8");
    writeSettings(cwd, { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] });

    const report = auditHooks(cwd, { captureDir: join(root, "raw-outputs"), now });
    expect(report.readings[0].state).toBe("observed");
    expect(report.readings[0].lastSeen).toBe(new Date(now - 60_000).toISOString());
  });

  it("marks a configured hook without captures as configured", () => {
    const cwd = newDir();
    const root = newDir();
    captureDir(root);
    writeSettings(cwd, { UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }] });

    const report = auditHooks(cwd, { captureDir: join(root, "raw-outputs"), now: Date.now() });
    expect(report.readings[0].state).toBe("configured");
    expect(report.readings[0].lastSeen).toBeUndefined();
  });

  it("marks a hook whose script file does not exist as missing-script", () => {
    const cwd = newDir();
    const root = newDir();
    const month = captureDir(root);
    const now = Date.now();
    writeFileSync(join(month, `${today}_all-events.jsonl`), eventLine("SessionStart", now), "utf8");
    writeSettings(cwd, {
      SessionStart: [{ hooks: [{ type: "command", command: join(cwd, "gone.sh") }] }],
    });

    const report = auditHooks(cwd, { captureDir: join(root, "raw-outputs"), now });
    expect(report.readings[0].state).toBe("missing-script");
    expect(report.readings[0].missingPath).toBe(join(cwd, "gone.sh"));
  });

  it("finds the script after node/sh/bash, not the interpreter", () => {
    const cwd = newDir();
    const root = newDir();
    const month = captureDir(root);
    const now = Date.now();
    writeFileSync(join(month, `${today}_all-events.jsonl`), eventLine("SessionStart", now), "utf8");
    writeSettings(cwd, {
      SessionStart: [
        { hooks: [{ type: "command", command: `node ${join(cwd, "gone.mjs")}` }] },
        { hooks: [{ type: "command", command: `sh ${join(cwd, "gone.sh")}` }] },
      ],
    });

    const report = auditHooks(cwd, { captureDir: join(root, "raw-outputs"), now });
    expect(report.readings.map((r) => r.state)).toEqual(["missing-script", "missing-script"]);
    expect(report.readings[0].missingPath).toBe(join(cwd, "gone.mjs"));
    expect(report.readings[1].missingPath).toBe(join(cwd, "gone.sh"));
  });

  it("expands ${ADAPTER_DIR} and ~ before checking the script exists", () => {
    const cwd = newDir();
    const root = newDir();
    captureDir(root);
    mkdirSync(join(cwd, "Hooks"), { recursive: true });
    writeFileSync(join(cwd, "Hooks", "present.mjs"), "", "utf8");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        env: { ADAPTER_DIR: cwd },
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "${ADAPTER_DIR}/Hooks/present.mjs" }] },
            { hooks: [{ type: "command", command: "${ADAPTER_DIR}/Hooks/gone.mjs" }] },
            { hooks: [{ type: "command", command: `~/Hooks/gone.mjs` }] },
          ],
        },
      }),
      "utf8"
    );

    const report = auditHooks(cwd, { captureDir: join(root, "raw-outputs"), now: Date.now() });
    expect(report.readings[0].state).toBe("configured");
    expect(report.readings[1].state).toBe("missing-script");
    expect(report.readings[1].missingPath).toBe(join(cwd, "Hooks", "gone.mjs"));
    expect(report.readings[2].state).toBe("missing-script");
    expect(report.readings[2].missingPath).toBe(join(homedir(), "Hooks", "gone.mjs"));
  });

  it("keeps the legacy HookRunner signature working", () => {
    const cwd = newDir();
    writeSettings(cwd, { SessionStart: [{ hooks: [{ type: "command", command: "printf hi" }] }] });
    const report = auditHooks(cwd, () => ({ stdout: "hi" }));
    expect(report.readings[0].tokens).toBeGreaterThan(0);
    expect(report.readings[0].state).toBe("configured");
  });

  it("defaults the window to DEFAULT_SINCE_HOURS", () => {
    expect(DEFAULT_SINCE_HOURS).toBe(24);
  });
});
