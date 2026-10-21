import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GROUPS } from "./registry.js";
import { areasOf } from "./docgen.js";

const ROOT = resolve(__dirname, "..", "..");
const DEFAULTS = join(ROOT, "src", "config", "defaults");

const mdIn = (dir: string) =>
  existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : [];

const FILES = [
  "README.md",
  "docs/README.md",
  ...mdIn("docs/install"),
  ...mdIn("docs/concepts"),
  "docs/cockpit.md",
  ...["memory", "search", "observations", "zettelkasten", "session-management", "session-notes", "context-preservation", "auto-compact", "pai-home", "skills", "task-bus", "rules-and-privacy", "what-you-can-ask", "use-cases"].map((n) => `docs/${n}.md`),
  "MANUAL.md",
  "docs/config.md",
  "docs/config-defaults.md",
  "docs/workers-config.md",
  "plugins/core/skills/setup/SKILL.md",
].filter((f) => existsSync(join(ROOT, f)));

/** Keys documented as user-only: absent from the shipped defaults on purpose. Each needs a reason. */
const ALLOWED_KEYS: Record<string, string> = {
  "models.consumers": "user-supplied list of local-model consumers; no shipped entries",
  "models.labels": "user-supplied display names for runtimes and models",
  "models.fast": "per-provider model slot (providers.<name>.models), named in prose",
  "models.default": "per-provider model slot (providers.<name>.models), named in prose",
  "router.cockpit.sections": "optional user list of cockpit section ids; unset shows all",
  "postgres.connectionString": "derived per user at load time, never in the defaults",
  "providers.<name>.model_tiers": "optional per-provider map, absent unless a user sets it",
};

const FILE_EXT = new Set(["yaml", "yml", "json", "md", "ts", "js", "mjs", "sh"]);

const load = (f: string): unknown => parse(readFileSync(join(DEFAULTS, f), "utf8"));
const ROOTS = [load("config.yaml"), load("workers.yaml")] as Record<string, unknown>[];
const TOP = new Set(ROOTS.flatMap((r) => Object.keys(r)));

function resolves(root: unknown, segs: string[]): boolean {
  if (segs.length === 0) return true;
  if (root === null || typeof root !== "object" || Array.isArray(root)) return false;
  const obj = root as Record<string, unknown>;
  const [head, ...rest] = segs;
  if (head === "*" || /^<.*>$/.test(head)) {
    const vals = Object.values(obj);
    // A free-form map (empty in the defaults) accepts any child.
    return vals.length === 0 || vals.some((v) => resolves(v, rest));
  }
  if (Object.keys(obj).length === 0) return true;
  return head in obj && resolves(obj[head], rest);
}

function commandExists(words: string[]): boolean {
  const top = areasOf(GROUPS).find((c) => c.name === words[0]);
  if (!top) return false;
  const sub = words[1];
  if (!sub || !top.subcommands?.length) return true;
  return top.subcommands.some((s) => s.name === sub);
}

interface Miss { where: string; what: string }

function scan(): Miss[] {
  const misses: Miss[] = [];
  for (const f of FILES) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const span = m[1].trim();
        const where = `${f}:${i + 1}`;
        const key = span.match(/^([A-Za-z_][\w-]*(?:\.(?:[\w-]+|\*|<[^>]+>))+)(?:\s*[:=].*)?$/);
        if (key && !FILE_EXT.has(key[1].split(".").pop()!) && TOP.has(key[1].split(".")[0]) && !(key[1] in ALLOWED_KEYS)) {
          const segs = key[1].split(".");
          if (!ROOTS.some((r) => resolves(r, segs))) misses.push({ where, what: `key ${key[1]}` });
          continue;
        }
        const cmd = span.match(/^pai\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/);
        if (cmd) {
          const words = [cmd[1], cmd[2]].filter((w): w is string => !!w);
          if (!commandExists(words)) misses.push({ where, what: `command ${span}` });
        }
      }
    });
  }
  return misses;
}

describe("hand-written docs name only config keys and commands that exist", () => {
  it("every documented key and `pai` command resolves", () => {
    const misses = scan();
    const report = misses.map((m) => `${m.where} ${m.what}`).join("\n");
    if (report) console.log(`docs-keys misses:\n${report}`);
    expect(misses.map((m) => `${m.where} ${m.what}`), "stale references in the docs").toEqual([]);
  });
});
