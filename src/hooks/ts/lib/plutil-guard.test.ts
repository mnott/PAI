import { describe, it, expect } from "vitest";
import { detectUnsafePlutil, plutilGuardMessage } from "./plutil-guard.js";

const DENIED_COMMANDS = [
  "plutil -extract Label json /tmp/x.plist",
  "plutil -replace Label -string foo /tmp/x.plist",
  "plutil -insert Label -string foo /tmp/x.plist",
  "plutil -remove Label /tmp/x.plist",
  "plutil -convert xml1 /tmp/x.plist",
  "plutil -create xml1 /tmp/x.plist",
  "cd /tmp && plutil -extract Label json /tmp/x.plist",
  "plutil -extract Label json /tmp/x.plist | cat",
  "plutil -extract Label json /tmp/x.plist; echo done",
  "echo $(plutil -extract Label json /tmp/x.plist)",
  "echo `plutil -extract Label json /tmp/x.plist`",
  "for f in *.plist; do plutil -extract Label json $f; done",
];

const ALLOWED_COMMANDS = [
  "plutil -p /tmp/x.plist",
  "plutil -lint /tmp/x.plist",
  "plutil -help",
  "plutil -extract Label json -o - /tmp/x.plist",
  "plutil -extract ProgramArguments json -o /tmp/out.json /tmp/x.plist",
  "plutil -convert xml1 -o /tmp/out.plist /tmp/x.plist",
  "for f in *.plist; do plutil -extract Label json -o - $f; done",
  "ls -la",
  "git status",
];

describe("detectUnsafePlutil", () => {
  for (const cmd of DENIED_COMMANDS) {
    it(`denies: ${cmd}`, () => {
      const result = detectUnsafePlutil(cmd);
      expect(result.blocked).toBe(true);
      expect(result.verb).toBeTruthy();
    });
  }

  for (const cmd of ALLOWED_COMMANDS) {
    it(`allows: ${cmd}`, () => {
      expect(detectUnsafePlutil(cmd).blocked).toBe(false);
    });
  }
});

describe("plutilGuardMessage", () => {
  it("names the verb and the safe alternatives", () => {
    const msg = plutilGuardMessage("-extract");
    expect(msg).toContain("-extract");
    expect(msg).toContain("plutil -p <file>");
    expect(msg).toContain("-o - <file>");
  });
});
