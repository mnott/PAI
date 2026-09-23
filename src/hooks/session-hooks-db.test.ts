import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Proof for docs/design/postgres-only.md unit 8: session-stop.sh and
 * pre-compact.sh no longer shell out to sqlite3 — they shell out to
 * `pai hooks-db <verb> <projectSlug>`, exactly once per run. A fake `pai`
 * on PATH logs every invocation it receives; both scripts run detached
 * (backgrounded + disowned), so the test polls the log file for the
 * expected line instead of asserting on synchronous stdout.
 */
describe("session-stop.sh / pre-compact.sh call pai hooks-db", () => {
  let fakeBinDir: string;
  let homeDir: string;
  let logFile: string;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "hooks-db-test-bin-"));
    homeDir = mkdtempSync(join(tmpdir(), "hooks-db-test-home-"));
    logFile = join(fakeBinDir, "pai-calls.log");
    writeFileSync(logFile, "");

    const fakePai = join(fakeBinDir, "pai");
    writeFileSync(
      fakePai,
      [
        "#!/bin/bash",
        `echo "$*" >> ${JSON.stringify(logFile)}`,
        'if [ "$1" = "project" ] && [ "$2" = "detect" ]; then',
        '  echo \'{"slug":"testproj"}\'',
        "fi",
        "exit 0",
      ].join("\n")
    );
    chmodSync(fakePai, 0o755);
  });

  afterEach(() => {
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function runHookDetached(script: string): void {
    execFileSync("bash", [script], {
      encoding: "utf8",
      timeout: 15_000,
      input: "",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        HOME: homeDir,
        PAI_HOME: join(homeDir, ".claude", "pai"),
        PAI_DIR: join(homeDir, ".claude"), // no tab-color-command.sh here: TAB_COLOR call is a no-op
        PAI_WORKER: "",
      },
    });
  }

  function waitForLogLine(match: string, timeoutMs = 5000): string {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(logFile)) {
        const content = readFileSync(logFile, "utf8");
        if (content.includes(match)) return content;
      }
    }
    return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  }

  it("session-stop.sh invokes exactly `pai hooks-db session-stop <slug>`", () => {
    runHookDetached("src/hooks/session-stop.sh");
    const content = waitForLogLine("hooks-db session-stop");
    const calls = content.split("\n").filter((l) => l.startsWith("hooks-db"));
    expect(calls).toEqual(["hooks-db session-stop testproj"]);
  });

  it("pre-compact.sh invokes exactly `pai hooks-db pre-compact <slug>`", () => {
    runHookDetached("src/hooks/pre-compact.sh");
    const content = waitForLogLine("hooks-db pre-compact");
    const calls = content.split("\n").filter((l) => l.startsWith("hooks-db"));
    expect(calls).toEqual(["hooks-db pre-compact testproj"]);
  });

  it("neither script contains a raw sqlite3 call", () => {
    const stopScript = readFileSync("src/hooks/session-stop.sh", "utf8");
    const compactScript = readFileSync("src/hooks/pre-compact.sh", "utf8");
    expect(stopScript).not.toContain("sqlite3");
    expect(compactScript).not.toContain("sqlite3");
  });
});
