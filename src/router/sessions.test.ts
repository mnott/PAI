import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionMap, sessionDisplayName } from "./sessions.js";

describe("session mapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-"));
  writeFileSync(join(dir, "w1.status"), JSON.stringify({ id: "w1", label: "fix thing", state: "done", rc: 0, claudeSession: "c-1", provider: "glm" }));
  writeFileSync(join(dir, "w2.status"), JSON.stringify({ id: "w2", label: "bad", state: "done", rc: 1, claudeSession: "c-2" }));
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ "c-3": "proj" }));
  const map = loadSessionMap({ workerDirs: [dir], agentSessionsFile: join(dir, "agents.json") });

  it("maps worker sessions with verdict and agent sessions to project", () => {
    expect(sessionDisplayName("c-1", map)).toBe("fix thing");
    expect(map.get("c-1")).toMatchObject({ worker: "w1", verdict: "ok", provider: "glm" });
    expect(map.get("c-2")?.verdict).toBe("failed");
    expect(sessionDisplayName("c-3", map)).toBe("proj");
  });

  it("unknown or missing id is null", () => {
    expect(sessionDisplayName("zzz", map)).toBeNull();
    expect(sessionDisplayName(undefined, map)).toBeNull();
  });
});

describe("session mapper: transcript fallback", () => {
  it("names a session from its project directory when no registry lists it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "-Users-x-dev-PAI"), { recursive: true });
    writeFileSync(join(projects, "-Users-x-dev-PAI", "c-9.jsonl"), "{}");
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ "c-8": "reg" }));
    mkdirSync(join(projects, "-Users-x-other"), { recursive: true });
    writeFileSync(join(projects, "-Users-x-other", "c-8.jsonl"), "{}");
    const map = loadSessionMap({ workerDirs: [], agentSessionsFile: join(dir, "agents.json"), projectsDir: projects });
    expect(sessionDisplayName("c-9", map)).toBe("PAI");
    expect(sessionDisplayName("c-8", map)).toBe("reg");
  });
});
