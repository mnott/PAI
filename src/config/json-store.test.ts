/**
 * Tests for the shared JSON store.
 *
 * The shape these guard against appeared three times in this repo against three
 * different files: ~/.claude.json, ~/.config/pai/config.json and
 * ~/.claude/settings.json. Each read returned {} on a parse failure, and the
 * following write made that permanent.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonStrict, writeJsonAtomic } from "./json-store.js";

const dir = mkdtempSync(join(tmpdir(), "pai-json-store-"));
const FILE = join(dir, "config.json");
const BAK = `${FILE}.bak-pai`;

const POPULATED = JSON.stringify({ a: 1, b: 2, nested: { keep: true } }, null, 2);

describe("readJsonStrict", () => {
  beforeEach(() => {
    for (const f of [FILE, BAK]) if (existsSync(f)) unlinkSync(f);
  });

  it("treats a missing file as a first run", () => {
    expect(readJsonStrict(FILE)).toEqual({});
  });

  it("throws rather than returning {} when the file is damaged", () => {
    writeFileSync(FILE, "{ not json");
    expect(() => readJsonStrict(FILE)).toThrow(/not valid JSON/i);
  });

  it("names the file in the error so the user knows what to repair", () => {
    writeFileSync(FILE, "{ not json");
    expect(() => readJsonStrict(FILE, "~/.config/pai/config.json")).toThrow(
      /~\/\.config\/pai\/config\.json/
    );
  });
});

describe("writeJsonAtomic", () => {
  beforeEach(() => {
    for (const f of [FILE, BAK]) if (existsSync(f)) unlinkSync(f);
  });

  it("keeps a backup of the previous contents", () => {
    writeFileSync(FILE, POPULATED);
    writeJsonAtomic(FILE, { replaced: true });
    expect(JSON.parse(readFileSync(BAK, "utf8"))).toEqual({ a: 1, b: 2, nested: { keep: true } });
  });

  it("leaves no temp file behind", () => {
    writeFileSync(FILE, POPULATED);
    writeJsonAtomic(FILE, { ok: 1 });
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-pai-"))).toHaveLength(0);
  });

  it("supports skipping the backup for transient data", () => {
    // Deliberate: for a message queue or cache, starting fresh is the correct
    // recovery. Refusing to write there would disable the feature permanently.
    writeFileSync(FILE, POPULATED);
    writeJsonAtomic(FILE, { queue: [] }, { backup: false });
    expect(existsSync(BAK)).toBe(false);
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual({ queue: [] });
  });

  it("creates the parent directory when absent", () => {
    const nested = join(dir, "deep", "nested", "config.json");
    writeJsonAtomic(nested, { created: true });
    expect(JSON.parse(readFileSync(nested, "utf8"))).toEqual({ created: true });
  });
});

describe("the original data-loss path, generically", () => {
  it("read-then-write cannot replace a damaged file", () => {
    writeFileSync(FILE, "{ corrupt");
    expect(() => {
      const cfg = readJsonStrict(FILE);
      cfg.ours = true;
      writeJsonAtomic(FILE, cfg);
    }).toThrow();
    expect(readFileSync(FILE, "utf8")).toBe("{ corrupt");
  });
});
