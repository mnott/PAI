/**
 * tool-call-rules-ops.ts — the operations behind `pai models rules`: list,
 * test, probe. Pure over a loaded RuleSet; the CLI supplies files and the
 * provider call.
 */

import { stringify as stringifyYaml } from "yaml";
import type { HitsFile } from "./tool-call-hits.js";
import { CLAUDE_CODE_TOOL_SCHEMAS } from "./tool-args-schemas.js";
import { MARKUP, missingRequired, parseToolCallText, repairToolInput, type ToolSchema, type ToolSchemas } from "./tool-args.js";
import { activeRules, type Rule, type RuleSet } from "./tool-call-rules.js";

export const DEFAULT_STALE_DAYS = 14;

export function claudeCodeSchemas(): ToolSchemas {
  return new Map(Object.entries(CLAUDE_CODE_TOOL_SCHEMAS));
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ---------------------------------------------------------------------------
// list

export interface RuleRow {
  id: string;
  kind: string;
  hits: number;
  last_hit: string;
  stale: boolean;
  state: string;
}

export function listRules(set: RuleSet, hits: HitsFile, staleDays: number, now: Date = new Date()): RuleRow[] {
  const cutoff = now.getTime() - staleDays * 86_400_000;
  const live = new Set(activeRules(set, now).map((r) => r.id));
  return set.rules.map((r) => {
    const h = hits[r.id];
    const since = h?.last_hit ? Date.parse(h.last_hit) : r.added ? Date.parse(r.added) : NaN;
    const state = r.disabled ? "disabled" : !live.has(r.id) ? "expired" : r.unconfirmed ? "unconfirmed" : "active";
    return { id: r.id, kind: r.kind, hits: h?.hits ?? 0, last_hit: h?.last_hit ?? "-", stale: Number.isFinite(since) ? since < cutoff : false, state };
  });
}

// ---------------------------------------------------------------------------
// test

export interface RuleTestRow {
  id: string;
  status: "ok" | "fail" | "redundant" | "no-example" | "skipped";
  detail?: string;
}

/** The repaired input an example yields under `rules`. */
export function runExample(rule: Rule, rules: readonly Rule[], schemas: ToolSchemas): Record<string, unknown> | null {
  const ex = rule.example;
  if (!ex) return null;
  const schema = schemas.get(ex.tool);
  if (!schema) return null;
  if (ex.text !== undefined) return parseToolCallText(ex.text, schemas, rules)?.calls[0]?.input ?? null;
  return repairToolInput(ex.input ?? {}, schema, rules).input;
}

/** Every example through all rules (must equal expect) and without its own rule (must differ). */
export function testRules(set: RuleSet, schemas: ToolSchemas = claudeCodeSchemas(), now: Date = new Date()): RuleTestRow[] {
  const all = activeRules(set, now);
  return set.rules.map((r): RuleTestRow => {
    if (!all.includes(r)) return { id: r.id, status: "skipped", detail: r.disabled ? "disabled" : "expired" };
    if (!r.example || !r.expect) return { id: r.id, status: "no-example" };
    if (!schemas.has(r.example.tool)) return { id: r.id, status: "fail", detail: `no schema for tool ${r.example.tool}` };
    const got = runExample(r, all, schemas);
    if (canon(got) !== canon(r.expect)) return { id: r.id, status: "fail", detail: `got ${canon(got)} expected ${canon(r.expect)}` };
    const without = runExample(r, all.filter((x) => x.id !== r.id), schemas);
    if (canon(without) === canon(r.expect)) return { id: r.id, status: "redundant", detail: "the example is repaired the same without this rule" };
    return { id: r.id, status: "ok" };
  });
}

// ---------------------------------------------------------------------------
// probe

export interface ProbeAnswer {
  status: number;
  /** A Messages API response body. */
  body: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
}

export interface Candidate {
  rule: string;
  round: number;
  reason: string;
  tool?: string;
  input?: unknown;
  text?: string;
}

export interface ProbeResult {
  rows: Array<{ id: string; probed: boolean; rounds: number; fired: number; state: "fired" | "never-fired" | "no-probe" }>;
  candidates: Candidate[];
  /** The adapted rules file (flattened, never-fired probed rules marked unconfirmed). */
  adapted: string;
}

const strip = (r: Rule) => {
  const { re: _re, file: _file, ...def } = r;
  void _re;
  void _file;
  return def;
};

/** Sends each rule's probe `rounds` times through `send` and reports which rules fired. */
export async function probeRules(
  set: RuleSet,
  rounds: number,
  send: (body: Record<string, unknown>) => Promise<ProbeAnswer>,
  now: Date = new Date()
): Promise<ProbeResult> {
  const all = activeRules(set, now);
  const rows: ProbeResult["rows"] = [];
  const candidates: Candidate[] = [];
  const firedIds = new Set<string>();
  for (const r of set.rules) {
    if (!r.probe?.tool) {
      rows.push({ id: r.id, probed: false, rounds: 0, fired: 0, state: "no-probe" });
      continue;
    }
    const tool = r.probe.tool;
    const schemas: ToolSchemas = new Map([[tool.name, { properties: (tool.input_schema.properties ?? {}) as ToolSchema["properties"], required: (tool.input_schema.required ?? []) as string[] }]]);
    let fired = 0;
    for (let round = 1; round <= rounds; round++) {
      let ans: ProbeAnswer;
      try {
        ans = await send({ max_tokens: 1024, tools: [tool], messages: [{ role: "user", content: r.probe.prompt }] });
      } catch (e) {
        candidates.push({ rule: r.id, round, reason: `request failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      if (ans.status !== 200) {
        candidates.push({ rule: r.id, round, reason: `status ${ans.status}` });
        continue;
      }
      const hits = new Set<string>();
      for (const c of ans.body.content ?? []) {
        if (c.type === "tool_use" && typeof c.name === "string" && c.input && typeof c.input === "object") {
          const schema = schemas.get(c.name);
          const res = repairToolInput(c.input as Record<string, unknown>, schema, all);
          res.hits.forEach((h) => hits.add(h));
          const left = JSON.stringify(res.input);
          if (MARKUP.test(left)) candidates.push({ rule: r.id, round, reason: "markup left in a value or name", tool: c.name, input: c.input });
          else if (missingRequired(res.input, schema).length) candidates.push({ rule: r.id, round, reason: `missing required: ${missingRequired(res.input, schema).join(",")}`, tool: c.name, input: c.input });
        } else if (c.type === "text" && c.text && MARKUP.test(c.text)) {
          const parsed = parseToolCallText(c.text, schemas, all);
          if (parsed) parsed.calls.forEach((p) => p.hits.forEach((h) => hits.add(h)));
          else candidates.push({ rule: r.id, round, reason: "tool-call markup in text that no rule parses", text: c.text });
        }
      }
      if (hits.has(r.id)) fired++;
      hits.forEach((h) => firedIds.add(h));
    }
    rows.push({ id: r.id, probed: true, rounds, fired, state: fired > 0 ? "fired" : "never-fired" });
  }
  const byId = new Map(rows.map((x) => [x.id, x]));
  const flat = set.rules.map((r) => {
    const def: Record<string, unknown> = strip(r);
    const row = byId.get(r.id);
    if (row?.probed) {
      if (row.fired > 0) delete def.unconfirmed;
      else def.unconfirmed = true;
    }
    return def;
  });
  const adapted =
    `# Adapted by \`pai models rules probe\` (${now.toISOString().slice(0, 10)}): rules that never fired in the probe carry unconfirmed: true and are kept.\n` +
    stringifyYaml({ version: set.version, rules: flat }, { lineWidth: 0 });
  return { rows, candidates, adapted };
}

export function candidatesText(c: readonly Candidate[]): string {
  return c.length
    ? c.map((x) => `[${x.rule} round ${x.round}] ${x.reason}\n${x.text !== undefined ? x.text : JSON.stringify({ tool: x.tool, input: x.input }, null, 2)}`).join("\n\n") + "\n"
    : "";
}
