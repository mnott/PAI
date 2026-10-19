/**
 * A name the operator set with /Name wins over the directory name, and a
 * session that already carries its name is not sent /Name again.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrokerNames, resolveFriendlyName } from "./session-scan.js";
import { nameArgs } from "./harness.js";
import { resumeArgvText } from "./launch.js";

describe("friendly name precedence", () => {
  it("persistent name > clc name > ai title > directory", () => {
    const all = { customTitle: "Jobs Matthias", clcName: "clc", aiTitle: "title", dirName: "09 - Job Search" };
    expect(resolveFriendlyName(all)).toEqual({ name: "Jobs Matthias", persistent: "Jobs Matthias" });
    expect(resolveFriendlyName({ ...all, customTitle: undefined }).name).toBe("clc");
    expect(resolveFriendlyName({ ...all, customTitle: undefined, clcName: undefined }).name).toBe("title");
  });
  it("the directory name is only the fallback for a never-named session, and is not 'persistent'", () => {
    expect(resolveFriendlyName({ dirName: "09 - Job Search" })).toEqual({ name: "09 - Job Search", persistent: undefined });
  });
});

describe("AIBroker persistent names", () => {
  it("maps a claude session to the name stored for its pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-names-"));
    const names = join(dir, "session-names.json");
    const map = join(dir, "claude-session-map.json");
    writeFileSync(names, JSON.stringify({ "PANE-1": "Jobs Matthias", "PANE-2": "Other" }));
    writeFileSync(
      map,
      JSON.stringify({
        "/jobs": { session: "claude-old", ts: 1, term: "w0t0p0:PANE-1" },
        "/jobs2": { session: "claude-new", ts: 2, term: "w0t0p0:PANE-1" },
        "/x": { session: "claude-x", ts: 3, term: "w0t1p0:UNKNOWN" },
      })
    );
    const m = loadBrokerNames(names, map);
    expect(m.get("claude-new")).toBe("Jobs Matthias");
    expect(m.get("claude-old")).toBe("Jobs Matthias");
    expect(m.has("claude-x")).toBe(false);
  });
  it("a missing registry means no names", () => {
    expect(loadBrokerNames("/nonexistent/names.json", "/nonexistent/map.json").size).toBe(0);
  });
});

describe("/Name is not re-sent to a session that has the name", () => {
  it("harness args", () => {
    expect(nameArgs("Jobs Matthias")).toEqual(["--name", "Jobs Matthias", "/Name Jobs Matthias"]);
    expect(nameArgs("Jobs Matthias", true)).toEqual(["--name", "Jobs Matthias"]);
  });
  it("resume argv text", () => {
    expect(resumeArgvText("u1", "Jobs", null)).toContain('"/Name Jobs"');
    expect(resumeArgvText("u1", "Jobs", null, true)).not.toContain("/Name");
  });
});
