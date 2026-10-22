/** The router side of "save as default": POST stores the layout, the next page load carries it. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCockpit } from "./cockpit.js";

const home = mkdtempSync(join(tmpdir(), "pai-layout-serve-"));
const savedHome = process.env.PAI_HOME;
let server: Server;
let base = "";
beforeAll(async () => {
  process.env.PAI_HOME = home;
  server = createServer((req, res) => void handleCockpit(req, res, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  if (savedHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("layout default route", () => {
  it("the page has the save button and no default before one is saved", async () => {
    const html = await (await fetch(`${base}/cockpit`)).text();
    expect(html).toContain('id="savedef"');
    expect(html).toContain("window.PAI_LAYOUT_DEFAULT=null;");
  });

  it("a posted layout is served to the next page load; garbage is refused", async () => {
    const layout = { v: 2, t: 1, tree: { k: "c", id: "kpis" }, kids: {}, st: {} };
    expect((await fetch(`${base}/cockpit/layout-default`, { method: "POST", body: "nope" })).status).toBe(400);
    expect((await fetch(`${base}/cockpit/layout-default`, { method: "POST", body: JSON.stringify(layout) })).status).toBe(200);
    const html = await (await fetch(`${base}/cockpit`)).text();
    expect(html).toContain("window.PAI_LAYOUT_DEFAULT=" + JSON.stringify(layout) + ";");
  });

  it("a cross-site post is refused", async () => {
    const r = await fetch(`${base}/cockpit/layout-default`, { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: "{}" });
    expect(r.status).toBe(403);
  });
});
