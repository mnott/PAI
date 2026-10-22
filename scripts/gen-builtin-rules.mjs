#!/usr/bin/env node
/**
 * Generate src/hooks/ts/lib/rules/builtin.generated.ts from the YAML files in
 * src/hooks/ts/lib/rules/builtin/.
 *
 * Hooks are bundled into single self-contained .mjs files by
 * scripts/build-hooks.mjs, so the built-in rules cannot ship as loose YAML
 * next to the bundle: they are embedded here as a generated TS module. Run
 * from the repo root; add to the build before build-hooks.mjs.
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const SRC_DIR = "src/hooks/ts/lib/rules/builtin";
const OUT = "src/hooks/ts/lib/rules/builtin.generated.ts";

/**
 * Shared building blocks, written {{NAME}} in a rule's `match`. Expanded here
 * so the yaml stays readable and every rule spells command position, prefix
 * wrappers, absolute-path binaries and shell sinks the same way.
 * Every piece is unambiguous (tokens are delimited by whitespace) so none of
 * them backtracks super-linearly; see docs/concepts/security-rules.md.
 */
const MACROS = {
  // an absolute path or backslash prefix on a binary: /bin/rm, \rm
  BIN: String.raw`(?:\\|\/[^\s;&|"']*\/)?`,
  PIPE: String.raw`\|(?!\|)&?`,
  SHELLNAME: String.raw`(?:(?:ba|z|da|k|fi|c|tc)?sh)`,
};
// prefix wrappers: command env exec nohup time builtin, sudo/doas/nice/xargs with flags, VAR=val
MACROS.WRAP = String.raw`(?:(?:(?:\\|\/[^\s;&|"']*\/)?(?:command|env|exec|nohup|time|builtin|sudo|doas|nice|xargs|stdbuf)(?:\s+-[^\s;&|]+(?:\s+\d+(?=\s))?)*|[A-Za-z_]\w*=[^\s;&|]*)\s+)*`;
// command position: line start, after ; & | ( { ` $(, after then/do/else, or inside sh -c "
MACROS.CMDPOS = String.raw`(?:^|[;&|(\`\n{]|\$\(|\b(?:then|do|else)\s|\b(?:ba|z|da)?sh\s+-\w*c\s+["'])`;
// command position + wrappers + optional path + optional $ (from $'rm'); the binary name follows
MACROS.CMD = `${MACROS.CMDPOS}\\s*${MACROS.WRAP}${MACROS.BIN}\\$?`;
// a git command at the start of a (trimmed) segment, wrappers allowed
MACROS.GIT = String.raw`^\s*(?:(?:then|do|else|[{(!])\s*)*${MACROS.WRAP}${MACROS.BIN}git`;
MACROS.SHELL = String.raw`\(?\s*${MACROS.WRAP}${MACROS.BIN}${MACROS.SHELLNAME}(?![\w-])`;
MACROS.SHELL_OR_INTERP = String.raw`\(?\s*${MACROS.WRAP}${MACROS.BIN}(?:${MACROS.SHELLNAME}|python[\d.]*|perl|ruby|node)(?![\w-])`;
// a base64/hex decoder invocation: base64 -d/-D/--decode, xxd -r, openssl base64 -d
MACROS.B64DEC = String.raw`(?:base64\s+(?:-\w+\s+)*?(?:-d|-D|--decode)|xxd\s+(?:-\w+\s+)*?-r|openssl\s+(?:enc\s+)?-?base64\s+(?:-\w+\s+){0,3}-d)(?![\w-])`;
// a recursive rm up to the start of one target argument (bounded token counts, no nested stars)
MACROS.RMREC = String.raw`${MACROS.CMD}rm(?=\s)(?:\s+[^\s;&|]+){0,16}?\s+(?:-\w*[rR]\w*|--recursive)(?=\s)(?:\s+[^\s;&|]+){0,16}?\s+["']?`;
// the end of that target: a closing quote, separator, close paren, backtick or end
MACROS.ARGEND = String.raw`["']?(?=[\s;&|)"'\`]|$)`;
const expand =(src) => {
  let out = src;
  for (let i = 0; i < 4; i++) out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, k) => MACROS[k] ?? all);
  return out;
};

const names = readdirSync(SRC_DIR).filter((f) => f.endsWith(".rule.yaml")).sort();
const rules = [];
for (const name of names) {
  const doc = parse(readFileSync(join(SRC_DIR, name), "utf8"));
  const items = Array.isArray(doc) ? doc : [doc];
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") {
      console.error(`✖ ${name}: not a rule mapping`);
      process.exit(1);
    }
    // A bare YAML regex node serialises as /src/flags; split it like load.ts does.
    const splitRegex = (v) => {
      const s = typeof v === "string" ? v : "";
      const node = s.length > 2 && s.startsWith("/") && /\/[a-z]*$/.test(s);
      return node ? { source: s.slice(1, s.lastIndexOf("/")), tail: s.slice(s.lastIndexOf("/") + 1) } : { source: s, tail: "" };
    };
    const m = typeof item.match === "string" ? expand(item.match) : "";
    const regexNode = m.length > 2 && m.startsWith("/") && /\/[a-z]*$/.test(m);
    const flags = typeof item.flags === "string" ? item.flags : regexNode ? m.slice(m.lastIndexOf("/") + 1) : "";
    // Sequence steps carry their own regex nodes; split them the same way.
    if (item.sequence && Array.isArray(item.sequence.steps)) {
      item.sequence.steps = item.sequence.steps.map((step) => {
        if (!step || typeof step !== "object") return step;
        const sp = splitRegex(step.match);
        return { ...step, match: sp.source, flags: typeof step.flags === "string" ? step.flags : sp.tail || undefined };
      });
    }
    // NEW-SPLIT-MARKER
    // A YAML scalar containing a colon parses as a mapping, not a string:
    // re-quote it so fixtures stay strings.
    const fix = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v);
    const tests = item.tests
      ? { match: (item.tests.match ?? []).map(fix), no_match: (item.tests.no_match ?? []).map(fix) }
      : undefined;
    rules.push({
      ...item,
      tests,
      match: regexNode ? m.slice(1, m.lastIndexOf("/")) : m,
      flags: flags || undefined,
      source: `builtin/${name}`,
    });
    // a sequence rule carries no top-level match
    if (item.sequence) delete rules[rules.length - 1].match;
  }
}

const header =
  "// GENERATED by scripts/gen-builtin-rules.mjs — edit the YAML files under\n" +
  "// src/hooks/ts/lib/rules/builtin/ instead, then re-run the script.\n" +
  "import type { LoadedRule } from \"./types.js\";\n\n" +
  "export const BUILTIN_RULES: LoadedRule[] = ";

writeFileSync(OUT, header + JSON.stringify(rules, null, 2) + ";\n");
console.log(`✔ ${rules.length} builtin rules embedded in ${OUT}`);
