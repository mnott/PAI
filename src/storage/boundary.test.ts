/**
 * Storage boundary enforcement (design doc docs/design/postgres-only.md, unit
 * 7 — "the final gate, not something to add early and skip"). Every file
 * under src/ except *.test.ts and src/storage/** must never touch a SQLite/
 * Postgres driver, a *.db path, or a raw-handle opener directly — all DB
 * access goes through src/storage/'s StorageBackend/RegistryBackend.
 *
 * Unconditional bans (no file outside src/storage/** decides which backend
 * is used or runs SQL, whether or not it also reaches for a raw handle):
 * getPool(, PgPoolLike, backendType ===/!== comparisons, .query( on anything
 * pool-like, and raw SQL string literals.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..");

/** DB-opening helpers exported from src/storage/ that return raw handles or paths. */
const BANNED_IDENTIFIERS = [
  "openFederation",
  "openRegistry",
  "federationDbPath",
  "registryDbPath",
  "oldFederationPath",
  "oldRegistryPath",
  // Raw-handle escape hatches. getRawDb() is fine *inside* src/storage/ (e.g.
  // db-admin.ts, the one sanctioned `pai db query` admin path) — this test
  // only ever scans files outside storage/, so any hit here is a leak.
  "getRawDb",
  "getSqliteDb",
  // Unconditional: no file outside src/storage/ decides which backend is
  // used or runs SQL — getPool()/PgPoolLike are only legitimate inside a
  // StorageBackend implementation.
  "getPool",
  "PgPoolLike",
];

/**
 * SQL keywords that mark a string/template literal as raw SQL text.
 * Case-sensitive: every real SQL statement in this codebase is written in
 * upper case ("SELECT", "INSERT INTO", …), so this never fires on ordinary
 * English prose ("select a project", "let me query…") inside comments or
 * user-facing strings, which a case-insensitive match would.
 */
const SQL_KEYWORD_RE = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/;

/** `.query(` on anything pool-like — only legitimate inside src/storage/. */
const POOL_QUERY_RE = /\.query\s*\(/;

interface Violation {
  file: string;
  line: number;
  reason: string;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(absPath: string): Violation[] {
  const rel = relative(SRC_ROOT, absPath).split("\\").join("/");
  const text = readFileSync(absPath, "utf-8");
  const lines = text.split("\n");
  const violations: Violation[] = [];

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    if (/from\s+["']better-sqlite3["']/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: 'import of "better-sqlite3"' });
    }
    if (/from\s+["']pg["']/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: 'import of "pg"' });
    }
    if (line.includes("federation.db")) {
      violations.push({ file: rel, line: lineNo, reason: 'string literal "federation.db"' });
    }
    if (line.includes("registry.db")) {
      violations.push({ file: rel, line: lineNo, reason: 'string literal "registry.db"' });
    }
    if (/\bnew\s+Pool\s*\(/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: "new Pool(" });
    }
    if (/\bnew\s+Database\s*\(/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: "new Database(" });
    }
    if (/\.prepare\s*\(/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: ".prepare( call" });
    }
    if (/as any\)\s*\.\s*get\w*/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: "(x as any).<backend internal> cast" });
    }
    for (const ident of BANNED_IDENTIFIERS) {
      const re = new RegExp(`\\b${ident}\\b`);
      if (re.test(line) && !/\.prepare\s*\(/.test(line) && !/as any\)/.test(line)) {
        violations.push({ file: rel, line: lineNo, reason: `use of ${ident}` });
      }
    }
    // Unconditional — not just in files that already reach a raw handle:
    // no non-storage file decides which backend is used or runs SQL itself.
    if (/backendType\s*(===|!==)/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: "backendType ===/!== comparison" });
    }
    if (SQL_KEYWORD_RE.test(line) && /["'`]/.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: "raw SQL keyword in string literal" });
    }
    if (POOL_QUERY_RE.test(line)) {
      violations.push({ file: rel, line: lineNo, reason: ".query( call on a pool-like object" });
    }
  });

  return violations;
}

function scanShellHooks(): Violation[] {
  const hooksDir = join(SRC_ROOT, "hooks");
  const violations: Violation[] = [];
  for (const entry of readdirSync(hooksDir)) {
    if (!entry.endsWith(".sh")) continue;
    const full = join(hooksDir, entry);
    const rel = relative(SRC_ROOT, full);
    const lines = readFileSync(full, "utf-8").split("\n");
    lines.forEach((line, i) => {
      if (/\bsqlite3\b/.test(line)) {
        violations.push({ file: rel, line: i + 1, reason: "sqlite3 CLI invocation" });
      }
      if (/\bpsql\b/.test(line)) {
        violations.push({ file: rel, line: i + 1, reason: "psql CLI invocation" });
      }
    });
  }
  return violations;
}

describe("storage boundary", () => {
  it("no file outside src/storage/** touches a SQLite/Postgres driver, *.db path, or raw opener", () => {
    const allTsFiles = walkTsFiles(SRC_ROOT);
    const scanned = allTsFiles.filter((f) => {
      const rel = relative(SRC_ROOT, f).split("\\").join("/");
      return !rel.startsWith("storage/");
    });

    const violations = scanned.flatMap(scanFile);

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — ${v.reason}`)
        .join("\n");
      expect.fail(`Storage boundary violations:\n${report}`);
    }

    expect(violations).toEqual([]);
  });

  it("no hook shell script shells out to sqlite3 or psql directly", () => {
    const violations = scanShellHooks();

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — ${v.reason}`)
        .join("\n");
      expect.fail(`Storage boundary violations (hooks):\n${report}`);
    }

    expect(violations).toEqual([]);
  });
});
