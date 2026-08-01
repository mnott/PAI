import { describe, it, expect } from "vitest";
import { reconcile, normalizeName, type SessionEntry, type ProjectEntry } from "./projects.js";

const sessions: SessionEntry[] = [
  { name: "PAI", directory: "/dev/PAI" },
  { name: "Jobs Matthias", directory: "/Job Search" },
  { name: "Whazaa", directory: "/dev/Whazaa" },
];

const projects: ProjectEntry[] = [
  { id: "p1", name: "PAI" },
  { id: "p2", name: "Jobs Matthias" },
  { id: "p3", name: "Clickr" },
];

describe("normalizeName", () => {
  it("compares the way a person scanning two lists would", () => {
    expect(normalizeName("  Jobs   Matthias ")).toBe("jobs matthias");
    expect(normalizeName("JOBS MATTHIAS")).toBe(normalizeName("Jobs Matthias"));
  });
});

describe("reconcile", () => {
  const rows = reconcile(sessions, projects);
  const byName = (n: string) => rows.find((r) => r.name === n)!;

  it("marks a session with a matching project as addressable", () => {
    expect(byName("PAI").state).toBe("mapped");
    expect(byName("PAI").projectId).toBe("p1");
  });

  it("flags a session that cannot be addressed at all", () => {
    // The silent failure this command exists for: filing a task for Whazaa
    // looks identical to filing one that will be picked up.
    expect(byName("Whazaa").state).toBe("session-only");
    expect(byName("Whazaa").projectId).toBeUndefined();
  });

  it("keeps a project whose session is not running, rather than calling it an error", () => {
    // Tasks filed here queue until the session next launches. That is the
    // feature, not a fault, so it must read differently from an unmapped one.
    expect(byName("Clickr").state).toBe("project-only");
  });

  it("groups actionable rows together instead of scattering them", () => {
    const states = rows.map((r) => r.state);
    expect(states).toEqual([...states].sort((a, b) => {
      const rank = { mapped: 0, "session-only": 1, "project-only": 2 } as const;
      return rank[a] - rank[b];
    }));
  });

  it("matches case- and whitespace-insensitively", () => {
    const r = reconcile(
      [{ name: "jobs   grazyna", directory: "/g" }],
      [{ id: "p9", name: "Jobs Grazyna" }]
    );
    expect(r).toHaveLength(1);
    expect(r[0].state).toBe("mapped");
  });

  it("reports every project when AIBroker is absent, rather than nothing", () => {
    const r = reconcile([], projects);
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.state === "project-only")).toBe(true);
  });
});
