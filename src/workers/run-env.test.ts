import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { selectWorkerShell, resetWorkerShellCache } from "./run-env.js";

/** A fake shell that prints a chosen `--version` line. */
function fakeShell(dir: string, name: string, versionLine: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${versionLine}"\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => resetWorkerShellCache());

describe("selectWorkerShell", () => {
  it("prefers a bash >= 4 found on PATH", () => {
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

  it("falls back to /bin/zsh when no bash >= 4 exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-none-"));
    fakeShell(dir, "bash", "GNU bash, version 3.2.57(1)-release");
    expect(selectWorkerShell({ PATH: dir })).toBe("/bin/zsh");
  });

  it("leaves it unset (null) when neither bash>=4 nor zsh is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-empty-"));
    fakeShell(dir, "bash", "not a bash at all");
    // the fallback only applies when /bin/zsh is genuinely absent (a non-macOS host);
    // on macOS it exists, so the selection is zsh there — assert the real contract
    if (existsSync("/bin/zsh")) {
      expect(selectWorkerShell({ PATH: dir })).toBe("/bin/zsh");
    } else {
      expect(selectWorkerShell({ PATH: dir })).toBeNull();
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
