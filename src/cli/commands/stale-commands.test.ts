import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUPS } from "../registry.js";
import { resolve } from "../run.js";
import { UsageError } from "../parse.js";

// Every `pai …` command that installed text tells the agent to run must exist on the CLI.
const ROOT = join(__dirname, "..", "..", "..");
const PROMPTS = join(ROOT, "src", "daemon-mcp", "prompts");
const FILES = [
  ...readdirSync(PROMPTS).filter((f) => f.endsWith(".ts")).map((f) => join(PROMPTS, f)),
  join(ROOT, "templates", "commands", "sessions.md"),
  join(ROOT, "src", "hooks", "ts", "session-start", "load-project-context.ts"),
];

/** `pai …` command lines: inline code spans, table cells and bare lines in code fences. */
export function extractPaiCommands(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split("\n")) {
    if (/^\s*\/\//.test(raw)) continue; // code comments tell history, not instructions
    const line = raw.replace(/\\`/g, "`");
    for (const m of line.matchAll(/`(pai [^`]+)`/g)) found.push(m[1]);
    const cell = line.match(/^\|\s*(pai [^|]+?)\s*\|/);
    if (cell) found.push(cell[1]);
    const bare = line.match(/^\s*(?:#\s*)?(pai [a-z"<][^`]*)$/);
    if (bare && !line.includes("`")) found.push(bare[1]);
  }
  return found.map((c) => c.trim());
}

function check(cmdline: string): string | null {
  const words = cmdline.split(/\s+/).slice(1);
  // `pai "<name>"` / `pai <name>` is the find-or-open shortcut; a bare word is a command and must exist.
  if (words[0]?.startsWith('"') || words[0]?.startsWith("<")) return null;
  try {
    const { cmd } = resolve(GROUPS, words.filter((w) => !w.startsWith("-") && !w.startsWith("<") && !w.startsWith('"')).slice(0, 3));
    const flags = words.filter((w) => w.startsWith("--")).map((w) => w.slice(2).split("=")[0]);
    const known = new Set([...(cmd.options ?? []).map((o) => o.name), "dry-run", "help"]);
    const bad = flags.find((f) => !known.has(f));
    return bad ? `unknown option --${bad}` : null;
  } catch (e) {
    if (e instanceof UsageError) return e.message;
    throw e;
  }
}

describe("installed text names only real pai commands", () => {
  it("extracts something from each source we care about", () => {
    const sessions = readFileSync(join(PROMPTS, "sessions.ts"), "utf8");
    expect(extractPaiCommands(sessions).length).toBeGreaterThan(5);
    expect(extractPaiCommands(readFileSync(join(ROOT, "templates", "commands", "sessions.md"), "utf8")).length).toBeGreaterThan(5);
  });

  it("the checker rejects the old stale commands", () => {
    for (const stale of ["pai search kw", "pai route proj", "pai route clear", "pai info 3", "pai session search"]) {
      expect(check(stale), stale).not.toBeNull();
    }
  });

  for (const file of FILES) {
    it(file.slice(ROOT.length + 1), () => {
      const bad = extractPaiCommands(readFileSync(file, "utf8"))
        .map((c) => [c, check(c)] as const)
        .filter(([, err]) => err !== null);
      expect(bad).toEqual([]);
    });
  }
});
