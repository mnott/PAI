/**
 * `pai daemon keepalive` reads three independently-testable pieces (config,
 * state file, ledger) and only formats them — this pins that the three land
 * in the printed output together, isolated in a temp PAI_HOME/config so a
 * run never touches the user's real files.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRYPOINT = "src/cli/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): { paiHome: string; configFile: string } {
  const paiHome = mkdtempSync(join(tmpdir(), "pai-home-keepalive-"));
  dirs.push(paiHome);
  return { paiHome, configFile: join(paiHome, "config.json") };
}

function runKeepalive(env: NodeJS.ProcessEnv): string {
  return execFileSync("bun", [ENTRYPOINT, "daemon", "keepalive"], {
    encoding: "utf8",
    timeout: 15_000,
    env,
  });
}

describe("pai daemon keepalive", () => {
  it("reports disabled with defaults and no counters/ledger yet", () => {
    const { paiHome, configFile } = tempHome();
    writeFileSync(configFile, JSON.stringify({}), "utf8");
    const out = runKeepalive({ ...process.env, PAI_HOME: paiHome, PAI_CONFIG_FILE: configFile });
    expect(out).toContain("disabled");
    expect(out).toContain("idleMinutes: 50");
    expect(out).toContain("maxBeats: 6");
    expect(out).toContain("No per-session beat counters recorded yet.");
    expect(out).toContain("0 sent, 0 skipped");
  });

  it("reports enabled with overridden parameters, per-session counters, and ledger lines", () => {
    const { paiHome, configFile } = tempHome();
    writeFileSync(
      configFile,
      JSON.stringify({ sessions: { cacheKeepalive: { enabled: true, idleMinutes: 5, maxBeats: 3 } } }),
      "utf8"
    );
    writeFileSync(
      join(paiHome, "session-keepalive.json"),
      JSON.stringify({ "sess-1": { beats: 2, lastRealPromptKey: "u1", lastBeatAt: "2026-09-20T10:00:00.000Z" } }),
      "utf8"
    );
    const logDir = join(paiHome, "logs", "workers");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "ledger.log"),
      "2026-09-20 10:00:00 SESSION-KEEPALIVE session=sess-1 idle_min=6.0 context=30000 beat=1/3 result=sent\n" +
        "2026-09-20 10:05:00 SESSION-KEEPALIVE session=sess-1 idle_min=1.0 context=30000 beat=1/3 result=skipped:idle:1.0min\n",
      "utf8"
    );

    const out = runKeepalive({ ...process.env, PAI_HOME: paiHome, PAI_CONFIG_FILE: configFile });
    expect(out).toContain("enabled");
    expect(out).not.toContain("disabled");
    expect(out).toContain("idleMinutes: 5");
    expect(out).toContain("maxBeats: 3");
    expect(out).toContain("sess-1: beats=2 lastBeatAt=2026-09-20T10:00:00.000Z");
    expect(out).toContain("1 sent, 1 skipped");
    expect(out).toContain("result=sent");
    expect(out).toContain("result=skipped:idle:1.0min");
  });
});
