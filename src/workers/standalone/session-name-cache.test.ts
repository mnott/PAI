import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_NAME_CACHE_TTL_MS, readSessionNameCache, sessionNameCachePath, writeSessionNameCache } from "./session-name-cache.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pai-snamecache-"));

describe("status-line session-name cache", () => {
  it("keys on the session identity, not on the cwd alone", () => {
    const dir = tmp();
    const a = sessionNameCachePath(dir, { ITERM_SESSION_ID: "w1t0p0:AAA" });
    const b = sessionNameCachePath(dir, { ITERM_SESSION_ID: "w1t0p0:BBB" });
    const c = sessionNameCachePath(dir, { CLAUDE_CODE_SESSION_ID: "cc-1" });
    expect(a && b && c && a !== b && a !== c).toBe(true);
    expect(a!.startsWith(join(dir, "session-name-"))).toBe(true);
    expect(a!.endsWith(".json")).toBe(true);
    expect(sessionNameCachePath(dir, {}, "")).toBeNull();
  });

  it("a fresh entry answers; a stale one and a broken file do not", () => {
    const dir = tmp();
    const p = join(dir, "e.json");
    writeSessionNameCache(p, "Broker Name");
    expect(readSessionNameCache(p)).toBe("Broker Name");
    writeSessionNameCache(p, "Broker Name", Date.now() - SESSION_NAME_CACHE_TTL_MS - 1);
    expect(readSessionNameCache(p)).toBeUndefined();
    writeFileSync(p, "not json");
    expect(readSessionNameCache(p)).toBeUndefined();
    expect(readSessionNameCache(join(dir, "missing.json"))).toBeUndefined();
    expect(readSessionNameCache(null)).toBeUndefined();
  });

  it("caches a nameless session too, so the scan is paid once per ttl", () => {
    const dir = tmp();
    const p = join(dir, "n.json");
    writeSessionNameCache(p, undefined);
    expect(JSON.parse(readFileSync(p, "utf8")).name).toBeNull();
    // undefined from the cache and a miss read the same; the point is the
    // file exists with a fresh stamp, so the next prompt skips the scan
    expect(readSessionNameCache(p)).toBeUndefined();
    expect(JSON.parse(readFileSync(p, "utf8")).at).toBeGreaterThan(Date.now() - 5_000);
  });

  it("a write into a missing logDir creates it; a null path writes nothing", () => {
    const dir = join(tmp(), "sub", "workers");
    const p = join(dir, "e.json");
    writeSessionNameCache(p, "x");
    expect(readSessionNameCache(p)).toBe("x");
    expect(() => writeSessionNameCache(null, "x")).not.toThrow();
  });
});
