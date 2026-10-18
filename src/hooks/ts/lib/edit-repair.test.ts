import { describe, expect, it } from "vitest";
import { repairEdit } from "./edit-repair.js";

const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
const FILE = [
  "/**",
  " * One-key launch screen: continue like last time, choose a",
  " * provider/model setup, or start fresh.",
  " */",
  'import chalk from "chalk";',
  "",
  "function f() {",
  "    return 1;",
  "}",
  "",
].join("\n");
const run = (tool: string, ti: Record<string, unknown>, file: string | null = FILE) =>
  repairEdit({ tool_name: tool, tool_input: { file_path: "/x", ...ti } }, W, () => file);

describe("repairEdit", () => {
  it("repairs a collapsed-newline JSDoc block", () => {
    const old = "/** * One-key launch screen: continue like last time, choose a * provider/model setup, or start fresh. */ import chalk";
    const r = run("Edit", { old_string: old, new_string: "NEW" });
    expect(r?.repair?.updatedInput.old_string).toBe(FILE.slice(0, FILE.indexOf("import chalk") + 12));
    expect(r?.repair?.updatedInput.new_string).toBe("NEW");
  });

  it("repairs an indentation difference", () => {
    const r = run("Edit", { old_string: "function f() {\n  return 1;\n}", new_string: "y" });
    expect(r?.repair?.updatedInput.old_string).toBe("function f() {\n    return 1;\n}");
  });

  it("does not repair two identical blocks", () => {
    expect(run("Edit", { old_string: "a b", new_string: "y" }, "a  b\na\nb\na b")).toBeNull();
  });

  it("does not repair an absent string", () => {
    expect(run("Edit", { old_string: "nothing here", new_string: "y" })).toBeNull();
  });

  it("leaves an exact match untouched", () => {
    expect(run("Edit", { old_string: "return 1;", new_string: "y" })).toBeNull();
  });

  it("MultiEdit: repairs one edit, keeps the exact one", () => {
    const r = run("MultiEdit", {
      edits: [
        { old_string: "return 1;", new_string: "return 2;" },
        { old_string: "function f() { return 2; }", new_string: "z" },
      ],
    });
    const edits = r?.repair?.updatedInput.edits as Array<{ old_string: string }>;
    expect(edits[0].old_string).toBe("return 1;");
    expect(edits[1].old_string).toBe("function f() {\n    return 2;\n}");
    expect(r?.repair?.count).toBe(1);
  });

  it("denies a no-op edit with the edit-assist hint", () => {
    const r = run("Edit", { old_string: "same", new_string: "same" });
    expect(r?.deny).toContain("identical");
  });

  it("is a no-op outside workers", () => {
    expect(repairEdit({ tool_name: "Edit", tool_input: { file_path: "/x", old_string: "a", new_string: "a" } }, {}, () => FILE)).toBeNull();
  });
});
