import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleCockpit } from "./cockpit.js";

// package.json read as one with no homepage: the header title must stay the plain
// title markup, not an empty h1 (mocked before cockpit.ts loads, so the startup
// read caches null for this file)
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-cockpit-no-homepage-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-homepage-fixture", version: "0.0.0" }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
vi.mock("../module-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module-paths.js")>();
  return { ...actual, resolveFromModule: (moduleUrl: string, rel: string, maxLevels?: number) => (rel === "package.json" ? join(dir, "package.json") : actual.resolveFromModule(moduleUrl, rel, maxLevels)) };
});

describe("cockpit header title without a package.json homepage", () => {
  it("the h1 keeps the plain title: PAI and Cockpit, no link", () => {
    const sent = { body: "" };
    const fake = { setHeader: () => undefined, writeHead: () => undefined, end: (b: string) => void (sent.body = b) } as never;
    handleCockpit({ url: "/cockpit", method: "GET" } as never, fake, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []);
    const h1 = sent.body.match(/<h1>[\s\S]*?<\/h1>/)![0];
    expect(h1).toContain("PAI");
    expect(h1).toContain("Cockpit");
    expect(h1).not.toContain("<a");
    expect(sent.body).not.toContain("__COCKPIT_HOMEPAGE__");
  });
});
