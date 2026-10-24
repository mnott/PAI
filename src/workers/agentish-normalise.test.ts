import { describe, it, expect } from "vitest";
import { normaliseAg2, parseAg2Report } from "./agentish.js";

describe("normaliseAg2", () => {
  it("splits `R: z=…` first line", () => {
    const n = normaliseAg2("R: z=done\nr=+\nG=+");
    expect(n.normalised).toBe(true);
    expect(n.text).toBe("R\nz=done\nr=+\nG=+");
    expect(parseAg2Report("R: z=done\nr=+")!.fields).toEqual({ z: "done", r: "+" });
  });

  it("splits a whole report on one line", () => {
    const n = normaliseAg2("R z=done | r=+ | G=+ | t=a+ b+");
    expect(n.text).toBe("R\nz=done\nr=+\nG=+\nt=a+ b+");
  });

  it("adds the R kind line when the report starts with a key", () => {
    const n = normaliseAg2("z=done\nr=+\nG=+");
    expect(n.text).toBe("R\nz=done\nr=+\nG=+");
    expect(parseAg2Report("r=+\nz=x")!.kind).toBe("R");
  });

  it("folds bulleted and indented lines into the previous key", () => {
    const src = "R\nz=done\nc=a.ts x\n- b.ts y\n  * c.ts z\nr=+";
    expect(normaliseAg2(src).text).toBe("R\nz=done\nc=a.ts x | b.ts y | c.ts z\nr=+");
    expect(parseAg2Report(src)!.fields.c).toBe("a.ts x\nb.ts y\nc.ts z");
    expect(parseAg2Report(src)!.fields.r).toBe("+");
  });

  it("leaves real non-reports invalid", () => {
    for (const s of ["<tool_call>x</tool_call>", "ok", ",", "API Error 500", "Failed to authenticate"]) {
      expect(normaliseAg2(s).normalised).toBe(false);
      expect(normaliseAg2(s).text).toBe(s);
    }
    expect(parseAg2Report("ok")).toBeNull();
  });

  it("returns an already-valid report byte-identical", () => {
    const ok = "R\ni=a\nr=+\nG=+\nc=src/a.ts did it\nt=x+ y+\np=x\nz=y";
    const n = normaliseAg2(ok);
    expect(n).toEqual({ text: ok, normalised: false });
  });
});
