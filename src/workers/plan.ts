/**
 * plan.ts — the plan file of `pai plan run`: parse, validate, compose specs.
 *
 * A plan is YAML (see docs/plan-runner.md). Pure functions only; reading the
 * file and the spec files is the caller's job except `loadPlan`, which does
 * both and resolves relative paths against the plan's directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface PlanPart {
  id: string;
  unit: string;
  /** Spec text, preamble(s) already prepended. */
  spec: string;
  files: string[];
  proof?: string;
  dependsOn: string[];
  risky: boolean;
}

export interface PlanUnit {
  id: string;
  unitCheck?: string;
  parts: PlanPart[];
}

export interface Plan {
  job: string;
  repo: string;
  gate: string;
  provider: string;
  /** Explicit max_parallel; undefined = the provider's maxConcurrent. */
  maxParallel?: number;
  units: PlanUnit[];
}

/** JSON-schema-like description of the plan file; `pai plan validate` enforces it. */
export const PLAN_SCHEMA = {
  type: "object",
  required: ["job", "repo", "gate", "provider", "units"],
  properties: {
    job: "string — job name, the prefix of every worker label",
    repo: "string — path of the git checkout the workers change (relative to the plan file)",
    gate: "string — shell command run on the merged tree; a failure reverts the merge",
    provider: "string — local provider the parts run on (--class implement)",
    max_parallel: "integer >= 1 — parts running at once (default: the provider's maxConcurrent, else 3)",
    preamble: "string — text or file path prepended to every part spec",
    units: {
      type: "array",
      minItems: 1,
      items: {
        required: ["id", "parts"],
        properties: {
          id: "string — unit name",
          preamble: "string — text or file path prepended to this unit's part specs (after the plan preamble)",
          unit_check: "string — command run after the unit's last part merged; failure = needs-decision",
          parts: {
            type: "array",
            minItems: 1,
            items: {
              required: ["id", "spec"],
              properties: {
                id: "string — unique in the whole plan",
                spec: "string — task text, or a path to a file holding it",
                files: "string[] — paths the part touches; parts sharing a file never run together",
                proof: "string — command the worker must run and show passing",
                depends_on: "string[] — part ids (any unit) that must be merged first",
                risky: "boolean — documented intent for review; shown in the schedule",
              },
            },
          },
        },
      },
    },
  },
} as const;

export class PlanError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `text` as given, or the content of the file it names (single line naming an existing file). */
function textOrFile(value: string, baseDir: string): string {
  const v = value.trim();
  if (v && !v.includes("\n")) {
    const p = isAbsolute(v) ? v : resolve(baseDir, v);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8").trim();
      } catch {
        /* a directory or unreadable file: keep the text */
      }
    }
  }
  return v;
}

/** A spec value that looks like a path (no spaces, has an extension or slash) but names no file. */
function missingFile(value: string, baseDir: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  if (!/[\\/]|\.(md|txt|spec)$/.test(v)) return false;
  return !existsSync(isAbsolute(v) ? v : resolve(baseDir, v));
}

function strList(v: unknown, where: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) {
    problems.push(`${where}: must be a list of non-empty strings`);
    return [];
  }
  return v as string[];
}

/** Parse and validate plan text. Throws PlanError listing every problem. */
export function parsePlan(text: string, baseDir: string): Plan {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new PlanError([`not valid YAML: ${e instanceof Error ? e.message : String(e)}`]);
  }
  if (!isObj(raw)) throw new PlanError(["the plan must be a YAML mapping"]);
  const reqStr = (o: Obj, k: string, where: string): string => {
    const v = o[k];
    if (typeof v !== "string" || !v.trim()) {
      problems.push(`${where}${k}: required, a non-empty string`);
      return "";
    }
    return v.trim();
  };
  const job = reqStr(raw, "job", "");
  const repo = reqStr(raw, "repo", "");
  const gate = reqStr(raw, "gate", "");
  const provider = reqStr(raw, "provider", "");
  let maxParallel: number | undefined;
  if (raw.max_parallel !== undefined) {
    if (typeof raw.max_parallel !== "number" || !Number.isInteger(raw.max_parallel) || raw.max_parallel < 1) {
      problems.push("max_parallel: must be an integer >= 1");
    } else maxParallel = raw.max_parallel;
  }
  const planPre = typeof raw.preamble === "string" ? raw.preamble : undefined;
  if (raw.preamble !== undefined && planPre === undefined) problems.push("preamble: must be a string");
  if (planPre && missingFile(planPre, baseDir)) problems.push(`preamble: file not found: ${planPre}`);

  const units: PlanUnit[] = [];
  const seen = new Map<string, string>();
  if (!Array.isArray(raw.units) || raw.units.length === 0) problems.push("units: required, a non-empty list");
  else {
    raw.units.forEach((u, ui) => {
      const uw = `units[${ui}].`;
      if (!isObj(u)) return void problems.push(`units[${ui}]: must be a mapping`);
      const uid = reqStr(u, "id", uw);
      const unitPre = typeof u.preamble === "string" ? u.preamble : undefined;
      if (u.preamble !== undefined && unitPre === undefined) problems.push(`${uw}preamble: must be a string`);
      if (unitPre && missingFile(unitPre, baseDir)) problems.push(`${uw}preamble: file not found: ${unitPre}`);
      if (u.unit_check !== undefined && (typeof u.unit_check !== "string" || !u.unit_check.trim())) problems.push(`${uw}unit_check: must be a non-empty string`);
      const parts: PlanPart[] = [];
      if (!Array.isArray(u.parts) || u.parts.length === 0) problems.push(`${uw}parts: required, a non-empty list`);
      else {
        u.parts.forEach((p, pi) => {
          const pw = `${uw}parts[${pi}].`;
          if (!isObj(p)) return void problems.push(`${uw}parts[${pi}]: must be a mapping`);
          const id = reqStr(p, "id", pw);
          const spec = reqStr(p, "spec", pw);
          if (spec && missingFile(spec, baseDir)) problems.push(`${pw}spec: file not found: ${spec}`);
          if (id) {
            if (seen.has(id)) problems.push(`${pw}id: duplicate part id "${id}" (also in unit ${seen.get(id)})`);
            else seen.set(id, uid);
          }
          if (p.proof !== undefined && typeof p.proof !== "string") problems.push(`${pw}proof: must be a string`);
          if (p.risky !== undefined && typeof p.risky !== "boolean") problems.push(`${pw}risky: must be a boolean`);
          const pieces = [planPre, unitPre, spec].filter((x): x is string => !!x).map((x) => textOrFile(x, baseDir));
          parts.push({
            id,
            unit: uid,
            spec: pieces.join("\n\n"),
            files: strList(p.files, `${pw}files`, problems),
            ...(typeof p.proof === "string" && p.proof.trim() ? { proof: p.proof.trim() } : {}),
            dependsOn: strList(p.depends_on, `${pw}depends_on`, problems),
            risky: p.risky === true,
          });
        });
      }
      units.push({ id: uid, ...(typeof u.unit_check === "string" && u.unit_check.trim() ? { unitCheck: u.unit_check.trim() } : {}), parts });
    });
  }
  const unitIds = units.map((u) => u.id).filter(Boolean);
  unitIds.forEach((id, i) => {
    if (unitIds.indexOf(id) !== i) problems.push(`units: duplicate unit id "${id}"`);
  });
  const all = units.flatMap((u) => u.parts);
  for (const p of all) {
    for (const d of p.dependsOn) {
      if (d === p.id) problems.push(`part ${p.id}: depends on itself`);
      else if (!seen.has(d)) problems.push(`part ${p.id}: depends_on unknown part "${d}"`);
    }
  }
  const cycle = findCycle(all);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);
  if (problems.length) throw new PlanError([...new Set(problems)]);
  return { job, repo: isAbsolute(repo) ? repo : resolve(baseDir, repo), gate, provider, ...(maxParallel ? { maxParallel } : {}), units };
}

function findCycle(parts: PlanPart[]): string[] | null {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const p of parts) {
    const c = visit(p.id);
    if (c) return c;
  }
  return null;
}

/** Read and validate the plan file at `path`. */
export function loadPlan(path: string): Plan {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new PlanError([`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`]);
  }
  return parsePlan(text, dirname(resolve(path)));
}

/** Where the run log of a plan lives. */
export const runLogPath = (planPath: string): string => `${planPath}.run.jsonl`;

/** The worker task: the part spec, its file list and proof, and (on a retry) the failure tail. */
export function composeSpec(part: PlanPart, failure?: string): string {
  const lines = [part.spec];
  if (part.files.length) lines.push("", `Files this part touches: ${part.files.join(", ")}`);
  if (part.proof) lines.push("", `Proof required: run \`${part.proof}\` and show it passing.`);
  if (failure) lines.push("", "The previous attempt failed. Its failure output (tail):", "```", failure.trim(), "```", "Fix the cause and try again.");
  return lines.join("\n");
}

/** Two file lists collide when they share a path or one names a directory containing the other. */
export function filesOverlap(a: string[], b: string[]): boolean {
  const norm = (f: string) => f.replace(/^\.\//, "").replace(/\/+$/, "");
  for (const x of a.map(norm))
    for (const y of b.map(norm)) if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
  return false;
}
