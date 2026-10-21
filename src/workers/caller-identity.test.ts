import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerIdentity } from "./caller-identity.js";
import { isOwner } from "./kill-tree.js";
import { detectSessionName, resetDetectedSessionName } from "./session-name.js";
import type { WorkerStatus } from "./status.js";

const TERM = "CEFF8DB4-BA5C-4838-9ADC-8BC12E054504";
const SID = "224db3e0-bafb-4bf7-bc09-2c63f6ab8e19";

function setup(name: string) {
  const claude = mkdtempSync(join(tmpdir(), "ci-"));
  const job = join(claude, "jobs", "224db3e0");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "state.json"), JSON.stringify({ name, other: 1 }));
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CODE_SESSION_ID: SID,
    TERM_SESSION_ID: `w5t0p0:${TERM}`,
    CLAUDE_PID: "68396",
    CLAUDE_JOB_DIR: job,
  };
  return { claude, env };
}

const worker = (over: Partial<WorkerStatus>): WorkerStatus =>
  ({ id: "w", pid: 1, term: "", state: "running", ...over }) as WorkerStatus;

describe("callerIdentity", () => {
  it("reads term suffix and job name from the live env", () => {
    const { claude, env } = setup("PAI (4)");
    expect(callerIdentity(env, { claudeDir: claude })).toEqual({ term: TERM, jobName: "PAI (4)" });
  });
  it("falls back to jobs/<id8> without CLAUDE_JOB_DIR", () => {
    const { claude, env } = setup("PAI (4)");
    delete env.CLAUDE_JOB_DIR;
    expect(callerIdentity(env, { claudeDir: claude }).jobName).toBe("PAI (4)");
  });
  it("spawn records the name kill derives", async () => {
    const { claude, env } = setup("PAI (4)");
    resetDetectedSessionName();
    expect(await detectSessionName(env, { claudeDir: claude })).toBe("PAI (4)");
  });
});

describe("isOwner with the shared resolver", () => {
  const proc = { processTree: () => new Map<number, [number, string]>(), commands: () => new Map<number, string>() };
  it("accepts the recorded sessionKey (job name)", () => {
    const { env } = setup("PAI (4)");
    expect(isOwner(worker({ sessionKey: "PAI (4)" }), env, proc)).toBe(true);
  });
  it("accepts the recorded term", () => {
    const { env } = setup("other");
    expect(isOwner(worker({ term: TERM, sessionKey: "PAI (4)" }), env, proc)).toBe(true);
  });
  it("refuses a different term and sessionKey", () => {
    const { env } = setup("PAI (4)");
    const other = worker({ term: "11111111-2222-3333-4444-555555555555", sessionKey: "Other (2)" });
    expect(isOwner(other, env, proc)).toBe(false);
  });
});
