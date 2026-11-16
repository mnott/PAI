import { describe, expect, it } from "vitest";
import { decidePreGates } from "./gates.js";

const base = { PAI_WORKER: "1", PAI_WORKER_CLASS: "orchestrate", TMPDIR: "/var/folders/x/T" } as NodeJS.ProcessEnv;
const run = (tool: string, input: unknown, env: NodeJS.ProcessEnv, failed = false) =>
  decidePreGates({ tool, input, cwd: "/w/tree", env }, { planner: { childFailed: () => failed } });

describe("L1 planner lock", () => {
  it("denies edits, in-place writes and redirects without a failed child", () => {
    expect(run("Edit", { file_path: "a.txt" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "sed -i '' s/a/b/ a.txt" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "echo x >> NOTES.txt" }, base)?.action).toBe("deny");
    expect(run("Bash", { command: "sed -i '' s/a/b/ a.txt && echo x >> NOTES.txt && git commit -m x" }, base)?.action).toBe("deny");
  });
  it("allows scratch, tmp specs and git", () => {
    expect(run("Write", { file_path: ".pai-scratch/x" }, base)).toBeNull();
    expect(run("Write", { file_path: "/var/folders/x/T/spec.txt" }, base)).toBeNull();
    expect(run("Bash", { command: "cat > $TMPDIR/spec.txt" }, base)).toBeNull();
    expect(run("Bash", { command: "git commit -m 'a > b'" }, base)).toBeNull();
    expect(run("Bash", { command: "ls 2>&1 | grep a" }, base)).toBeNull();
  });
  it("lifts after a failed child", () => {
    expect(run("Edit", { file_path: "a.txt" }, base, true)).toBeNull();
    expect(run("Bash", { command: "echo x >> NOTES.txt" }, base, true)).toBeNull();
  });
  it("leaves class implement alone", () => {
    expect(run("Edit", { file_path: "a.txt" }, { ...base, PAI_WORKER_CLASS: "implement" })).toBeNull();
  });
  it("does not touch the --orchestrate path", () => {
    expect(run("Edit", { file_path: "a.txt" }, { ...base, PAI_WORKER_ORCHESTRATOR: "1" })).toBeNull();
  });
});
