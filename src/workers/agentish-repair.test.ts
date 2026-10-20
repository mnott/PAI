import { describe, it, expect } from "vitest";
import { ag2ToWorkerReport, parseAg2Report, repairAg2, repairAndValidateAg2, validateAg2 } from "./agentish.js";

const FIXTURE = `R
i=cockpit-metric-tile
r=+
G=+
c=src/router/cockpit-page.ts|metricTile+mtSpark in page script, .mtile* CSS|src/router/cockpit-page.test.ts|4 tests: CSS+attribution
t=cockpit-page.test.ts 33+|tsc --noEmit+
p=npx vitest run src/router/cockpit-page.test.ts (33 passed); npx tsc --noEmit clean
z=metricTile(...) -> HTML; committed 025d9d6b, no push
note=icon-less tiles render title only`;

const hasValidator = validateAg2("R\ni=x\nr=+\nG=+\nc=none\nt=a+\np=x\nz=y").validator === "aibroker";

describe("repairAg2", () => {
  it("fixes c pairs, second note key and spaced test names", () => {
    const r = repairAg2(FIXTURE);
    expect(r.repairs).toEqual(["note->z", "c pairs", "t names"]);
    const f = parseAg2Report(r.text)!.fields;
    expect(f.note).toBeUndefined();
    expect(f.z).toContain("no push; icon-less tiles render title only");
    expect(f.c).toBe("src/router/cockpit-page.ts metricTile+mtSpark in page script, .mtile* CSS|src/router/cockpit-page.test.ts 4 tests: CSS+attribution");
    expect(f.t).toBe("cockpit-page.test.ts-33+|tsc---noEmit+");
  });

  it("leaves a valid-shaped message alone", () => {
    const ok = "R\ni=a\nr=+\nG=+\nc=src/a.ts did it\nt=x+ y+\np=x\nz=y";
    expect(repairAg2(ok)).toEqual({ text: ok, repairs: [] });
  });

  it.runIf(hasValidator)("validates after repair and keeps both changed paths", () => {
    expect(validateAg2(FIXTURE).ok).toBe(false);
    const r = repairAndValidateAg2(FIXTURE);
    expect(r.validation.ok).toBe(true);
    expect(r.repairs).toEqual(["note->z", "c pairs", "t names"]);
    const report = ag2ToWorkerReport(parseAg2Report(r.text)!);
    expect(report.changed).toEqual([
      { path: "src/router/cockpit-page.ts", summary: "metricTile+mtSpark in page script, .mtile* CSS" },
      { path: "src/router/cockpit-page.test.ts", summary: "4 tests: CSS+attribution" },
    ]);
    expect(report.notes).toContain("repaired: note->z, c pairs, t names");
  });
});
