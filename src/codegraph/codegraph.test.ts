import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "./extract/index.js";
import { openFederation } from "../storage/sqlite/federation-db.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { indexRepo, callers, searchSymbols } from "./api.js";

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
