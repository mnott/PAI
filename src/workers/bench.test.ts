import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregate, gateDecision, parseRow, parseRows, planArms } from "./bench.js";

const fixture = readFileSync(new URL("./fixtures/bench-rows.tsv", import.meta.url), "utf-8");

describe("planArms", () => {
  it("expands task × provider × repeat, task-major", () => {
    const arms = planArms(["a", "b"], ["x", "y"], "spec", 2);
    expect(arms).toHaveLength(8);
    expect(arms.slice(0, 5).map((a) => `${a.task}/${a.provider}/${a.repeat}`)).toEqual(["a/x/1", "a/x/2", "a/y/1", "a/y/2", "b/x/1"]);
    expect(arms.every((a) => a.prompt === "spec")).toBe(true);
  });
});

describe("gateDecision", () => {
  it("waits for a slot first, then for the load", () => {
    expect(gateDecision(10, 60, 3, 3)).toBe("wait-slot");
    expect(gateDecision(61, 60, 1, 3)).toBe("wait-load");
    expect(gateDecision(60, 60, 0, 3)).toBe("go");
  });
});

describe("parseRow", () => {
  it("reads provider and prompt from the arm id; skips calibration rows", () => {
    expect(parseRow("t\tt-local30-spec-195627\tpass\t0\t0\t-\t-\t7.6\t?\t1\tnone\tx")).toMatchObject({ provider: "local30", prompt: "spec", verdict: "pass", wall: 7.6, turns: undefined });
    expect(parseRow("t\tt-anthropic-195627\tfail\t0\t1\t-\t-\t2\t5\t1\tnone\tx")).toMatchObject({ provider: "anthropic", prompt: "task", turns: 5 });
    expect(parseRow("t\tfix\tpass")).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("excludes void from the total and takes medians", () => {
    const rows = parseRows(
      [
        "t\tt-p-100000\tpass\t0\t0\t-\t-\t2\t4\t1\tnone\tx",
        "t\tt-p-100001\tfail\t0\t1\t-\t-\t6\t8\t1\tnone\tx",
        "t\tt-p-100002\tvoid\t-\t-\t-\t-\t9\t?\t1\tnone\tx",
      ].join("\n"),
    );
    expect(aggregate(rows)).toContain("| p | task | 1/2 | 6 | 6 |");
  });

  it("aggregates the CaseLeaf sample rows", () => {
    const table = aggregate(parseRows(fixture));
    expect(table).toMatch(/\| anthropic \| task \| \d+\/\d+ \|/);
    expect(table).not.toContain("fix");
  });
});
