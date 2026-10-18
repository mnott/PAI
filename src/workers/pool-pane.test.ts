import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateStart, tryPoolRun } from "./run.js";
import * as pane from "./pane.js";
import { loadStatus } from "./status.js";

vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return {
    ...actual,
    openPaneForWorker: vi.fn(),
    openVerifiedPane: vi.fn(),
    headlessAllowed: vi.fn(),
    resolveHostSession: vi.fn(),
  };
});

const servers: Server[] = [];
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.mocked(pane.openPaneForWorker).mockReset().mockResolvedValue({ message: "ok", session: "S1" });
  vi.mocked(pane.openVerifiedPane).mockReset().mockResolvedValue("here");
  vi.mocked(pane.headlessAllowed).mockReset().mockReturnValue(null);
  vi.mocked(pane.resolveHostSession).mockReset().mockResolvedValue({ term: "term-1" } as never);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  stderr.mockRestore();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const listen = async (reply: object): Promise<number> => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
};

const args = (logDir: string, port: number, noPane: boolean) =>
  ({
    config: { pool: { enabled: true, maxSlots: 1, idleSecs: 0, port }, capacity: { enabled: true }, pane: { enabled: true } },
    logDir,
    quiet: true,
    id: "w-pane",
    label: "x",
    model: "m",
    cwd: tmpdir(),
    noPane,
    worktreeFlag: false,
    reportFormat: "ag2",
    noBrowser: true,
    noStagger: true,
    target: { providerName: "loc", provider: { models: { default: "m" }, maxConcurrent: 1 } },
    parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
  }) as never;

const panes = () => vi.mocked(pane.openVerifiedPane).mock.calls.length + vi.mocked(pane.openPaneForWorker).mock.calls.length;

describe("pooled runs get a follow pane", () => {
  it("an accepted pooled run opens exactly one pane and records it", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: true, rc: 0 }), false);
    await gateStart(a);
    expect(await tryPoolRun(a)).toBe(0);
    expect(panes()).toBe(1);
    expect(loadStatus(d, "w-pane")?.pane?.opened).toBe(true);
  });

  it("a declined pooled run opens one pane, and the fallback does not open another", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: false, reason: "busy" }), false) as { panePrepared?: unknown };
    await gateStart(a as never);
    expect(await tryPoolRun(a as never)).toBeNull();
    expect(panes()).toBe(1);
    expect(a.panePrepared).toEqual({ verified: true });
    expect(panes()).toBe(1);
  });

  it("--no-pane (with the hidden-run override) announces none", async () => {
    vi.mocked(pane.headlessAllowed).mockReturnValue("test override");
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: true, rc: 0 }), true);
    await gateStart(a);
    expect(await tryPoolRun(a)).toBe(0);
    expect(panes()).toBe(0);
  });
});
