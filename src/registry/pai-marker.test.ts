import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { ensurePaiMarker, isContainerDirectory } from "./pai-marker.js";

describe("isContainerDirectory", () => {
  it("recognises the home directory and its standard containers", () => {
    expect(isContainerDirectory(homedir())).toBe(true);
    expect(isContainerDirectory(join(homedir(), "Desktop"))).toBe(true);
    expect(isContainerDirectory(join(homedir(), "Documents"))).toBe(true);
    expect(isContainerDirectory(join(homedir(), "Downloads"))).toBe(true);
    expect(isContainerDirectory("/tmp")).toBe(true);
    expect(isContainerDirectory("/")).toBe(true);
  });

  it("tolerates a trailing slash", () => {
    expect(isContainerDirectory(join(homedir(), "Desktop") + "/")).toBe(true);
  });

  it("does not claim real projects living inside a container", () => {
    expect(isContainerDirectory(join(homedir(), "Desktop", "MyApp"))).toBe(false);
    expect(isContainerDirectory(join(homedir(), "dev", "ai", "PAI"))).toBe(false);
  });
});

describe("ensurePaiMarker", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pai-marker-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the marker for an ordinary project", () => {
    const project = join(root, "MyProject");
    mkdirSync(project);

    ensurePaiMarker(project, "myproject");

    expect(existsSync(join(project, "Notes", "PAI.md"))).toBe(true);
  });

  it("does NOT create a Notes folder in a container directory", () => {
    // The Desktop case: a session was run there once, so the scanner sees it
    // as a project and would drop a Notes/ folder into it on every scan.
    //
    // Runs against a FAKE home, not the real one. This test used to call
    // ensurePaiMarker against join(homedir(), "Desktop") and assert nothing
    // appeared — which is only harmless for as long as the guard works. The
    // moment it regresses, the very run that catches it also litters the
    // user's real Desktop. A test that damages the thing it is checking is
    // worse than no test.
    //
    // HOME has to be redirected rather than just passing a fake path:
    // isContainerDirectory anchors on homedir(), so join(root, "Desktop") is
    // not a container directory at all and would exercise the wrong branch.
    const realHome = process.env.HOME;
    try {
      process.env.HOME = root;
      const desktop = join(root, "Desktop");
      mkdirSync(desktop, { recursive: true });

      ensurePaiMarker(desktop, "desktop");

      expect(existsSync(join(desktop, "Notes"))).toBe(false);
    } finally {
      process.env.HOME = realHome;
    }
  });

  it("leaves an existing marker in a container directory alone", () => {
    // A marker the user placed deliberately is still updated — the guard only
    // declines to create one.
    const fakeHome = join(root, "Desktop");
    mkdirSync(join(fakeHome, "Notes"), { recursive: true });
    const marker = join(fakeHome, "Notes", "PAI.md");
    writeFileSync(marker, "---\npai:\n  slug: \"x\"\n---\n\nMy notes.\n", "utf8");

    ensurePaiMarker(fakeHome, "x");

    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain("My notes.");
  });
});
