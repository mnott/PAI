import { mkdtempSync, readFileSync } from "node:fs";
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

const listen = async (reply: object, onRequest?: () => void): Promise<number> => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      onRequest?.();
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
    config: { ...(noPane ? { panes: { required: false } } : {}), pool: { enabled: true, maxSlots: 1, idleSecs: 0, port, continuation: true }, capacity: { enabled: true }, pane: { enabled: true } },
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
    claudeArgs: [],
    parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
  }) as never;

const panes = () => vi.mocked(pane.openVerifiedPane).mock.calls.length + vi.mocked(pane.openPaneForWorker).mock.calls.length;

describe("pooled runs and the pane rule (the pane owns every process)", () => {
  it("--no-pane (with the hidden-run override) still pools and opens none", async () => {
    vi.mocked(pane.headlessAllowed).mockReturnValue("test override");
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: true, rc: 0 }), true);
    await gateStart(a);
    expect(await tryPoolRun(a)).toBe(0);
    expect(panes()).toBe(0);
  });

  it("no terminal at all: no pane, no claim -- the start is refused and ledgered PANE-REFUSED", async () => {
    vi.mocked(pane.resolveHostSession).mockReset().mockResolvedValue({ term: "" } as never);
    vi.mocked(pane.openVerifiedPane).mockReset().mockRejectedValue(new pane.NoTerminalError("neither TMUX nor ITERM_SESSION_ID"));
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: true, rc: 0 }), false) as { spareMiss?: string; paneError?: Error };
    await gateStart(a as never);
    expect(await tryPoolRun(a as never)).toBeNull();
    expect(a.spareMiss).toBe("pane failed");
    expect(readFileSync(join(d, "ledger.log"), "utf8")).toContain("PANE-REFUSED");
  });

  it("workers.panes.required=false: the pooled run goes ahead without a pane, ledgered PANE-WAIVED", async () => {
    vi.mocked(pane.headlessAllowed).mockReturnValue(null);
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: true, rc: 0 }), true);
    await gateStart(a);
    expect(await tryPoolRun(a)).toBe(0);
    expect(panes()).toBe(0);
    expect(readFileSync(join(d, "ledger.log"), "utf8")).toContain("PANE-WAIVED");
  });

  it("records where the setup time went on the run's args", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const a = args(d, await listen({ pooled: true, rc: 0 }), true) as { setupPaneMs?: number; admissionMs?: number };
    await gateStart(a as never);
    await tryPoolRun(a as never);
    expect(a.admissionMs).toBeGreaterThanOrEqual(0);
    expect(a.setupPaneMs).toBeGreaterThanOrEqual(0);
  });
});
