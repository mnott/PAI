/**
 * statusline-command.test.ts
 *
 * The status line is shell, so it is tested the way it actually runs: fed a
 * payload on stdin and read back line by line.
 *
 * It is worth testing at all because one of its numbers is not decoration. The
 * 7-day percentage is written to ~/.claude/pai/advisor-mode.json and injected into
 * every session as an instruction about how much work to do. On 2026-09-19 it
 * had been reading 97% against a true 2% for a day and a half — the Keychain
 * OAuth token it fetched with had been emptied, the fetch failed silently, and
 * its cache had no expiry, so a spent window's figure was rendered as the
 * current one. Every session was being told its weekly budget was nearly gone
 * and to downgrade models and skip verification.
 *
 * So these pin the things that would have caught it: that a known spend renders
 * as itself rather than its complement, that another provider's session never
 * produces an Anthropic figure, and that an unreadable window renders "?".
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "statusline-command.sh");
const BASH = existsSync("/opt/homebrew/bin/bash") ? "/opt/homebrew/bin/bash" : "/bin/bash";

/** The stub `claude --version` answers, so the assertion cannot pass by accident. */
const STUB_VERSION = "9.9.9";

const NOW = () => Math.floor(Date.now() / 1000);

let binDir: string;

beforeAll(() => {
  // A `claude` that answers instantly and says something no real install would.
  // `pai` is deliberately absent from this PATH so the worker line is not run.
  binDir = mkdtempSync(join(tmpdir(), "pai-sl-bin-"));
  const stub = join(binDir, "claude");
  writeFileSync(stub, `#!/bin/sh\necho "${STUB_VERSION} (Claude Code)"\n`);
  chmodSync(stub, 0o755);
});

interface RunOptions {
  /** Contents of ~/.config/pai/config.json, for provider detection. */
  paiConfig?: unknown;
  /** Extra environment, e.g. to break the stub. */
  env?: Record<string, string>;
}

interface RunResult {
  lines: string[];
  header: string;
  usage: string;
  home: string;
  advisor: Record<string, unknown> | undefined;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Run the real script against a payload in a home of its own.
 *
 * Everything the script can persist is redirected: HOME (advisor file), PAI_DIR
 * (its own config), PAI_CACHE_DIR (usage + version caches) and TMPDIR. A test
 * that wrote to any of those for real would be feeding fixtures to every live
 * session on the machine.
 */
function run(payload: unknown, opts: RunOptions = {}): RunResult {
  const home = mkdtempSync(join(tmpdir(), "pai-sl-home-"));
  const paiDir = join(home, ".claude");
  const cacheDir = join(home, "cache");
  mkdirSync(paiDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  // Wide enough that line 1 is the full variant, the only one carrying "CC <v>".
  writeFileSync(join(paiDir, ".statusline_width"), "200\n");

  let configPath = join(home, "no-such-config.json");
  if (opts.paiConfig !== undefined) {
    configPath = join(home, "pai-config.json");
    writeFileSync(configPath, JSON.stringify(opts.paiConfig));
  }

  const out = execFileSync(BASH, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      PATH: `${binDir}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      PAI_DIR: paiDir,
      PAI_CACHE_DIR: cacheDir,
      PAI_CONFIG: configPath,
      TMPDIR: home,
      DA: "PAI",
      PAI_NO_EMOJI: "1",
      ...opts.env,
    },
  });

  const lines = out.replace(ANSI, "").split("\n").filter((l) => l.length > 0);
  const advisorPath = join(paiDir, "pai", "advisor-mode.json");
  return {
    lines,
    header: lines[0] ?? "",
    usage: lines.find((l) => l.includes("Context")) ?? "",
    home,
    advisor: existsSync(advisorPath)
      ? (JSON.parse(readFileSync(advisorPath, "utf-8")) as Record<string, unknown>)
      : undefined,
  };
}

/** The shape Claude Code really sends, trimmed to what the status line reads. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "11111111-2222-3333-4444-555555555555",
    transcript_path: "/dev/null",
    cwd: "/tmp/example-project",
    model: { id: "claude-opus-5[1m]", display_name: "Opus 5 (1M context)" },
    workspace: {
      current_dir: "/tmp/example-project",
      project_dir: "/tmp/example-project",
      added_dirs: [],
    },
    version: "2.1.267",
    output_style: { name: "Concise" },
    context_window: { used_percentage: 6, context_window_size: 1_000_000 },
    ...over,
  };
}

function rateLimits(fiveUsed: number, sevenUsed: number) {
  return {
    five_hour: { used_percentage: fiveUsed, resets_at: NOW() + 3 * 3600 },
    seven_day: { used_percentage: sevenUsed, resets_at: NOW() + 5 * 86400 },
  };
}

describe("usage windows", () => {
  it("renders a known spend as itself, not as its complement", () => {
    // The fault in one assertion: the real reading was 2% used, the status line
    // said 97%. If anything ever reports remaining as used, or divides by the
    // wrong limit, 2 stops rendering as 2 and this fails.
    const r = run(payload({ rate_limits: rateLimits(9, 2) }));
    expect(r.usage).toContain("5h: 9%");
    expect(r.usage).toContain("7d: 2%");
    expect(r.usage).not.toContain("98%");
    expect(r.usage).not.toContain("91%");
  });

  it("renders a nearly-spent budget as nearly spent", () => {
    // The other end of the same scale, so an inversion cannot pass by
    // symmetry: a fixture at 2/9 alone would still read correctly if the code
    // happened to render 100-x for values above 50.
    const r = run(payload({ rate_limits: rateLimits(88, 97) }));
    expect(r.usage).toContain("5h: 88%");
    // The figure follows "7d:" directly: the advisor mode word is not rendered
    // in the bar, it only acts through the advisor file the whisper hook reads.
    expect(r.usage).toMatch(/7d: 97%/);
    expect(r.usage).not.toMatch(/7d: \S*(critical|strict|conserve|normal)/);
    expect(r.advisor?.weeklyBudgetPercent).toBe(97);
  });

  it("carries the 7-day figure into the advisor file with the time it was read", () => {
    const before = NOW();
    const r = run(payload({ rate_limits: rateLimits(9, 2) }));
    expect(r.advisor?.weeklyBudgetPercent).toBe(2);
    expect(typeof r.advisor?.asOf).toBe("number");
    expect(r.advisor?.asOf as number).toBeGreaterThanOrEqual(before);
  });

  it("renders '?' rather than a number when no source can answer", () => {
    // No rate_limits on stdin and no usage cache. The old code read a missing
    // window as 0 and printed "5h: 0%" — a gauge reading empty while the tank
    // drains. Nothing may be written to the advisor file from a non-reading.
    const r = run(payload());
    expect(r.usage).toContain("5h: ?%");
    expect(r.usage).toContain("7d: ?%");
    expect(r.advisor).toBeUndefined();
  });

  it("drops a window whose reset has already passed", () => {
    // Exactly the frozen-cache case: a percentage that belonged to a window
    // which has since reset. It describes a period that is over, so it is not
    // the current budget and must not be rendered as one.
    const expired = {
      five_hour: { used_percentage: 0, resets_at: NOW() - 60 },
      seven_day: { used_percentage: 97, resets_at: NOW() - 3600 },
    };
    const r = run(payload({ rate_limits: expired }));
    expect(r.usage).toContain("5h: ?%");
    expect(r.usage).toContain("7d: ?%");
    expect(r.usage).not.toContain("97%");
    expect(r.advisor).toBeUndefined();
  });

  it("keeps a genuine 0% distinguishable from an unknown", () => {
    const r = run(payload({ rate_limits: rateLimits(0, 0) }));
    expect(r.usage).toContain("5h: 0%");
    expect(r.usage).toContain("7d: 0%");
    expect(r.advisor?.weeklyBudgetPercent).toBe(0);
  });
});

describe("provider isolation", () => {
  const config = {
    workers: {
      providers: {
        glm: { models: { implement: "glm-5.3" } },
      },
    },
  };

  it("never reports Anthropic windows for a session on another provider", () => {
    // Workers run as separate processes against other base URLs and spend
    // another budget entirely. Counting them into the Anthropic figure would be
    // the same lie in the other direction, so a non-anthropic session must not
    // produce an Anthropic percentage even when one is sitting in the payload.
    const r = run(
      payload({
        model: { id: "glm-5.3", display_name: "GLM 5.3" },
        rate_limits: rateLimits(9, 2),
      }),
      { paiConfig: config },
    );
    expect(r.usage).not.toContain("5h:");
    expect(r.usage).not.toContain("7d:");
    expect(r.usage).toContain("glm");
  });

  it("never writes another provider's session into the Anthropic budget file", () => {
    const r = run(
      payload({
        model: { id: "glm-5.3", display_name: "GLM 5.3" },
        rate_limits: rateLimits(9, 2),
      }),
      { paiConfig: config },
    );
    expect(r.advisor).toBeUndefined();
  });

  it("still reports Anthropic windows for a model the config does not claim", () => {
    const r = run(payload({ rate_limits: rateLimits(9, 2) }), { paiConfig: config });
    expect(r.usage).toContain("7d: 2%");
  });
});

describe("Claude Code version", () => {
  it("uses the version the payload carries", () => {
    expect(run(payload()).header).toContain("CC 2.1.267");
  });

  it("asks the binary when the payload carries none", () => {
    // The payload field is the normal source, but a caller that omits it left
    // the header reading the literal word "unknown" beside a version the
    // installed binary answers immediately.
    const p = payload();
    delete p.version;
    expect(run(p).header).toContain(`CC ${STUB_VERSION}`);
  });

  it("says '?' when there is no payload version and no binary to ask", () => {
    const p = payload();
    delete p.version;
    // A PATH with no `claude` on it at all.
    const r = run(p, { env: { PATH: "/usr/bin:/bin" } });
    expect(r.header).toContain("CC ?");
    expect(r.header).not.toContain("unknown");
  });
});

describe("working directory", () => {
  it("renders the folder from workspace.current_dir", () => {
    expect(run(payload()).header).toContain("example-project");
  });

  it("falls back to the flat cwd when there is no workspace block", () => {
    // The payload carries both; a partial one may carry only cwd. Reading just
    // the nested field printed jq's literal "null" and basename kept it, so the
    // header confidently named a folder called "null".
    const p = payload();
    delete p.workspace;
    const r = run(p);
    expect(r.header).toContain("example-project");
    expect(r.header).not.toContain("null");
  });

  it("never renders the word null as a folder name", () => {
    const p = payload();
    delete p.workspace;
    delete p.cwd;
    const r = run(p);
    expect(r.header).not.toContain("null");
    expect(r.header).not.toMatch(/@\s*$/);
  });
});
