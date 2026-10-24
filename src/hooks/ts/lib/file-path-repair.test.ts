import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARD_MARKER } from "./render-decision.js";
import { type PathRepairCtx, renderPathDeny, renderPathRepair, repairFilePath } from "./file-path-repair.js";

const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
let cwd: string;
let ctx: PathRepairCtx;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "pathfix-")));
  mkdirSync(join(cwd, "src/workers"), { recursive: true });
  mkdirSync(join(cwd, "src/hooks"), { recursive: true });
  writeFileSync(join(cwd, "src/workers/pane-exec.ts"), "x");
  writeFileSync(join(cwd, "src/hooks/unique-name.ts"), "x");
  writeFileSync(join(cwd, "src/hooks/index.ts"), "x");
  writeFileSync(join(cwd, "src/workers/index.ts"), "x");
  ctx = {
    cwd,
    tracked: () => ["src/workers/pane-exec.ts", "src/hooks/unique-name.ts", "src/hooks/index.ts", "src/workers/index.ts"],
    mainRoot: () => "/main/checkout",
  };
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const call = (tool_name: string, file_path: string, more: Record<string, unknown> = {}) => ({
  tool_name,
  tool_input: { file_path, ...more },
});

describe("repairFilePath", () => {
  it("MarkupExample: fused offset/limit becomes path + offset 638 + limit 44", () => {
    const raw = `${cwd}/src/workers/pane-exec.ts </parameter> <offset> 638 </parameter> <limit> 44`;
    const r = repairFilePath(call("Read", raw), W, ctx)!;
    expect(r).toMatchObject({ kind: "repair", rule: "markup" });
    expect((r as any).updatedInput).toEqual({ file_path: `${cwd}/src/workers/pane-exec.ts`, offset: 638, limit: 44 });
  });

  it("MarkupNewline: cuts at a newline", () => {
    const r = repairFilePath(call("Read", `${cwd}/src/workers/pane-exec.ts\nfoo`), W, ctx) as any;
    expect(r.updatedInput.file_path).toBe(`${cwd}/src/workers/pane-exec.ts`);
  });

  it("OtherTreeWorktree: old worktree prefix is replaced by cwd", () => {
    const r = repairFilePath(call("Read", "/x/logs/worktrees/2026-old/src/workers/pane-exec.ts"), W, ctx) as any;
    expect(r.rule).toBe("other-tree");
    expect(r.to).toBe(`${cwd}/src/workers/pane-exec.ts`);
  });

  it("OtherTreeTypo: workters prefix too", () => {
    const r = repairFilePath(call("Read", "/x/logs/workters/abc/src/workers/pane-exec.ts"), W, ctx) as any;
    expect(r.to).toBe(`${cwd}/src/workers/pane-exec.ts`);
  });

  it("OtherTreeMain: main checkout root is stripped", () => {
    const r = repairFilePath(call("Edit", "/main/checkout/src/workers/pane-exec.ts"), W, ctx) as any;
    expect(r.to).toBe(`${cwd}/src/workers/pane-exec.ts`);
  });

  it("OtherTreeSuffix: longest suffix that exists under cwd", () => {
    const r = repairFilePath(call("Read", "/somewhere/else/src/workers/pane-exec.ts"), W, ctx) as any;
    expect(r.to).toBe(`${cwd}/src/workers/pane-exec.ts`);
  });

  it("Relative: resolved against cwd", () => {
    const r = repairFilePath(call("Read", "src/workers/pane-exec.ts"), W, ctx) as any;
    expect(r).toMatchObject({ rule: "relative", to: `${cwd}/src/workers/pane-exec.ts` });
  });

  it("UniqueBasename: one tracked file with that name", () => {
    const r = repairFilePath(call("Read", "unique-name.ts"), W, ctx) as any;
    expect(r).toMatchObject({ rule: "basename", to: `${cwd}/src/hooks/unique-name.ts` });
    const t = repairFilePath(call("Read", "/x/worktrees/old/gone/unique-name.ts"), W, ctx) as any;
    expect(t).toMatchObject({ rule: "basename", to: `${cwd}/src/hooks/unique-name.ts` });
  });

  it("UnrelatedAbsoluteNotRewritten: same basename outside the repo tree is denied", () => {
    writeFileSync(join(cwd, "README.md"), "x");
    ctx.tracked = () => ["README.md", "src/hooks/unique-name.ts"];
    expect(repairFilePath(call("Read", "/tmp/foo/README.md"), W, ctx)?.kind).toBe("deny");
    expect(repairFilePath(call("Read", "/nowhere/unique-name.ts"), W, ctx)?.kind).toBe("deny");
  });

  it("OldWorktreeNested: <oldworktree>/src/a/b.ts maps to cwd", () => {
    mkdirSync(join(cwd, "src/a"), { recursive: true });
    writeFileSync(join(cwd, "src/a/b.ts"), "x");
    const r = repairFilePath(call("Read", "/x/worktrees/old/src/a/b.ts"), W, ctx) as any;
    expect(r.to).toBe(`${cwd}/src/a/b.ts`);
  });

  it("AmbiguousBasename: two index.ts → deny", () => {
    expect(repairFilePath(call("Read", "/nowhere/index.ts"), W, ctx)?.kind).toBe("deny");
  });

  it("Deny: directive lists closest files and points at Glob", () => {
    const r = repairFilePath(call("Read", `${cwd}/spec.md`), W, ctx)!;
    expect(r.kind).toBe("deny");
    const out = JSON.parse(renderPathDeny(r as any)).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain(GUARD_MARKER);
    expect(out.permissionDecisionReason).toContain(`does not exist: ${cwd}/spec.md. Do not guess paths.`);
    expect(out.permissionDecisionReason).toContain("Closest tracked files:");
    expect(out.permissionDecisionReason).toContain("Use Glob to find it.");
    expect(out.permissionDecisionReason.match(/\.ts/g)!.length).toBeLessThanOrEqual(5);
  });

  it("ExistingPathUntouched", () => {
    expect(repairFilePath(call("Read", `${cwd}/src/workers/pane-exec.ts`), W, ctx)).toBeNull();
  });

  it("WriteNewFileNotDenied: nonexistent path passes, incl. relative", () => {
    expect(repairFilePath(call("Write", `${cwd}/new/file.md`), W, ctx)).toBeNull();
    expect(repairFilePath(call("Write", "spec.md"), W, ctx)).toBeNull();
  });

  it("WriteMarkupFixed: markup cut even for a new file", () => {
    const r = repairFilePath(call("Write", `${cwd}/new.md </parameter> <parameter name="content">`), W, ctx) as any;
    expect(r.updatedInput.file_path).toBe(`${cwd}/new.md`);
  });

  it("WriteOtherTree: old worktree prefix mapped without existence", () => {
    const r = repairFilePath(call("Write", "/x/worktrees/old/docs/new.md"), W, ctx) as any;
    expect(r.to).toBe(`${cwd}/docs/new.md`);
  });

  it("WriteNeverBasename: no unique-basename rewrite for Write", () => {
    expect(repairFilePath(call("Write", "/nowhere/unique-name.ts"), W, ctx)).toBeNull();
  });

  it("EditCreate: empty old_string is treated as create", () => {
    expect(repairFilePath(call("Edit", `${cwd}/new.md`, { old_string: "" }), W, ctx)).toBeNull();
  });

  it("InteractiveUntouched: no PAI_WORKER", () => {
    expect(repairFilePath(call("Read", `${cwd}/spec.md`), {} as NodeJS.ProcessEnv, ctx)).toBeNull();
  });

  it("OtherToolsUntouched", () => {
    expect(repairFilePath(call("Grep", `${cwd}/spec.md`), W, ctx)).toBeNull();
  });

  it("RepairRendersAllowWithUpdatedInput", () => {
    const r = repairFilePath(call("Read", "src/workers/pane-exec.ts"), W, ctx) as any;
    const out = JSON.parse(renderPathRepair(r)).hookSpecificOutput;
    expect(out.permissionDecision).toBe("allow");
    expect(out.updatedInput.file_path).toBe(`${cwd}/src/workers/pane-exec.ts`);
    expect(out.additionalContext).toContain("path repaired: src/workers/pane-exec.ts → ");
    expect(out.additionalContext).toContain("(relative)");
  });
});
