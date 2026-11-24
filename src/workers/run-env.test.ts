import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeAnthropicProvider } from "./config.js";
import { buildRunEnv, selectWorkerShell, selectWorkerShellUncached, resetWorkerShellCache } from "./run-env.js";

/** A fake shell that prints a chosen `--version` line. */
function fakeShell(dir: string, name: string, versionLine: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${versionLine}"\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => resetWorkerShellCache());

describe("selectWorkerShell", () => {
  it("prefers a bash >= 4 found on PATH over the standard install locations", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-"));
    const p = fakeShell(dir, "bash", "GNU bash, version 5.3.20(1)-release (aarch64-apple-darwin)");
    expect(selectWorkerShell({ PATH: dir })).toBe(p);
  });

  it("skips a bash 3.2 on PATH and takes the next >= 4", () => {
    const old = mkdtempSync(join(tmpdir(), "shell-old-"));
    const neu = mkdtempSync(join(tmpdir(), "shell-new-"));
    fakeShell(old, "bash", "GNU bash, version 3.2.57(1)-release (arm64-apple-darwin)");
    const p = fakeShell(neu, "bash", "GNU bash, version 4.4.0(1)-release");
    expect(selectWorkerShell({ PATH: `${old}:${neu}` })).toBe(p);
  });

  it("accepts Homebrew's capital-V version banner", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-cap-"));
    const p = fakeShell(dir, "bash", "GNU bash, Version 5.3.20(1)-release (aarch64-apple-darwin)");
    expect(selectWorkerShell({ PATH: dir })).toBe(p);
  });

  it("falls back to /bin/zsh when no bash >= 4 exists anywhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-none-"));
    fakeShell(dir, "bash", "GNU bash, version 3.2.57(1)-release");
    const got = selectWorkerShellUncached({ PATH: dir });
    // on a host with a real bash >= 4 at a standard location that wins; otherwise zsh
    if (got === "/bin/zsh") return;
    expect(got).not.toBeNull();
    expect(existsSync(got!)).toBe(true);
  });

  it("leaves it unset (null) when neither bash>=4 nor zsh is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-empty-"));
    fakeShell(dir, "bash", "not a bash at all");
    const got = selectWorkerShellUncached({ PATH: dir });
    // a host with a real bash >= 4 at a standard location keeps it; otherwise zsh;
    // only a host with neither gets null (CLAUDE_CODE_SHELL left unset)
    if (got === null) {
      expect(existsSync("/bin/zsh")).toBe(false);
    } else {
      expect(existsSync(got!)).toBe(true);
    }
  });

  it("caches the selection across calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-cache-"));
    const p = fakeShell(dir, "bash", "GNU bash, version 5.0.0(1)-release");
    expect(selectWorkerShell({ PATH: dir })).toBe(p);
    // a later call with a different PATH keeps the cached answer
    expect(selectWorkerShell({ PATH: mkdtempSync(join(tmpdir(), "shell-other-")) })).toBe(p);
  });
});

describe("buildRunEnv CLAUDE_CODE_SHELL", () => {
  const saved = process.env.CLAUDE_CODE_SHELL;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SHELL;
    else process.env.CLAUDE_CODE_SHELL = saved;
  });

  it("never overrides an explicit CLAUDE_CODE_SHELL", () => {
    process.env.CLAUDE_CODE_SHELL = "/custom/shell";
    const env = buildRunEnv(nativeAnthropicProvider({ default: "claude-sonnet-4-5" }), true);
    expect(env.CLAUDE_CODE_SHELL).toBe("/custom/shell");
  });

  it("sets a usable shell for a headless worker", () => {
    delete process.env.CLAUDE_CODE_SHELL;
    resetWorkerShellCache();
    const env = buildRunEnv(nativeAnthropicProvider({ default: "claude-sonnet-4-5" }), true);
    // on this host a bash >= 4 exists, so the worker must not get /bin/bash 3.2
    expect(env.CLAUDE_CODE_SHELL).toBeDefined();
    expect(env.CLAUDE_CODE_SHELL).not.toBe("/bin/bash");
  });
});
