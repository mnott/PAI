#!/usr/bin/env node
/**
 * replay-tool-args.mjs — replays the Strata raw logs through the tool-call
 * repair and prints what it did.
 *
 *   npx tsx scripts/replay-tool-args.mjs [DIR] [--rules FILE] [--quiet]
 *
 * DIR defaults to ~/.cache/pai/strata-raw (raw-*.jsonl: raw_text = what the
 * model wrote, emitted_tool_calls = the arguments the client received).
 *
 * Mode 1 (engine parsed): every emitted_tool_calls arguments object against
 * the Claude Code tool schemas (Bash, Read, Write, Edit, Grep, Glob with
 * their required lists); a call is broken when a name or value shows markup,
 * a typed parameter holds a string, a name is undeclared, or a required
 * parameter is missing. Prints broken calls before and after repair.
 *
 * Mode 2 (router parses): every raw_text holding tool-call markup through
 * parseToolCallText; reports how many become whole calls and, where the
 * engine emitted calls too, how many match the engine's repaired call.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_TOOL_SCHEMAS } from "../src/router/tool-args-schemas.ts";
import { MARKUP, missingRequired, parseToolCallText, repairToolInput } from "../src/router/tool-args.ts";
import { activeRules, loadRules, shippedRulesPath } from "../src/router/tool-call-rules.ts";

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const quiet = argv.includes("--quiet");
const dir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--rules") ?? join(homedir(), ".cache", "pai", "strata-raw");
const rules = activeRules(loadRules(flag("--rules") ?? shippedRulesPath()));
const schemas = new Map(Object.entries(CLAUDE_CODE_TOOL_SCHEMAS));

const typeOk = (t, v) => (t === "number" || t === "integer" ? typeof v === "number" : t === "boolean" ? typeof v === "boolean" : true);
/** Why a call is broken, or null. */
function brokenReason(name, input) {
  const schema = schemas.get(name);
  if (!schema) return null;
  for (const [k, v] of Object.entries(input)) {
    if (MARKUP.test(k) || /[<>]/.test(k)) return `name ${JSON.stringify(k)} has markup`;
    if (!(k in schema.properties)) return `undeclared parameter ${JSON.stringify(k)}`;
    if (typeof v === "string" && MARKUP.test(v)) return `${k}: markup in value`;
    if (!typeOk(schema.properties[k].type, v)) return `${k}: ${JSON.stringify(v).slice(0, 40)} is not ${schema.properties[k].type}`;
  }
  const miss = missingRequired(input, schema);
  return miss.length ? `missing required ${miss.join(",")}` : null;
}
const show = (v) => JSON.stringify(v).slice(0, 230);

const files = readdirSync(dir).filter((f) => /^raw-.*\.jsonl$/.test(f));
let calls = 0, before = 0, after = 0, changed = 0;
const ruleCounts = new Map();
let texts = 0, parsedWhole = 0, matchEngine = 0, supersetEngine = 0, engineBoth = 0, unparsed = 0;
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
/** the router's call carries everything the engine's call does (the engine may drop e.g. replace_all: false) */
const covers = (mine, eng) => mine.length === eng.length && mine.every((m, i) => m.name === eng[i].name && Object.entries(eng[i].input).every(([k, v]) => canon(m.input[k]) === canon(v)));
const unparsedSamples = [];
for (const f of files) {
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const emitted = row.emitted_tool_calls ?? [];
    for (const c of emitted) {
      calls++;
      const b = brokenReason(c.name, c.arguments);
      const r = repairToolInput(c.arguments, schemas.get(c.name), rules);
      const a = brokenReason(c.name, r.input);
      if (b) before++;
      if (a) after++;
      if (r.hits.length) changed++;
      for (const h of r.hits) ruleCounts.set(h, (ruleCounts.get(h) ?? 0) + 1);
      if (!quiet && (b || a)) console.log(`${a ? "STILL BROKEN" : "repaired"} ${row.id} ${c.name} [${r.hits.join(",")}]\n  before (${b ?? "ok"}): ${show(c.arguments)}\n  after  (${a ?? "ok"}): ${show(r.input)}`);
    }
    const text = row.raw_text ?? "";
    if (/<tool_call|<function=|<parameter=/.test(text)) {
      texts++;
      const p = parseToolCallText(text, schemas, rules);
      if (p) {
        parsedWhole++;
        if (emitted.length) {
          engineBoth++;
          const eng = emitted.map((e) => ({ name: e.name, input: repairToolInput(e.arguments, schemas.get(e.name), rules).input }));
          if (canon(eng) === canon(p.calls.map((e) => ({ name: e.name, input: e.input })))) matchEngine++;
          else if (covers(p.calls, eng)) supersetEngine++;
          else if (!quiet) console.log(`TEXT MISMATCH ${row.id}\n  engine+repair: ${show(eng)}\n  router parse : ${show(p.calls.map((e) => ({ name: e.name, input: e.input })))}`);
        }
      } else {
        unparsed++;
        if (unparsedSamples.length < 8) unparsedSamples.push(`${row.id} ${JSON.stringify(text.slice(0, 160))}`);
      }
    }
  }
}
console.log(`\nfiles: ${files.length}  rules: ${rules.length}`);
console.log(`mode 1 (engine parsed): calls ${calls}; broken before ${before}; broken after ${after}; calls changed by a rule ${changed}`);
console.log(`  rule hits: ${[...ruleCounts].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}=${n}`).join(" ")}`);
console.log(`mode 2 (router parses): answers with tool-call markup ${texts}; parsed into whole calls before 0 (no parser) after ${parsedWhole}; not parsed (falls back to retry) ${unparsed}`);
console.log(`  where the engine also emitted calls: ${engineBoth}; router parse equals the engine's call (after repair): ${matchEngine}; also carries extra keys the engine dropped: ${supersetEngine}; differs: ${engineBoth - matchEngine - supersetEngine}`);
for (const s of unparsedSamples) console.log(`  unparsed: ${s}`);
