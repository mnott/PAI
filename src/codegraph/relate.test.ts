import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFederation } from "../storage/sqlite/federation-db.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { indexRepo } from "./api.js";
import { relate } from "./relate.js";
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
    writeFileSync(join(vault, "n.md"), "See `transformItems` and `src/server.ts`, [[provider]], paper [@smith2020] caseleaf://doc/abc-123\n");
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
});
