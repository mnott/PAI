import { describe, it, expect } from "vitest";
import { zettelCommunities } from "./communities.js";
import type { StorageBackend } from "../storage/interface.js";

function clique(prefix: string, n: number): Array<{ source_path: string; target_path: string }> {
  const edges: Array<{ source_path: string; target_path: string }> = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      edges.push({ source_path: `${prefix}/n${i}.md`, target_path: `${prefix}/n${j}.md` });
  return edges;
}

function stub(edges: Array<{ source_path: string; target_path: string }>): StorageBackend {
  const paths = [...new Set(edges.flatMap((e) => [e.source_path, e.target_path]))];
  return {
    getVaultLinkGraph: async () => edges,
    getAllVaultFiles: async () => paths.map((p) => ({ vaultPath: p, title: p })),
  } as unknown as StorageBackend;
}

describe("zettelCommunities", () => {
  const edges = [...clique("a", 4), ...clique("b", 6), { source_path: "a/n0.md", target_path: "b/n0.md" }];

  it("separates cliques, ids follow size rank", async () => {
    const r = await zettelCommunities(stub(edges), { minSize: 3 });
    expect(r.communities.map((c) => c.size)).toEqual([6, 4]);
    expect(r.communities.map((c) => c.id)).toEqual([0, 1]);
    expect(r.communities[0].topFolders[0]).toBe("b");
  });

  it("is deterministic across runs", async () => {
    const first = JSON.stringify(await zettelCommunities(stub(edges)));
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(await zettelCommunities(stub(edges)))).toBe(first);
    }
  });
});
