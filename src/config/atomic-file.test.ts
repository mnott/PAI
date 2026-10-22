import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const crash = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: ((p: string, d: string, o?: unknown) => {
      if (crash.on) {
        actual.writeFileSync(p, String(d).slice(0, 3));
        throw new Error("crash mid-write");
      }
      return actual.writeFileSync(p, d, o as never);
    }) as typeof actual.writeFileSync,
  };
});

import { writeFileAtomic } from "./atomic-file.js";
import { recordEmbedPass, readEmbedPasses } from "../memory/embed-pass.js";

afterEach(() => { crash.on = false; });

describe("writeFileAtomic", () => {
  it("a crash mid-write leaves the old file intact and no temp behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const f = join(dir, "state.json");
    writeFileAtomic(f, '{"old":true}');
    crash.on = true;
    expect(() => writeFileAtomic(f, '{"new":true,"long":"payload"}')).toThrow("crash mid-write");
    expect(readFileSync(f, "utf8")).toBe('{"old":true}');
    expect(readdirSync(dir)).toEqual(["state.json"]);
    rmSync(dir, { recursive: true });
  });

  it("recordEmbedPass keeps the earlier passes when the write crashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const f = join(dir, "embed-passes.json");
    recordEmbedPass({ start: 0, end: 1, embedded: 1, backlogLeft: 0, stopReason: "done" }, f);
    crash.on = true;
    recordEmbedPass({ start: 1, end: 2, embedded: 2, backlogLeft: 0, stopReason: "done" }, f);
    crash.on = false;
    expect(readEmbedPasses(f)).toHaveLength(1);
    rmSync(dir, { recursive: true });
  });
});

