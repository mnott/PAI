import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { detectSessionName, resetDetectedSessionName } from "./session-name.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pai-sname-"));

describe("detectSessionName", () => {
  beforeEach(resetDetectedSessionName);

  it("takes PAI_SESSION_NAME first", async () => {
    expect(await detectSessionName({ PAI_SESSION_NAME: "env-name", ITERM_SESSION_ID: "w0t0p0:P1" }, { registryPath: "/nonexistent", projectName: async () => "proj" })).toBe("env-name");
  });

  it("finds the AIBroker name from ITERM_SESSION_ID alone", async () => {
    const dir = tmp();
    const registryPath = join(dir, "session-names.json");
    writeFileSync(registryPath, JSON.stringify({ P1: "Broker Name" }));
    expect(await detectSessionName({ ITERM_SESSION_ID: "w0t0p0:P1" }, { registryPath, mapPath: join(dir, "none.json"), projectName: async () => "proj" })).toBe("Broker Name");
  });

  it("bridges CLAUDE_CODE_SESSION_ID through the session map", async () => {
    const dir = tmp();
    const registryPath = join(dir, "session-names.json");
    const mapPath = join(dir, "claude-session-map.json");
    writeFileSync(registryPath, JSON.stringify({ P1: "Mapped" }));
    writeFileSync(mapPath, JSON.stringify({ "/x": { session: "cc-1", ts: 1, term: "w0t0p0:P1" } }));
    expect(await detectSessionName({ CLAUDE_CODE_SESSION_ID: "cc-1" }, { registryPath, mapPath, projectName: async () => "proj" })).toBe("Mapped");
  });

  it("reads the transcript customTitle", async () => {
    const dir = tmp();
    const projectsDir = join(dir, "projects");
    mkdirSync(join(projectsDir, "-enc"), { recursive: true });
    writeFileSync(join(projectsDir, "-enc", "cc-2.jsonl"), JSON.stringify({ type: "custom-title", customTitle: "From Transcript" }) + "\n");
    expect(await detectSessionName({ CLAUDE_CODE_SESSION_ID: "cc-2" }, { registryPath: join(dir, "n.json"), mapPath: join(dir, "m.json"), projectsDir, projectName: async () => "proj" })).toBe("From Transcript");
  });

  it("falls back to the cwd project name, and caches per process", async () => {
    let calls = 0;
    const deps = { registryPath: "/nonexistent/n.json", mapPath: "/nonexistent/m.json", cwd: "/some/dir", projectName: async () => (calls++, "my-project") };
    expect(await detectSessionName({}, deps)).toBe("my-project");
    expect(await detectSessionName({}, deps)).toBe("my-project");
    expect(calls).toBe(1);
  });
});
