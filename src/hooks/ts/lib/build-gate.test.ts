import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateReason, loadBuildsConfig, parseBuildsYaml } from "./build-gate.js";
import { doctor } from "../../../builds/doctor.js";

const project = (doors: string, scripts: Record<string, string> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "pai-bg-"));
  mkdirSync(join(root, ".pai"));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, ".pai", "builds.yaml"), doors);
  for (const [n, body] of Object.entries(scripts)) writeFileSync(join(root, n), body);
  return root;
};

describe("build gate", () => {
  const none = null;
  it("denies raw heavy builders", () => {
    for (const c of [
      "xcodebuild -scheme App build",
      "cd x && xcodebuild test 2>&1 | tail",
      "xcrun simctl boot iPhone",
      "swift build",
      "swift test --parallel",
      "./gradlew assembleDebug",
      "gradle test",
      "cargo build --release",
      "FOO=1 time cargo test",
      "bash -c 'xcodebuild build'",
    ])
      expect(buildGateReason(c, "/tmp", none), c).toContain("machine-wide queue");
  });
  it("allows pai build run, light commands and mentions", () => {
    for (const c of [
      "pai build run -- xcodebuild -scheme App build",
      "pai build run --full -- cargo build",
      "xcodebuild -version",
      "echo xcodebuild",
      "grep -r xcodebuild docs",
      "swift --version",
      "cargo fmt",
      "git status",
    ])
      expect(buildGateReason(c, "/tmp", none), c).toBeNull();
  });
  it("allows a registered door and project patterns deny", () => {
    const root = project("doors: [tools/build.sh]\npatterns:\n  - '^make ios'\n");
    expect(loadBuildsConfig(join(root, "tools"))?.doors).toEqual(["tools/build.sh"]);
    expect(buildGateReason("tools/build.sh --scheme X", root)).toBeNull();
    expect(buildGateReason("./tools/build.sh", root)).toBeNull();
    expect(buildGateReason("bash tools/build.sh", root)).toBeNull();
    expect(buildGateReason("tools/other.sh && xcodebuild build", root)).toContain("door tools/build.sh");
    expect(buildGateReason("make ios-test", root)).toContain("pattern");
  });
  it("parses flow and block lists", () => {
    expect(parseBuildsYaml("doors: [a.sh, 'b.sh']\npatterns:\n  - x # c\n  - y")).toEqual({ doors: ["a.sh", "b.sh"], patterns: ["x", "y"] });
  });
  it("a door without pai build lock is allowed by the guard but flagged by doctor", () => {
    const root = project("doors: [tools/bad.sh, tools/good.sh, tools/gone.sh]\n", {
      "tools/bad.sh": "#!/bin/sh\nxcodebuild build\n",
      "tools/good.sh": "#!/bin/sh\npai build lock -- xcodebuild build\n",
    });
    expect(buildGateReason("tools/bad.sh", root)).toBeNull();
    const r = doctor(root);
    expect(r.findings.map((f) => [f.door, f.ok])).toEqual([["tools/bad.sh", false], ["tools/good.sh", true], ["tools/gone.sh", false]]);
  });
});
