import { describe, it, expect, vi } from "vitest";

vi.mock("../memory/embedding-gate.js", () => ({
  requireQueryEmbedding: async () => new Float32Array([1]),
}));

import { zettelConverse } from "./converse.js";
import type { StorageBackend } from "../storage/interface.js";

describe("zettelConverse graph expansion", () => {
  it("caps depth and frontier and batches lookups", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let depthCalls = 0;
    const track = async <T,>(v: T): Promise<T> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return v;
    };
    const hits = Array.from({ length: 500 }, (_, i) => ({
      projectId: 1, path: `s${i}.md`, startLine: 1, endLine: 2, score: 1, snippet: "", id: String(i),
    }));
    const backend = {
      searchKeyword: async () => hits,
      searchSemantic: async () => [],
      getVaultLinksFromPaths: async (p: string[]) => {
        depthCalls++;
        expect(p.length).toBeLessThanOrEqual(200);
        return p.map((x) => ({ sourcePath: x, targetPath: `${x}-n${depthCalls}` }));
      },
      getLinksToTarget: () => track([]),
      getVaultHealth: () => track(null),
      getVaultLinkGraph: async () => [],
      getAllVaultFiles: async () => [],
    } as unknown as StorageBackend;

    await zettelConverse(backend, { question: "q", vaultProjectId: 1, depth: 50, limit: 5 }).catch(() => {});
    expect(depthCalls).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeLessThanOrEqual(20);
  });
});
