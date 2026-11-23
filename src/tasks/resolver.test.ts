/**
 * resolver.test.ts — owner resolution for the task bus (#29)
 *
 * Pins the owner index: a task owner can be a registry slug, an alias, a
 * display name, or a live session name; the registry's numeric dedupe suffix
 * is stripped on both sides; two different projects claiming one name are
 * reported as ambiguous rather than silently resolved; an unknown name lists
 * suggestions. The provider case pins that a Todoist task whose owner is
 * "PAI" routes to the PAI project instead of the findings inbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lookupOwner,
  describeOwnerLookup,
  loadAliasMap,
  resolveOwner,
  type OwnerCandidateSource,
  type OwnerSession,
} from "./resolver.js";
import { TodoistProvider } from "./providers/todoist.js";
import { getRegistryBackend } from "../storage/factory.js";

vi.mock("../storage/factory.js", () => ({
  getRegistryBackend: vi.fn(),
}));

const PAI_ROOT = "/Users/dev/PAI";
const BROKER_ROOT = "/Users/dev/AIBroker";

const projects: OwnerCandidateSource[] = [
  { slug: "pai", displayName: "PAI", rootPath: PAI_ROOT },
  { slug: "broker", displayName: "AIBroker", rootPath: BROKER_ROOT },
];

const sessions: OwnerSession[] = [{ name: "PAI", directory: PAI_ROOT }];

describe("lookupOwner", () => {
  it("resolves a bare session name to its project", () => {
    const r = lookupOwner("PAI", projects, sessions);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(r.target.slug).toBe("pai");
      expect(r.target.rootPath).toBe(PAI_ROOT);
    }
  });

  it("resolves a slug directly", () => {
    const r = lookupOwner("broker", projects, sessions);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.target.slug).toBe("broker");
  });

  it("resolves a display name", () => {
    const r = lookupOwner("AIBroker", projects, sessions);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.target.slug).toBe("broker");
  });

  it("strips the registry dedupe suffix from the query", () => {
    const r = lookupOwner("pai-2", projects, sessions);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.target.slug).toBe("pai");
  });

  it("strips the dedupe suffix from the slug side", () => {
    const deduped: OwnerCandidateSource[] = [
      { slug: "caseleaf-2", displayName: "CaseLeaf", rootPath: "/Users/dev/CaseLeaf" },
    ];
    const r = lookupOwner("CaseLeaf", deduped, []);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.target.slug).toBe("caseleaf-2");
  });

  it("reports ambiguity with both candidates", () => {
    const dup: OwnerCandidateSource[] = [
      { slug: "acme-a", displayName: "Acme", rootPath: "/Users/dev/acme-a" },
      { slug: "acme-b", displayName: "Acme", rootPath: "/Users/dev/acme-b" },
    ];
    const r = lookupOwner("Acme", dup, []);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toContain("acme-a (/Users/dev/acme-a)");
      expect(r.candidates).toContain("acme-b (/Users/dev/acme-b)");
    }
    const err = describeOwnerLookup("Acme", r);
    expect(err).toMatch(/ambiguous/);
    expect(err).toContain("acme-a");
    expect(err).toContain("acme-b");
  });

  it("lists suggestions for an unknown owner", () => {
    const r = lookupOwner("paix", projects, sessions);
    expect(r.kind).toBe("none");
    if (r.kind === "none") expect(r.suggestions).toContain("pai");
    const err = describeOwnerLookup("paix", r);
    expect(err).toMatch(/matches no project/);
    expect(err).toContain("closest: pai");
  });
});

describe("loadAliasMap", () => {
  const listProjects = vi.fn();
  const listAliasMap = vi.fn();

  beforeEach(() => {
    vi.mocked(getRegistryBackend).mockResolvedValue({
      listProjects,
      listAliasMap,
    } as unknown as Awaited<ReturnType<typeof getRegistryBackend>>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("indexes live sessions so a session name resolves", async () => {
    listProjects.mockResolvedValue([
      { slug: "pai", display_name: "PAI", root_path: PAI_ROOT, status: "active" },
    ]);
    listAliasMap.mockResolvedValue([]);
    const index = await loadAliasMap(sessions);
    const r = lookupOwner("PAI", index.projects, index.sessions);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.target.slug).toBe("pai");
  });
});

describe("resolveOwner", () => {
  const index = { projects, sessions };

  it("routes a bare `pai` marker task to the default owner", () => {
    const owner = resolveOwner({ labels: ["pai"], defaultOwner: "PAI" }, index);
    expect(owner.project).toBe("pai");
    expect(owner.source).toBe("label");
  });

  it("routes a container named by a live session", () => {
    const owner = resolveOwner({ labels: [], container: "PAI" }, index);
    expect(owner.project).toBe("pai");
    expect(owner.source).toBe("container");
  });
});

describe("TodoistProvider owner resolution", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("resolves a task whose owner is `PAI` to the PAI project, not unrouted", async () => {
    const config = {
      enabled: true,
      apiKey: "test-token",
      rootProjectId: "root-1",
    };
    const provider = new TodoistProvider(config, { projects, sessions });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "t1",
          content: "Fix the resolver",
          project_id: "root-1",
          labels: ["pai:PAI"],
          priority: 2,
        })
      ) // /tasks/{id}
      .mockResolvedValueOnce(jsonResponse({ results: [], next_cursor: null })); // /projects

    const task = await provider.getTask("t1");
    expect(task).not.toBeNull();
    expect(task!.owner.project).toBe("pai");
    expect(task!.owner.rootPath).toBe(PAI_ROOT);
    expect(task!.owner.source).toBe("label");
  });
});
