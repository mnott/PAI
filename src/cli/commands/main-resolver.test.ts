import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSessionDir } from "./main-resolver.js";

/**
 * A session carries up to three ideas of where it lives, and the preferred one
 * is the least durable: the per-session copy is captured when the session starts
 * and goes stale the moment the directory is renamed, while the registry's path
 * is kept current.
 *
 * Taking the first and giving up on failure made a live project unopenable by
 * its own name — the correct path was sitting in the same record, untried.
 */

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pai-resolve-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("falling through stale candidates", () => {
  it("uses the registry path when the per-session one is stale", () => {
    const live = join(tmp, "renamed-to-this");
    mkdirSync(live);

    const { dir } = resolveSessionDir({
      clcDirectory: join(tmp, "old-name-gone"), // stale: pre-rename
      registryRootPath: live,
      decodedPath: join(tmp, "also-gone"),
    });

    expect(dir).toBe(live);
  });

  it("prefers the per-session directory when it is valid", () => {
    // It can name a subdirectory the session actually ran in, so it stays first.
    const root = join(tmp, "root");
    const sub = join(root, "sub");
    mkdirSync(root);
    mkdirSync(sub);

    const { dir } = resolveSessionDir({ clcDirectory: sub, registryRootPath: root });

    expect(dir).toBe(sub);
  });

  it("falls to the third candidate when the first two are gone", () => {
    const live = join(tmp, "last-hope");
    mkdirSync(live);

    const { dir } = resolveSessionDir({
      clcDirectory: join(tmp, "gone-1"),
      registryRootPath: join(tmp, "gone-2"),
      decodedPath: live,
    });

    expect(dir).toBe(live);
  });
});

describe("reporting a total failure", () => {
  it("returns undefined and lists every candidate tried", () => {
    // Naming one path while silently ignoring the others is what made this
    // impossible to diagnose from the error alone.
    const { dir, tried } = resolveSessionDir({
      clcDirectory: join(tmp, "a"),
      registryRootPath: join(tmp, "b"),
      decodedPath: join(tmp, "c"),
    });

    expect(dir).toBeUndefined();
    expect(tried).toHaveLength(3);
  });

  it("handles a session with no directory at all", () => {
    const { dir, tried } = resolveSessionDir({});
    expect(dir).toBeUndefined();
    expect(tried).toEqual([]);
  });

  it("ignores empty strings rather than trying to resolve them", () => {
    const live = join(tmp, "real");
    mkdirSync(live);
    const { dir, tried } = resolveSessionDir({ clcDirectory: "", registryRootPath: live });
    expect(dir).toBe(live);
    expect(tried).toEqual([live]);
  });
});

describe("symlinked parents", () => {
  it("canonicalises, so one directory has one identity", () => {
    const real = join(tmp, "real");
    mkdirSync(real);
    const child = join(real, "proj");
    mkdirSync(child);
    symlinkSync(real, join(tmp, "link"));

    const { dir } = resolveSessionDir({ clcDirectory: join(tmp, "link", "proj") });

    expect(dir).toBe(realpathSync(child));
    expect(dir).not.toContain("link");
  });
});
