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
  followCommand,
  followProfile,
  noPaneMessage,
  paneBackend,
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

describe("followCommand", () => {
  it("is one exec-able line: absolute node on the CLI entry, unquoted wid", () => {
    const cmd = followCommand("20260918-104952-27763", 60);
    const suffix = " worker follow 20260918-104952-27763 --auto-exit 60";
    expect(cmd.endsWith(suffix)).toBe(true);
    const bin = cmd.slice(0, cmd.length - suffix.length);
    expect(bin.startsWith(`${process.execPath} `)).toBe(true);
    // the CLI part is the absolute running pai, or the PATH-lookup fallback
    expect(bin.slice(process.execPath.length + 1)).toMatch(/(^|\/)pai$/);
    expect(cmd).not.toMatch(/^\s/); // a leading space killed the pane at birth
    expect(cmd).not.toMatch(/\bexec\b/); // exec made iTerm fail to run it at all
  });

  it("carries no shell syntax: iTerm execs the split command, not a shell", () => {
    // proven live: `export …; …` and redirects die instantly, plain execs survive
    const cmd = followCommand("20260918-104952-27763", 60);
    expect(cmd).not.toContain(";");
    expect(cmd).not.toContain("export");
    expect(cmd).not.toContain('"'); // quotes would reach execve as literal characters
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
    expect(WINDOW_BOUNDS_SCRIPT).toMatch(/function run\(argv\)/); // argv-only arguments
    expect(WINDOW_BOUNDS_SCRIPT).toMatch(/w\.bounds\(\)/);
    expect(WINDOW_BOUNDS_SCRIPT).not.toMatch(/bounds =/); // read-only, never moves a window
  });
});

describe("iTerm scripts are JXA", () => {
  it("take argv through run(argv) and never use AppleScript syntax", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT, WINDOW_BOUNDS_SCRIPT]) {
      expect(script).toMatch(/function run\(argv\)/);
      expect(script).toMatch(/Application\("iTerm2"\)/);
      expect(script).not.toMatch(/tell application|\bon run\b/);
    }
  });
});

describe("WORKER_SPLIT_SCRIPT window size", () => {
  it("never sizes the new session (columns/rows grow the whole window)", () => {
    expect(WORKER_SPLIT_SCRIPT).not.toMatch(/\.columns\s*=/);
    expect(WORKER_SPLIT_SCRIPT).not.toMatch(/\.rows\s*=/);
  });

  it("captures the bounds as a plain value before the split and restores them verbatim after", () => {
    const pin = WORKER_SPLIT_SCRIPT.indexOf("var winBounds = f.w.bounds()");
    const split = WORKER_SPLIT_SCRIPT.indexOf("splitVertically");
    const restore = WORKER_SPLIT_SCRIPT.indexOf("f.w.bounds = winBounds");
    expect(pin).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(pin); // captured before the split
    expect(restore).toBeGreaterThan(split); // restored after it
    expect(restore).toBeGreaterThan(WORKER_SPLIT_SCRIPT.lastIndexOf("command: followCmd"));
    // capture and restore live in the same script (one osascript invocation)
    expect(WORKER_SPLIT_SCRIPT.indexOf("function run(argv)")).toBeLessThan(pin);
  });
});

describe("split scripts never leak keystrokes", () => {
  it("creates every new session with its command from the start", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      // iTerm's split `command` runs it in the new session as it is born — the
      // only way no typing step can race the operator's keystrokes or land in
      // the wrong session
      const calls = script.match(/\.split(Vertically|Horizontally)[^\n]*/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/command: followCmd/);
      }
    }
  });

  it("never types text into any session (no write)", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      expect(script).not.toMatch(/\.write\(/);
    }
  });
});

describe("split scripts never steal input focus", () => {
  it("re-selects the launching session after the split (a split makes the new session active)", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      const select = script.indexOf("f.s.select()");
      expect(script.indexOf("split")).toBeGreaterThan(-1);
      expect(select).toBeGreaterThan(script.lastIndexOf("command: followCmd"));
    }
  });

  it("never activates and never selects the new session", () => {
    for (const script of [WORKER_SPLIT_SCRIPT, SPLIT_SCRIPT]) {
      expect(script).toMatch(/f\.s\.select\(\)/);
      expect(script).not.toMatch(/newS\.select/);
      expect(script).not.toMatch(/activate/);
    }
    expect(WINDOW_BOUNDS_SCRIPT).not.toMatch(/select/);
    expect(WINDOW_BOUNDS_SCRIPT).not.toMatch(/activate/);
  });
});

describe("paneBackend", () => {
  it("TMUX set -> tmux, on any platform, and beats iTerm", () => {
    expect(paneBackend({ TMUX: "/tmp/tmux-1/default,1,0" }, "linux")).toBe("tmux");
    expect(paneBackend({ TMUX: "x", ITERM_SESSION_ID: "w0t0p0:U" }, "darwin")).toBe("tmux");
  });
  it("darwin + ITERM_SESSION_ID -> iterm", () => {
    expect(paneBackend({ ITERM_SESSION_ID: "w0t0p0:U" }, "darwin")).toBe("iterm");
  });
  it("anything else -> none", () => {
    expect(paneBackend({ ITERM_SESSION_ID: "w0t0p0:U" }, "linux")).toBe("none");
    expect(paneBackend({}, "darwin")).toBe("none");
    expect(noPaneMessage("w1")).toBe("no pane support here, use: pai worker follow w1");
  });
});
