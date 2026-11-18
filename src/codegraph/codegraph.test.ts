import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "./extract/index.js";
import { openFederation } from "../storage/sqlite/federation-db.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { indexRepo, callers, searchSymbols, explore } from "./api.js";
import { summarizeRepo, findSummary, MAX_PROMPT_CHARS } from "./summaries.js";

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
