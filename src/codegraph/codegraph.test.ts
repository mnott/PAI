import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "./extract/index.js";
import { openFederation } from "../storage/sqlite/federation-db.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { summarizeRepo, findSummary, MAX_PROMPT_CHARS } from "./summaries.js";
import { indexRepo, callers, searchSymbols, explore, callees } from "./api.js";
import { execFileSync } from "node:child_process";
import { GRAPH_INDEXING_LINE, incrementalIndexIfIndexed, lockPath, markDirty, readDirty, runningIndex, sessionGraphLine, startBackgroundIndex, type BgDeps } from "./session.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "codegraph-test-"));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("extractFile", () => {
  // regression: the cursor walk re-descended after climbing and never ended
  it("finishes a 2-line TS input in under 1 s", async () => {
    await extractFile({ path: "warm.ts", content: "const x = 1;", mtime: 0 }); // grammar load excluded
    const t0 = Date.now();
    const r = await extractFile({ path: "a.ts", content: "export function foo(){ bar(); }\nfunction bar(){}", mtime: 0 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r!.symbols.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
    const call = r!.refs.find((x) => x.kind === "call" && x.toName === "bar");
    expect(call).toBeTruthy();
    expect(r!.symbols[call!.fromSymbolIndex!].name).toBe("foo");
    expect(r!.symbols.find((s) => s.name === "foo")!.exported).toBe(true);
  }, 20000);

  it("extracts methods with qualified names (TS, Python, Swift)", async () => {
    const ts = await extractFile({ path: "c.ts", content: "class A { m(){ this.n(); } n(){} }", mtime: 0 });
    expect(ts!.symbols.map((s) => s.name)).toContain("A.m");
    const py = await extractFile({ path: "c.py", content: "class A:\n    def m(self):\n        helper()\ndef helper():\n    pass\n", mtime: 0 });
    expect(py!.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "A.m", "helper"]));
    expect(py!.refs.some((r) => r.kind === "call" && r.toName === "helper")).toBe(true);
    const sw = await extractFile({ path: "c.swift", content: "public struct S { func go() { run() } }\nfunc run() {}\n", mtime: 0 });
    expect(sw!.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["S", "S.go", "run"]));
  }, 20000);
});

describe("index + resolve + incremental (SQLite)", () => {
  it("links cross-file calls, reindexes after edit and delete", async () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), 'import { helper } from "./b.js";\nexport function main(){ helper(); }\n');
    writeFileSync(join(root, "src/b.ts"), "export function helper(){}\n");
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));

    const first = await indexRepo(backend, root);
    expect(first.files).toBe(2);
    expect(first.symbols).toBe(2);
    expect(first.resolvedRefs).toBeGreaterThan(0);
    const c = await callers(backend, root, "helper");
    expect(c.some((r) => r.file === "src/a.ts")).toBe(true);
    expect((await searchSymbols(backend, root, "helper"))[0].file).toBe("src/b.ts");

    writeFileSync(join(root, "src/b.ts"), "export function helper2(){}\n\nexport const extra = 1;\n");
    const second = await indexRepo(backend, root, { force: true });
    expect(second.changed).toBeGreaterThan(0);
    expect((await searchSymbols(backend, root, "helper2")).length).toBe(1);

    rmSync(join(root, "src/b.ts"));
    const third = await indexRepo(backend, root);
    expect(third.deleted).toBe(1);
    expect(third.files).toBe(1);
  }, 30000);
});

describe("module and repo summaries (model mocked)", () => {
  function setup() {
    const root = tmp();
    mkdirSync(join(root, "src/a"), { recursive: true });
    mkdirSync(join(root, "src/b"), { recursive: true });
    writeFileSync(join(root, "src/a/a.ts"), 'import { helper } from "../b/b.js";\n/** Entry of the a module. */\nexport function main(){ helper(); }\n');
    writeFileSync(join(root, "src/b/b.ts"), "export function helper(){}\n");
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    const prompts: string[] = [];
    const model = { name: "mock/model", client: async (p: string) => { prompts.push(p); return "It does a thing."; } };
    return { root, backend, prompts, model };
  }

  it("regenerates only when the source hash changed", async () => {
    const { root, backend, prompts, model } = setup();
    await indexRepo(backend, root);
    const first = await summarizeRepo(backend, root, { model, slug: "demo" });
    expect(first.modules).toBe(2);
    expect(first.summarized).toBe(3); // 2 modules + repo
    const calls = prompts.length;
    const again = await summarizeRepo(backend, root, { model, slug: "demo" });
    expect(again.summarized).toBe(0);
    expect(again.unchanged).toBe(3);
    expect(prompts.length).toBe(calls);

    writeFileSync(join(root, "src/b/b.ts"), "export function helper(){}\nexport function more(){}\n");
    await indexRepo(backend, root);
    const third = await summarizeRepo(backend, root, { model, slug: "demo" });
    expect(third.summarized).toBe(2); // module b + repo; module a untouched
    expect(prompts.length).toBe(calls + 2);
    const row = await findSummary(backend.codeGraph(), root, "src/b/b.ts");
    expect(row!.key).toBe("code:demo:src/b");
    expect(row!.model).toBe("mock/model");
    expect(row!.summary).toContain("more");
    expect((await findSummary(backend.codeGraph(), root, "code:demo:src/a"))!.summary).toContain("Depends on: src/b");
  }, 30000);

  it("bounds the prompt input", async () => {
    const { root, backend, prompts, model } = setup();
    const big = Array.from({ length: 400 }, (_, i) => `export function fn${i}(${"arg: string, ".repeat(30)}){}`).join("\n");
    writeFileSync(join(root, "src/b/big.ts"), big);
    await indexRepo(backend, root);
    await summarizeRepo(backend, root, { model, slug: "demo" });
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompts.some((p) => p.includes("fn0"))).toBe(true);
    expect(prompts.every((p) => !p.includes("fn399"))).toBe(true);
  }, 30000);

  it("explore includes the module and repo summary", async () => {
    const { root, backend, model } = setup();
    await indexRepo(backend, root);
    await summarizeRepo(backend, root, { model, slug: "demo" });
    const r = await explore(backend, root, "helper");
    expect(r.text).toContain("## Module summary: src/b");
    expect(r.text).toContain("It does a thing.");
    expect(r.text).toContain("## Repo summary: .");
  }, 30000);
});

describe("sessions and workers use the graph", () => {
  const mkRepo = () => {
    const root = tmp();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "export function one(){ two(); }\nfunction two(){}\n");
    return root;
  };
  const deps = (over: Partial<BgDeps> = {}): BgDeps & { spawned: string[] } => {
    const spawned: string[] = [];
    return { spawned, skipReason: async () => null, spawnIndex: (r) => { spawned.push(r); return process.pid; }, alive: () => true, ...over };
  };

  it("indexed repo: one line with the file count and the ask-first hint", async () => {
    process.env.PAI_HOME = tmp();
    const root = mkRepo();
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    await indexRepo(backend, root);
    const d = deps();
    const line = await sessionGraphLine(backend, root, d);
    expect(line).toMatch(/^Code graph: 1 files indexed \(updated .+\)\. Ask it first: pai code explore/);
    expect(d.spawned).toEqual([]);
  });

  it("unindexed repo: background index started once (lock), line injected; other repo is busy; guards skip", async () => {
    process.env.PAI_HOME = tmp();
    const root = mkRepo();
    const other = mkRepo();
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    const d = deps();
    expect(await sessionGraphLine(backend, root, d)).toBe(GRAPH_INDEXING_LINE);
    expect(await sessionGraphLine(backend, root, d)).toBe(GRAPH_INDEXING_LINE);
    expect(d.spawned).toEqual([root]); // second session did not start another
    expect(await startBackgroundIndex(other, d)).toBe("busy");
    expect(runningIndex(d.alive)?.root).toBe(root);
    rmSync(lockPath());
    expect(await startBackgroundIndex(other, deps({ skipReason: async () => "frozen" }))).toBe("skipped");
    expect(await sessionGraphLine(backend, tmp(), d)).toBeNull(); // not a code repo
  });

  it("dirty list is consumed by the next query, which re-reads the file", async () => {
    process.env.PAI_HOME = tmp();
    const root = mkRepo();
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    await indexRepo(backend, root);
    writeFileSync(join(root, "a.ts"), "export function one(){ three(); }\nfunction three(){}\n");
    writeFileSync(join(root, "b.ts"), "export function fresh(){}\n");
    markDirty(root, join(root, "b.ts"));
    expect(readDirty(root)).toEqual(["b.ts"]);
    expect((await searchSymbols(backend, root, "fresh")).map((s) => s.name)).toContain("fresh");
    expect(readDirty(root)).toEqual([]);
  });

  it("merge: incremental index starts for an indexed repo only", async () => {
    process.env.PAI_HOME = tmp();
    const root = mkRepo();
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    const d = deps();
    expect(await incrementalIndexIfIndexed(backend, root, d)).toBe("unindexed");
    await indexRepo(backend, root);
    expect(await incrementalIndexIfIndexed(backend, root, d)).toBe("started");
    expect(d.spawned).toEqual([root]);
  });
});

describe("explore ranking and callees", () => {
  it("ranks the merge gate above a local `where`, and callees skip own parameters", async () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/gate.ts"),
      "/** the merge gate: checks a branch before it is merged */\nexport function runMergeGate(branch: string){ return moveTo(branch); }\nexport function moveTo(b: string){ return b; }\n");
    writeFileSync(join(root, "src/target.ts"),
      "export function other(){ const where = 1; return where; }\n");
    writeFileSync(join(root, "src/front.ts"),
      "import { moveTo } from \"./gate.js\";\nexport function setFront(logDir: string, id: string){ const tmp = id; moveTo(logDir); return tmp; }\n");
    const backend = new SQLiteBackend(openFederation(join(tmp(), "db.sqlite")));
    await indexRepo(backend, root);

    const r = await explore(backend, root, "where is the merge gate implemented");
    expect(r.symbols[0].file).toBe("src/gate.ts");
    expect(r.symbols[0].name).toBe("runMergeGate");
    expect(r.symbols.some((s) => s.name === "where")).toBe(false);
    expect(r.text.indexOf("## src/gate.ts")).toBeGreaterThan(-1);

    const c = await callees(backend, root, "setFront");
    expect(c.map((h) => h.name)).toContain("moveTo");
    for (const p of ["logDir", "id", "tmp"]) expect(c.map((h) => h.name)).not.toContain(p);
  }, 30000);

  it("callees drops own parameters even when stored refs predate the extractor fix", async () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/front.ts"),
      "export function moveTo(b: string){ return b; }\nexport function setFront(logDir: string, id: string){ moveTo(logDir); return id; }\n");
    const raw = openFederation(join(tmp(), "db2.sqlite"));
    const backend = new SQLiteBackend(raw);
    await indexRepo(backend, root);
    // simulate rows stored by a pre-1.2.81 index: refs to the parameters
    const sym = raw.prepare("SELECT id, repo_root, file_id FROM code_symbols WHERE name = 'setFront'").get() as { id: number; repo_root: string; file_id: number };
    for (const n of ["logDir", "id"]) {
      raw.prepare("INSERT INTO code_refs (repo_root, from_file_id, from_symbol_id, to_name, to_symbol_id, kind, line) VALUES (?,?,?,?,NULL,'call',2)")
        .run(sym.repo_root, sym.file_id, sym.id, n);
    }
    const c = await callees(backend, root, "setFront");
    expect(c.map((h) => h.name)).toContain("moveTo");
    for (const p of ["logDir", "id"]) expect(c.map((h) => h.name)).not.toContain(p);
  }, 30000);
});
