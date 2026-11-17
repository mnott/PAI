import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessReason, HEADLESS_DENY_MESSAGE } from "./headless-gate.js";

const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
const dir = mkdtempSync(join(tmpdir(), "headless-"));
writeFileSync(join(dir, "win.swift"), "import AppKit\nlet w = NSWindow(contentRect: .zero, styleMask: [], backing: .buffered, defer: false)\n");
writeFileSync(join(dir, "pol.swift"), "NSApplication.shared.setActivationPolicy(.accessory)\n");
writeFileSync(join(dir, "plain.swift"), "print(\"hello\")\n");
writeFileSync(join(dir, "proc.swift"), "let p = Process(); try p.run()\n");
const r = (c: string, env = W) => headlessReason(c, env, dir);

describe("headless gate", () => {
  it.each([
    "open report.pdf", "cd x && open -a Preview a.pdf", "open -n http://x.test", "echo hi; open a.png", "echo $(open a.png)",
    "osascript -e 'tell application \"Finder\" to activate'", "osascript -e 'display dialog \"x\"'",
    "swift win.swift", "xcrun swift win.swift", "swiftc -o p pol.swift && ./p", "swift -e 'NSApp.run()'",
    "./Build/X.app/Contents/MacOS/X", "bash -c 'open a.pdf'",
    "lldb --batch -o \"process launch\" -- build/Debug/X.app/Contents/MacOS/X", "lldb build/X.app -o run",
    "xcrun lldb -o \"run\" build/X.app/Contents/MacOS/X", "BIN=build/X.app/Contents/MacOS/X; \"$BIN\"",
    "env FOO=1 /p/X.app/Contents/MacOS/X", "launchctl asuser 501 /p/X.app/Contents/MacOS/X",
  ])("denies %s", (c) => expect(r(c)).toBe(HEADLESS_DENY_MESSAGE));

  it.each([
    "swift build", "xcodebuild -scheme X build", "swift test", "swift plain.swift", "swiftc -o p plain.swift",
    "git log --oneline", "git log --open", "grep -n open file.txt", "swift missing.swift", "swift proc.swift",
    "lldb -p 123 -o bt", "lldb --batch -o \"image list\" ./mytool", "BIN=./mytool; \"$BIN\"",
  ])("allows %s", (c) => expect(r(c)).toBeNull());

  it("allows open outside a worker", () => expect(r("open report.pdf", {})).toBeNull());
});
