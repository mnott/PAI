import { describe, it, expect } from "vitest";
import { encodedDirRefusedReason } from "./scan-index.js";

describe("encodedDirRefusedReason", () => {
  it("refuses worker, agent-worktree and temp names without touching disk", () => {
    expect(encodedDirRefusedReason("-Users-x--pai-logs-workers-worktrees-abc")).toBeTruthy();
    expect(encodedDirRefusedReason("-Users-x-repo--claude-worktrees-cool")).toBeTruthy();
    expect(encodedDirRefusedReason("-private-tmp-ops")).toBeTruthy();
    expect(encodedDirRefusedReason("-var-folders-ab-cd-T-x")).toBeTruthy();
    expect(encodedDirRefusedReason("-tmp-x")).toBeTruthy();
    expect(encodedDirRefusedReason("-Users-x-dev-tmpdir-app")).toBeUndefined();
    expect(encodedDirRefusedReason("-Users-x-dev-app")).toBeUndefined();
  });
});
