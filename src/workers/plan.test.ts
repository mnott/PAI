import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeSpec, dirtyConflicts, filesOverlap, loadPlan, parsePlan, PlanError } from "./plan.js";

const base = "job: j\nrepo: /r\ngate: g\nprovider: local\n";
const unit = (parts: string) => `${base}units:\n  - id: u\n    parts:\n${parts}`;
const problems = (text: string): string[] => {
  try {
    parsePlan(text, "/nonexistent");
  } catch (e) {
    if (e instanceof PlanError) return e.problems;
    throw e;
  }
  return [];
};

describe("parsePlan", () => {
  it("parses the demo fixture and prepends the preamble", () => {
    const plan = loadPlan(join(dirname(new URL(import.meta.url).pathname), "fixtures", "plan-demo.yaml"));
    expect(plan.units.map((u) => u.id)).toEqual(["parser", "cli"]);
    const p2 = plan.units[0].parts[1];
    expect(p2).toMatchObject({ id: "p2", unit: "parser", risky: true, dependsOn: ["p1"] });
    expect(p2.spec).toBe("Follow the repo conventions. Keep the change minimal.\n\nAdd the grammar.");
    expect(plan.units[0].unitCheck).toBe("node scripts/parity.mjs");
    expect(plan.maxParallel).toBe(2);
  });
  it("lists every missing required field", () => {
    expect(problems("units: []\n").join("\n")).toMatch(/job.*required[\s\S]*repo[\s\S]*gate[\s\S]*provider[\s\S]*units/);
  });
  it("rejects duplicate ids, unknown and self dependencies", () => {
    const p = problems(unit("      - {id: a, spec: x, depends_on: [a, zz]}\n      - {id: a, spec: y}\n"));
    expect(p.join("\n")).toMatch(/duplicate part id "a"/);
    expect(p.join("\n")).toMatch(/depends on itself/);
    expect(p.join("\n")).toMatch(/unknown part "zz"/);
  });
  it("rejects a dependency cycle across units", () => {
    const t = `${base}units:\n  - id: u1\n    parts:\n      - {id: a, spec: x, depends_on: [b]}\n  - id: u2\n    parts:\n      - {id: b, spec: y, depends_on: [a]}\n`;
    expect(problems(t).join("\n")).toMatch(/cycle: a -> b -> a|cycle: b -> a -> b/);
  });
  it("rejects bad types and a spec naming a missing file", () => {
    const p = problems(unit("      - {id: a, spec: missing/spec.md, risky: yes-please, files: 3}\n").replace("g\n", "g\nmax_parallel: 0\n"));
    expect(p.join("\n")).toMatch(/max_parallel/);
    expect(p.join("\n")).toMatch(/file not found: missing\/spec.md/);
    expect(p.join("\n")).toMatch(/risky: must be a boolean/);
    expect(p.join("\n")).toMatch(/files: must be a list/);
  });
  it("reads a spec from a file", () => {
    const dir = join(dirname(new URL(import.meta.url).pathname), "fixtures");
    const plan = parsePlan(unit("      - {id: a, spec: plan-demo.yaml}\n"), dir);
    expect(plan.units[0].parts[0].spec).toBe(readFileSync(join(dir, "plan-demo.yaml"), "utf8").trim());
  });
});

describe("helpers", () => {
  it("composeSpec adds files, proof and the failure tail", () => {
    const plan = loadPlan(join(dirname(new URL(import.meta.url).pathname), "fixtures", "plan-demo.yaml"));
    const s = composeSpec(plan.units[0].parts[0], "boom", plan.job);
    expect(s).toMatch(/Files this part touches: src\/tok.ts/);
    expect(s).toMatch(/Proof required: run `npx vitest run src\/tok.test.ts`/);
    expect(s).toMatch(/previous attempt failed[\s\S]*boom/);
  });
  it("composeSpec always appends the worktree/commit footer and strips absolute repo paths", () => {
    const plan = parsePlan(unit("      - {id: a, spec: 'Edit /r/src/x.ts now', files: [/r/src/x.ts]}\n"), "/nonexistent");
    const s = composeSpec(plan.units[0].parts[0], undefined, plan.job, plan.repo);
    expect(s).toMatch(/RELATIVE paths inside the current working directory/);
    expect(s).toContain('message "j: u a"');
    expect(s).toMatch(/Report with an R message/);
    expect(s).not.toContain("/r/src");
    expect(s).toContain("Edit src/x.ts now");
    expect(composeSpec(plan.units[0].parts[0], "boom", plan.job)).toMatch(/RELATIVE paths/);
  });
  it("validate warns about absolute paths into the repo", () => {
    const plan = parsePlan(unit("      - {id: a, spec: 'Edit /r/src/x.ts', files: [/r/src/x.ts]}\n      - {id: b, spec: fine, files: [src/y.ts]}\n"), "/nonexistent");
    expect(plan.warnings.join("\n")).toMatch(/part a: spec names an absolute path[\s\S]*part a: files lists an absolute path/);
    expect(plan.warnings.join("\n")).not.toMatch(/part b/);
    expect(plan.units[0].parts[0].files).toEqual(["src/x.ts"]);
  });
  it("dirtyConflicts lists dirty paths a part touches", () => {
    const plan = parsePlan(unit("      - {id: a, spec: A, files: [src/x.ts, lib/]}\n"), "/nonexistent");
    expect(dirtyConflicts(plan, ["src/x.ts", "lib/q.ts", "README.md"])).toEqual(["src/x.ts", "lib/q.ts"]);
    expect(dirtyConflicts(plan, ["README.md"])).toEqual([]);
  });
  it("filesOverlap: same path or containing directory", () => {
    expect(filesOverlap(["a/b.ts"], ["./a/b.ts"])).toBe(true);
    expect(filesOverlap(["src/"], ["src/x.ts"])).toBe(true);
    expect(filesOverlap(["src/a.ts"], ["src/ab.ts"])).toBe(false);
    expect(filesOverlap([], ["x"])).toBe(false);
  });
});
