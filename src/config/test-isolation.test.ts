import { describe, it, expect, afterEach } from "vitest";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeYamlFileAtomic } from "./yaml-store.js";
import { writeJsonAtomic } from "./json-store.js";
import { writeClaudeJson } from "./claude-json.js";
import { routeNotification, recordedNotifications, setTestProviders } from "../notifications/router.js";
import type { NotificationConfig } from "../notifications/types.js";

const live = join(userInfo().homedir, ".claude", "pai");

describe("test isolation: config writers", () => {
  it("refuses the real PAI home under vitest", () => {
    expect(() => writeYamlFileAtomic(join(live, "config.yaml"), "a: 1\n")).toThrow(/test-isolation/);
    expect(() => writeYamlFileAtomic(join(live, "workers.yaml"), "a: 1\n")).toThrow(/test-isolation/);
    expect(() => writeJsonAtomic(join(live, "config.json"), { a: 1 })).toThrow(/test-isolation/);
  });
  it("refuses the real ~/.claude.json even with a redirected HOME", () => {
    const real = join(userInfo().homedir, ".claude.json");
    expect(() => writeJsonAtomic(real, { a: 1 })).toThrow(/test-isolation/);
  });
  it("writes to a temp path", () => {
    const p = join(mkdtempSync(join(tmpdir(), "pai-iso-")), "config.yaml");
    writeYamlFileAtomic(p, "a: 1\n");
    expect(readFileSync(p, "utf8")).toBe("a: 1\n");
  });
  it("writeClaudeJson targets the sandbox HOME, not the real one", () => {
    expect(() => writeClaudeJson({ x: 1 })).not.toThrow();
  });
});

describe("test isolation: notifications", () => {
  afterEach(() => setTestProviders(null));
  const config = { mode: "whatsapp", channels: {}, routing: {} } as unknown as NotificationConfig;
  const payload = { event: "info", message: "m" } as never;

  it("records instead of dispatching", async () => {
    recordedNotifications.length = 0;
    const r = await routeNotification(payload, config);
    expect(r.channelsAttempted).toEqual([]);
    expect(recordedNotifications).toHaveLength(1);
  });
  it("uses an injected fake sender", async () => {
    let called = 0;
    setTestProviders({ whatsapp: { send: async () => (called++, true) } as never });
    const r = await routeNotification(payload, config);
    expect(called).toBe(1);
    expect(r.channelsSucceeded).toEqual(["whatsapp"]);
  });
});
