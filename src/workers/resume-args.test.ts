import { describe, expect, it } from "vitest";
import { resumePlan } from "./resume-args.js";

const old = { id: "w-1", claudeSession: "sess-1", cwd: "/tmp", uhpResponseId: null };

describe("resumePlan", () => {
  it("resumes when the transcript exists", () => {
    const p = resumePlan(old, "go", () => "/x/sess-1.jsonl");
    expect(p.claudeArgs).toEqual(["--resume", "sess-1", "-p", "go"]);
    expect(p.note).toBeUndefined();
    expect(p.cwd).toBe("/tmp");
  });
  it("starts a fresh thread in the same workspace when the transcript is gone", () => {
    const p = resumePlan(old, "go", () => null);
    expect(p.claudeArgs).not.toContain("--resume");
    expect(p.claudeArgs[0]).toBe("-p");
    expect(p.claudeArgs[1]).toContain("go");
    expect(p.note).toMatch(/fresh thread/);
    expect(p.cwd).toBe("/tmp");
  });
  it("passes a uhp worker through without a transcript", () => {
    const p = resumePlan({ ...old, uhpResponseId: "resp_1" }, "go", () => null);
    expect(p.claudeArgs).toEqual(["--resume", "sess-1", "-p", "go"]);
  });
});
