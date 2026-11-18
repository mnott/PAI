import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFederation } from "../storage/sqlite/federation-db.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { indexRepo } from "./api.js";
import { relate, extractFacts, deriveCallsApi, deriveCallsCli, dedupeTriples, deriveFromNote, type Loaded } from "./relate.js";
import type { TripleSpec } from "./store.js";
import { related, formatRelated } from "./graph.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "relate-test-"));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = tmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const BODY = (name: string) => `export function ${name}(items: number[]) {
  const out: number[] = [];
  for (const item of items) {
    if (item % 2 === 0) {
      out.push(item * 3 + 1);
    } else {
      out.push(item - 7);
    }
  }
  return out.filter((x) => x > 0).map((x) => x + 100);
}
`;

/** minimal Loaded[] for the pure derivations (no store, no indexing) */
function loaded(slug: string, root: string, files: Record<string, string>): Loaded {
  return {
    p: { slug, root },
    files: Object.keys(files),
    symbols: [],
    facts: Object.entries(files).map(([path, text]) => extractFacts(path, text)),
  };
}

const spec = (subject: string, predicate: string, object: string): TripleSpec =>
  ({ subject, predicate, object, confidence: "EXTRACTED" });

describe("relate (SQLite)", () => {
  it("derives depends-on, calls-api, duplicates, mentions, cites; ends a vanished relation; external source absent is silent", async () => {
    const a = repo({
      "package.json": JSON.stringify({ name: "@x/provider-pkg" }),
      "src/server.ts": 'app.get("/api/widgets/:id", handler);\nexport function handler(){}\n',
      "src/util.ts": BODY("transformItems"),
    });
    const b = repo({
      "package.json": JSON.stringify({ name: "consumer", dependencies: { "@x/provider-pkg": "^1.0.0" } }),
      "src/client.ts": 'export async function load(id: string) { return fetch(`${base}/api/widgets/${id}`); }\n',
      "src/lib.ts": BODY("mapItems"),
    });
    const vault = tmp();
    writeFileSync(join(vault, "n.md"), "See `transformItems` and `src/server.ts`, [[provider]], paper [[@smith2020]] caseleaf://doc/abc-123\n");
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    await indexRepo(backend, a);
    await indexRepo(backend, b);
    const projects = [{ slug: "provider", root: a }, { slug: "consumer", root: b }];

    const rep = await relate(backend, projects, { vaultPath: vault });
    expect(rep.byPredicate["depends-on"]).toBe(1);
    expect(rep.byPredicate["calls-api"]).toBe(1);
    expect(rep.byPredicate["duplicates"]).toBe(1);
    expect(rep.byPredicate["mentions"]).toBeGreaterThanOrEqual(3);
    expect(rep.byPredicate["cites"]).toBe(2);

    const r = await related(backend, projects, "consumer");
    expect(r.groups["depends-on"][0].key).toBe("code:provider");
    expect(r.groups["calls-api"]?.[0].key).toContain("code:provider:src/server.ts#/api/widgets/:id");
    expect(formatRelated(r)).toContain("depends-on");
    expect(r.notes.join(" ")).not.toContain("external graph");

    writeFileSync(join(b, "src/client.ts"), "export function load() { return 1; }\n");
    await indexRepo(backend, b, { force: true });
    const rep2 = await relate(backend, projects, { vaultPath: vault });
    expect(rep2.byPredicate["calls-api"] ?? 0).toBe(0);
    expect(rep2.closed).toBe(1);
    const counts = await backend.codeGraph().tripleCounts();
    expect(counts["calls-api"]).toEqual({ open: 0, closed: 1 });
  }, 60000);

  it("a generic protocol identifier in a string is not calls-api; routes and MCP tool names are", async () => {
    // "tool_use" appears as a case label (not a registration) and as a string in the consumer: no triple.
    const provider = loaded("provider", "/x/provider", {
      "src/bridge.swift": 'switch block {\n  case "tool_use":\n    render(block)\n}\n',
      "src/mcp.ts": 'server.tool(\n  "pailot_send",\n  "Send a message.",\n  {}, handler);\n',
    });
    const consumer = loaded("consumer", "/x/consumer", {
      "src/client.ts": 'const kind = "tool_use";\nawait call("pailot_send");\nfetch("/api/widgets/42");\n',
    });
    const api = deriveCallsApi([provider, consumer]);
    expect(api.some((t) => t.object.includes("#tool_use"))).toBe(false);
    expect(api.some((t) => t.predicate === "calls-api" && t.object.includes("#pailot_send"))).toBe(true);
    // extractFacts alone: a bare case label never registers a tool name
    const f = extractFacts("src/bridge.swift", 'case "tool_use":\n  render(block)\n');
    expect(f.tools).toEqual([]);
    // route definitions match consumers; stoplisted short names are not APIs even if registered as tools
    const g = extractFacts("src/mcp.ts", 'registerTool("text", {}, h);\nserver.tool("do_it", {}, h);\n');
    expect(g.tools).toContain("do_it"); // length ok, not stoplisted
    const p2 = loaded("provider", "/x/provider", { "src/mcp.ts": 'server.tool("text", {}, h);\n' });
    const c2 = loaded("consumer", "/x/consumer", { "src/c.ts": 'call("text");\n' });
    expect(deriveCallsApi([p2, c2])).toEqual([]);
  });

  it("CLI invocations of the other project's binary become calls-cli both ways", async () => {
    const pai = loaded("pai", "/x/pai", {
      "src/rename.ts": 'execFileSync("aibroker", ["owner", "rename", a, b]);\nlog(`run: aibroker owner rename`);\n',
    });
    const broker = loaded("aibroker", "/x/aibroker", {
      "src/projects.ts": 'await execFileAsync("pai", ["project", "names", "--json"]);\nlog("`pai project health` finds it");\n',
    });
    const cli = deriveCallsCli([pai, broker]);
    expect(cli.some((t) => t.subject.startsWith("code:pai:") && t.predicate === "calls-cli" && t.object.startsWith("code:aibroker#owner"))).toBe(true);
    expect(cli.some((t) => t.subject.startsWith("code:aibroker:") && t.predicate === "calls-cli" && t.object.startsWith("code:pai#project"))).toBe(true);
    // no self-calls: pai running `pai ...` is not a relation to itself
    expect(cli.every((t) => parseSlug(t.subject) !== parseSlug(t.object))).toBe(true);
  });

  it("dedupes triples by (subject, predicate, object)", () => {
    const d = dedupeTriples([spec("a", "calls-api", "b"), spec("a", "calls-api", "b"), spec("a", "calls-cli", "b"), spec("c", "calls-api", "b")]);
    expect(d).toHaveLength(3);
  });

  it("slug comes from the registered project and is stable across runs", async () => {
    // a repo directory named PAI whose registry slug is "pai-1": keys use the registered slug, never a basename guess.
    const dir = mkdtempSync(join(tmpdir(), "PAI-"));
    dirs.push(dir);
    const root = join(dir, "PAI");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), 'fetch("/api/widgets/1");\n');
    execFileSync("git", ["init", "-q"], { cwd: root });
    const consumerRoot = repo({ "src/c.ts": 'fetch(`${base}/api/widgets/${id}`);\n' });
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db2.sqlite")));
    await indexRepo(backend, root);
    await indexRepo(backend, consumerRoot);
    const projects = [{ slug: "pai-1", root }, { slug: "consumer", root: consumerRoot }];
    const r1 = await relate(backend, projects, {});
    expect(r1.byPredicate["calls-api"]).toBe(1);
    const keys1 = (await backend.codeGraph().triplesTouching([`code:pai-1`], { limit: 50 })).map((t) => `${t.subject}|${t.object}`);
    expect(keys1.some((k) => k.includes("code:pai-1:src/a.ts"))).toBe(true);
    const r2 = await relate(backend, projects, {});
    expect(r2.kept).toBe(r1.triples);
    expect(r2.added).toBe(0);
    const keys2 = (await backend.codeGraph().triplesTouching([`code:pai-1`], { limit: 50 })).map((t) => `${t.subject}|${t.object}`);
    expect(keys2.sort()).toEqual(keys1.sort());
  }, 60000);

  it("storage keeps one open row per triple even across scopes", async () => {
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db3.sqlite")));
    const store = backend.codeGraph();
    const t = [spec("x:a", "calls-api", "y:b")];
    await store.syncTriples("relate:one", t);
    await store.syncTriples("relate:two", t);
    const rows = await store.triplesTouching(["x:a"], { limit: 10 });
    expect(rows).toHaveLength(1);
    // vanish and reopen: still exactly one open row, the closed history kept
    await store.syncTriples("relate:one", []);
    await store.syncTriples("relate:two", []);
    await store.syncTriples("relate:one", t);
    const rows2 = await store.triplesTouching(["x:a"], { limit: 10 });
    expect(rows2).toHaveLength(1);
    expect(rows2[0].validTo).toBeNull();
    const counts = await store.tripleCounts();
    expect(counts["calls-api"]).toEqual({ open: 1, closed: 1 });
  });

  it("cites come from bibliography citekeys only, not bare [@handle] mentions", () => {
    const idx = { slugs: new Set<string>(), paths: new Map(), symbols: new Map() };
    const t = deriveFromNote(`note:v:n.md`, "Paper [[@Ahrens_2017aa]], see [see also; @smith2020]. He tweeted [@heykahn on Twitter] about it.\n", idx);
    const cites = t.filter((x) => x.predicate === "cites").map((x) => x.object);
    expect(cites).toContain("cite:Ahrens_2017aa");
    expect(cites).toContain("cite:smith2020");
    expect(cites).not.toContain("cite:heykahn");
  });
});

function parseSlug(key: string): string {
  const m = /^code:([^:#]+)/.exec(key);
  return m ? m[1] : "";
}
