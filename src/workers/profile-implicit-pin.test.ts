import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile, readProfiles, updateProfile } from "./session-profile.js";
import { clearImplicitLaunchPins, implicitPinProfiles, looksImplicitLaunchPin, repairReport, repairSessionProfile } from "./profile-implicit-pin.js";

vi.mock("../cli/impl/detect.js", () => ({
  detectProject: vi.fn(async (cwd?: string) => (cwd === "/repo/pai" ? { slug: "pai", display_name: "PAI" } : cwd === "/repo/other" ? { slug: "other", display_name: "Other" } : null)),
}));

const launchPin = { chat: { provider: "anthropic", model: "opus" }, workers: { provider: "anthropic" } };

describe("looksImplicitLaunchPin", () => {
  it("the launch shape: chat provider = workers provider, no models, no fallback", () => {
    expect(looksImplicitLaunchPin(launchPin)).toBe(true);
  });
  it("an explicit choice is not the launch shape", () => {
    expect(looksImplicitLaunchPin({ chat: { provider: "anthropic", model: "opus" }, workers: { provider: "kimi" } })).toBe(false);
    expect(looksImplicitLaunchPin({ chat: { provider: "anthropic", model: "opus" }, workers: { provider: "anthropic", model: "fast" } })).toBe(false);
    expect(looksImplicitLaunchPin({ chat: { provider: "anthropic", model: "sonnet" }, workers: { provider: "anthropic" } })).toBe(true);
    expect(looksImplicitLaunchPin({ chat: { provider: "anthropic" }, workers: { provider: "anthropic" }, fallback: [{ provider: "glm" }] })).toBe(false);
    expect(looksImplicitLaunchPin({ workers: { provider: "anthropic" } })).toBe(false);
  });
});

describe("clearImplicitLaunchPins (temp store)", () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "implicit-pin-")), "session-profiles.yaml");
  });

  it("clears launch-shaped pins, keeps every other part, leaves explicit pins alone", () => {
    updateProfile("PAI", launchPin, path);
    updateProfile("AIBroker", launchPin, path);
    updateProfile("Jobs", { ...launchPin, workers: { provider: "kimi", model: "fast" }, fallback: [{ provider: "glm" }], parallel_min: 2 }, path);
    updateProfile("Untwitter", { chat: { provider: "anthropic", model: "opus" }, workers: { provider: "flashnext-iq3" } }, path);

    expect(implicitPinProfiles(readProfiles(path)).map((r) => r.name)).toEqual(["PAI", "AIBroker"]);
    expect(clearImplicitLaunchPins(path)).toEqual(["PAI", "AIBroker"]);

    expect(getProfile("PAI", path)).toEqual({ chat: { provider: "anthropic", model: "opus" } });
    expect(getProfile("AIBroker", path)).toEqual({ chat: { provider: "anthropic", model: "opus" } });
    expect(getProfile("Jobs", path)?.workers).toEqual({ provider: "kimi", model: "fast" });
    expect(getProfile("Untwitter", path)?.workers).toEqual({ provider: "flashnext-iq3" });
    expect(readFileSync(path, "utf8")).not.toContain("workers_implicit");
  });

  it("a marked pin is listed and cleared too", () => {
    updateProfile("PAI", { chat: launchPin.chat, workers: { provider: "anthropic" }, workers_implicit: true }, path);
    expect(implicitPinProfiles(readProfiles(path)).map((r) => r.name)).toEqual(["PAI"]);
    expect(clearImplicitLaunchPins(path)).toEqual(["PAI"]);
    expect(getProfile("PAI", path)?.workers).toBeUndefined();
  });
});

describe("repairSessionProfile (this repo's named session only)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "repair-home-"));
    vi.stubEnv("PAI_HOME", home);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("clears only the named session of this cwd and reports the others", async () => {
    updateProfile("PAI", launchPin);
    updateProfile("AIBroker", launchPin);
    const cleared = await repairSessionProfile("/repo/pai");
    expect(cleared).toEqual(["PAI"]);
    expect(getProfile("PAI")?.workers).toBeUndefined();
    expect(getProfile("AIBroker")?.workers).toEqual({ provider: "anthropic" });
    const report = repairReport(cleared, readProfiles());
    expect(report).toContain("cleared the launch-written workers pin: PAI");
    expect(report).toContain("left alone (not this session's): AIBroker (workers anthropic)");
    expect(report).toContain('pai session profile clear --workers --name "<name>"');
  });

  it("a cwd whose project is not named PAI clears nothing", async () => {
    updateProfile("PAI", launchPin);
    expect(await repairSessionProfile("/repo/other")).toEqual([]);
    expect(getProfile("PAI")?.workers).toEqual({ provider: "anthropic" });
  });

  it("an unregistered cwd clears nothing", async () => {
    updateProfile("PAI", launchPin);
    expect(await repairSessionProfile("/nowhere")).toEqual([]);
    expect(getProfile("PAI")?.workers).toEqual({ provider: "anthropic" });
  });

  it("an explicit PAI pin is left alone", async () => {
    updateProfile("PAI", { chat: launchPin.chat, workers: { provider: "kimi" } });
    expect(await repairSessionProfile("/repo/pai")).toEqual([]);
    expect(getProfile("PAI")?.workers).toEqual({ provider: "kimi" });
  });
});
