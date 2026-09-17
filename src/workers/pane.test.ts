/**
 * Tests for the worker follow pane's dynamic-profile plumbing.
 *
 * The heart is the fixture plist: it carries a `<date>` object the way real
 * iTerm preferences do (SULastCheckTime & friends). `plutil -convert json`
 * refuses to convert a whole plist containing a date — the exact failure that
 * made the old whole-file read return null and the pai-worker profile never
 * get written. Key-scoped `plutil -extract` sails past it; these tests pin
 * that down so the read never regresses to a whole-file conversion.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PROFILE_NAME,
  SPLIT_SCRIPT,
  WINDOW_BOUNDS_SCRIPT,
  WORKER_SPLIT_SCRIPT,
  checkPaneForWorker,
  dynamicProfilePath,
  followProfile,
  itermPrefs,
  paneFont,
  readItermPlist,
  writeDynamicProfile,
  type PrefsRead,
} from "./pane.js";

const DARWIN = process.platform === "darwin";

/** An iTerm-shaped plist: default guid, two profiles, and a poison <date>. */
const FIXTURE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Default Bookmark Guid</key>
  <string>E66E1EFF-102E-46A0-860F-FA0555E24941</string>
  <key>New Bookmarks</key>
  <array>
    <dict>
      <key>Name</key><string>Other Profile</string>
      <key>Guid</key><string>99999999-8888-7777-6666-555555555555</string>
      <key>Normal Font</key><string>Monaco 12</string>
    </dict>
    <dict>
      <key>Name</key><string>Default</string>
      <key>Guid</key><string>E66E1EFF-102E-46A0-860F-FA0555E24941</string>
      <key>Normal Font</key><string>MesloLGLNFM-Regular 18</string>
    </dict>
  </array>
  <key>SULastCheckTime</key>
  <date>2026-09-17T06:57:48Z</date>
</dict>
</plist>
`;

let tmp: string;
let fixture: string;
let profilePath: string;
let envBackup: string | undefined;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "pai-pane-test-"));
  fixture = join(tmp, "iterm2.plist");
  writeFileSync(fixture, FIXTURE_PLIST, "utf8");
  profilePath = join(tmp, "pai-worker.json");
  envBackup = process.env.PAI_WORKER_PROFILE;
  process.env.PAI_WORKER_PROFILE = profilePath;
});

afterAll(() => {
  if (envBackup === undefined) delete process.env.PAI_WORKER_PROFILE;
  else process.env.PAI_WORKER_PROFILE = envBackup;
  rmSync(tmp, { recursive: true, force: true });
});

describe("readItermPlist", () => {
  it.skipIf(!DARWIN)(
    "whole-file JSON conversion fails on the fixture (the old bug)",
    () => {
      // Precondition: this plist is exactly the kind plutil -convert json
      // chokes on — the failure the old itermPrefs() hit on real machines.
      expect(() =>
        execFileSync("plutil", ["-convert", "json", "-o", "-", fixture], { encoding: "utf8" })
      ).toThrow();
    }
  );

  it.skipIf(!DARWIN)("reads bookmarks and default guid past the <date>", () => {
    const read = readItermPlist(fixture);
    expect(read.error).toBeNull();
    expect(read.defaultGuid).toBe("E66E1EFF-102E-46A0-860F-FA0555E24941");
    expect(read.bookmarks).toHaveLength(2);
    const def = read.bookmarks.find((b) => b.Guid === read.defaultGuid);
    expect(def?.Name).toBe("Default");
    expect(def?.["Normal Font"]).toBe("MesloLGLNFM-Regular 18");
  });

  it.skipIf(!DARWIN)("reports the reason when the plist is unreadable", () => {
    const read = readItermPlist(join(tmp, "no-such.plist"));
    expect(read.error).toMatch(/New Bookmarks/);
    expect(read.bookmarks).toEqual([]);
    expect(read.defaultGuid).toBeNull();
  });

  it.skipIf(!DARWIN)("reads the live iTerm preferences", () => {
    const read = itermPrefs();
    expect(read.error).toBeNull();
    expect(read.bookmarks.length).toBeGreaterThan(0);
    expect(read.defaultGuid).toBeTruthy();
  });
});

describe("paneFont", () => {
  it("keeps the default profile's family at the configured size", () => {
    expect(paneFont("MesloLGLNFM-Regular 18", 13)).toBe("MesloLGLNFM-Regular 13");
    expect(paneFont("Menlo-Regular 14", 11)).toBe("Menlo-Regular 11");
  });

  it("falls back to Menlo-Regular when the family cannot be read", () => {
    expect(paneFont(undefined, 13)).toBe("Menlo-Regular 13");
    expect(paneFont("sizeless", 13)).toBe("Menlo-Regular 13");
  });
});

describe("writeDynamicProfile", () => {
  it("writes the parent's family and names the parent when iTerm knows it", () => {
    const read: PrefsRead = {
      bookmarks: [{ Name: "Default", Guid: "g1", "Normal Font": "MesloLGLNFM-Regular 18" }],
      defaultGuid: "g1",
      error: null,
    };
    writeDynamicProfile(read.bookmarks[0], 13, () => read);
    const written = JSON.parse(readFileSync(profilePath, "utf8"));
    expect(written.Profiles[0]["Normal Font"]).toBe("MesloLGLNFM-Regular 13");
    expect(written.Profiles[0]["Dynamic Profile Parent Name"]).toBe("Default");
    expect(written.Profiles[0]["Close Sessions On End"]).toBe(true);
  });

  it("writes Menlo-Regular and no parent when there is none", () => {
    writeDynamicProfile(null, 13, () => ({ bookmarks: [], defaultGuid: null, error: null }));
    const written = JSON.parse(readFileSync(profilePath, "utf8"));
    expect(written.Profiles[0]["Normal Font"]).toBe("Menlo-Regular 13");
    expect(written.Profiles[0]["Dynamic Profile Parent Name"]).toBeUndefined();
  });
});

describe("followProfile", () => {
  it("writes the profile and warns once even when prefs are unreadable", async () => {
    rmSync(profilePath, { force: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const broken = (): PrefsRead => ({
        bookmarks: [],
        defaultGuid: null,
        error: "defaults export: boom",
      });
      const profile = await followProfile(13, broken);
      expect(profile).toBe("");
      const written = JSON.parse(readFileSync(profilePath, "utf8"));
      expect(written.Profiles[0]["Normal Font"]).toBe("Menlo-Regular 13");
      expect(written.Profiles[0]["Dynamic Profile Parent Name"]).toBeUndefined();
      const warned = stderr.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("cannot read iTerm's default profile"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("boom");
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns the profile name once iTerm lists it", async () => {
    const seen = (): PrefsRead => ({
      bookmarks: [
        { Name: "Default", Guid: "g1", "Normal Font": "MesloLGLNFM-Regular 18" },
        { Name: PROFILE_NAME, Guid: "dyn" },
      ],
      defaultGuid: "g1",
      error: null,
    });
    expect(await followProfile(13, seen)).toBe(PROFILE_NAME);
  });
});

describe("checkPaneForWorker", () => {
  it("reports the profile path, its existence and the font it contains", async () => {
    const out = await checkPaneForWorker("no-such-worker-id", 13, "");
    expect(out).toContain("no pane for no-such-worker-id");
    expect(out).toContain(dynamicProfilePath());
    expect(out).toContain("(exists)");
    expect(out).toContain("Menlo-Regular 13");
  });

  it("reports the hosting window's bounds, saying why when it cannot", async () => {
    const out = await checkPaneForWorker("no-such-worker-id", 13, "");
    expect(out).toContain("window bounds: (not in iTerm2)");
  });
});

describe("WINDOW_BOUNDS_SCRIPT", () => {
  it("reads the hosting window's bounds and never writes anything", () => {
    expect(WINDOW_BOUNDS_SCRIPT).toMatch(/on run\(argv\)/); // argv-only arguments
    expect(WINDOW_BOUNDS_SCRIPT).toMatch(/bounds of w/);
    expect(WINDOW_BOUNDS_SCRIPT).not.toMatch(/set bounds/); // read-only, never moves a window
  });
});

describe("WORKER_SPLIT_SCRIPT window size", () => {
  it("never sizes the new session (columns/rows grow the whole window)", () => {
    expect(WORKER_SPLIT_SCRIPT).not.toMatch(/set columns/);
    expect(WORKER_SPLIT_SCRIPT).not.toMatch(/set rows/);
  });

  it("captures the bounds as a list value before the split and restores them verbatim after", () => {
    const pin = WORKER_SPLIT_SCRIPT.indexOf("copy bounds of w to winBounds");
    const split = WORKER_SPLIT_SCRIPT.indexOf("split vertically");
    const restore = WORKER_SPLIT_SCRIPT.indexOf("set bounds of w to winBounds");
    expect(pin).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(pin); // captured before the split
    expect(restore).toBeGreaterThan(split); // restored after it
    expect(restore).toBeGreaterThan(WORKER_SPLIT_SCRIPT.lastIndexOf("command followCmd"));
    // `set winBounds to bounds of w` stores the property reference lazily —
    // the restore then re-reads the post-split bounds and iTerm clamps the
    // window onto the main display. copy forces the plain list value.
    expect(WORKER_SPLIT_SCRIPT).not.toMatch(/set winBounds to bounds/);
    // bounds never travel as a string: nothing coerces them to text
    expect(WORKER_SPLIT_SCRIPT).not.toMatch(/winBounds as text/);
    // capture and restore live in the same script (one osascript invocation)
    expect(WORKER_SPLIT_SCRIPT.indexOf("on run")).toBeLessThan(pin);
    expect(WORKER_SPLIT_SCRIPT.trimEnd().lastIndexOf("end run")).toBeGreaterThan(restore);
  });

  it("passes arguments as argv items, never interpolated", () => {
    expect(WORKER_SPLIT_SCRIPT).toMatch(/on run\(argv\)/);
  });
});

describe("split scripts never leak keystrokes", () => {
  it("creates every new session with its command from the start", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      // iTerm's `split … command <text>` runs the command in the new session
      // as it is born — the only way no typing step can race the operator's
      // keystrokes or land in the wrong session
      const calls = script.match(/split (vertically|horizontally)[^\n]*/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/ command followCmd$/);
      }
    }
  });

  it("never types text into any session (no write text, scoped or not)", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      expect(script).not.toMatch(/write text/);
      expect(script).not.toMatch(/\bwrite\b/);
    }
  });
});

describe("split scripts never steal input focus", () => {
  it("re-selects the launching session after the split (a split makes the new session active)", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      const split = script.indexOf("split");
      const select = script.indexOf("select s");
      expect(split).toBeGreaterThan(-1);
      expect(select).toBeGreaterThan(script.lastIndexOf("command followCmd"));
    }
  });

  it("never activates and never selects the new session", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      expect(script).toMatch(/select s\b/);
      expect(script).not.toMatch(/select newS/);
      expect(script).not.toMatch(/activate/);
    }
    expect(WINDOW_BOUNDS_SCRIPT).not.toMatch(/select/);
    expect(WINDOW_BOUNDS_SCRIPT).not.toMatch(/activate/);
  });
});
