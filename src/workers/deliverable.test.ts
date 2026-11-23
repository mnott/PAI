import { describe, expect, it } from "vitest";
import { parsePlan, PLAN_SCHEMA, specFooter } from "./plan.js";
import { isFindingsProgressTool, isProgressTool } from "./run/stream.js";
import { parseDeliverable } from "./deliverable.js";

const plan = (extra: { plan?: string; unit?: string; part?: string }) => `job: j
repo: /tmp
gate: "true"
provider: p
${extra.plan ?? ""}
units:
  - id: u
    ${extra.unit ?? ""}
    parts:
      - id: a
        title: A
        spec: do it
        ${extra.part ?? ""}
`;

describe("deliverable in the plan language", () => {
  it("is in the schema", () => {
    expect(JSON.stringify(PLAN_SCHEMA)).toContain("deliverable");
  });
  it("part > unit > plan, absent = none", () => {
    const get = (t: string) => parsePlan(t, "/tmp").units[0].parts[0].deliverable;
    expect(get(plan({}))).toBeUndefined();
    expect(get(plan({ plan: "deliverable: findings" }))).toBe("findings");
    expect(get(plan({ plan: "deliverable: findings", unit: "deliverable: change" }))).toBe("change");
    expect(get(plan({ unit: "deliverable: change", part: "deliverable: findings" }))).toBe("findings");
  });
  it("a bad value is rejected on plan, unit and part", () => {
    expect(() => parsePlan(plan({ part: "deliverable: report" }), "/tmp")).toThrow(/deliverable: must be one of change, findings/);
    expect(() => parsePlan(plan({ unit: "deliverable: x" }), "/tmp")).toThrow(/deliverable/);
    expect(() => parsePlan(plan({ plan: "deliverable: x" }), "/tmp")).toThrow(/deliverable/);
  });
  it("a findings part's footer asks for a report, not a commit", () => {
    const p = parsePlan(plan({ part: "deliverable: findings" }), "/tmp").units[0].parts[0];
    expect(specFooter(p, "j")).not.toMatch(/Git add/);
    expect(specFooter({ ...p, deliverable: undefined }, "j")).toMatch(/Git add/);
  });
  it("parseDeliverable is lenient", () => {
    expect(parseDeliverable("findings")).toBe("findings");
    expect(parseDeliverable("x")).toBeUndefined();
  });
});

describe("progress clock", () => {
  it("findings: scratch write, redirect, build or test run count; a read does not", () => {
    expect(isFindingsProgressTool("Write", { file_path: "/tmp/x" })).toBe(true);
    expect(isFindingsProgressTool("Bash", { command: "node scrape.js > out.json" })).toBe(true);
    expect(isFindingsProgressTool("Bash", { command: "npx vitest run a.test.ts" })).toBe(true);
    expect(isFindingsProgressTool("Bash", { command: "npm run build" })).toBe(true);
    expect(isFindingsProgressTool("Read", { file_path: "a" })).toBe(false);
    expect(isFindingsProgressTool("Bash", { command: "ls src" })).toBe(false);
  });
  it("change: a test run is not progress, an edit or commit is", () => {
    expect(isProgressTool("Bash", { command: "npx vitest run" })).toBe(false);
    expect(isProgressTool("Edit", {})).toBe(true);
  });
});
