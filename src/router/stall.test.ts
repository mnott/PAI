import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { startStallMonitor } from "./stall.js";

const fakeReq = (url: string) => ({ url }) as never;
const fakeRes = () => new EventEmitter() as never;

const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* block the loop */
  }
};

describe("startStallMonitor", () => {
  it("logs a stall with the request that blocked the loop", async () => {
    const lines: string[] = [];
    const m = startStallMonitor({ thresholdMs: 150, tickMs: 20, log: (l) => lines.push(l) });
    const handler = m.wrap(() => busy(300));
    await new Promise((r) => setTimeout(r, 60));
    handler(fakeReq("/cockpit/system?window=1h"), fakeRes());
    await new Promise((r) => setTimeout(r, 80));
    m.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/event-loop stall \d+ ms/);
    expect(lines[0]).toContain("/cockpit/system 3");
  });

  it("names requests still in flight and drops them when the response closes", async () => {
    const lines: string[] = [];
    const m = startStallMonitor({ thresholdMs: 150, tickMs: 20, log: (l) => lines.push(l) });
    const res = fakeRes() as unknown as EventEmitter;
    const handler = m.wrap(() => undefined);
    handler(fakeReq("/cockpit/pool"), res as never);
    busy(250);
    await new Promise((r) => setTimeout(r, 60));
    expect(lines[0]).toContain("in flight: /cockpit/pool");
    res.emit("close");
    busy(250);
    await new Promise((r) => setTimeout(r, 60));
    m.stop();
    expect(lines[1]).toContain("in flight: -");
  });

  it("stays quiet under the threshold", async () => {
    const lines: string[] = [];
    const m = startStallMonitor({ thresholdMs: 500, tickMs: 20, log: (l) => lines.push(l) });
    busy(150);
    await new Promise((r) => setTimeout(r, 60));
    m.stop();
    expect(lines).toEqual([]);
  });
});

describe("startStallMonitor wrap errors", () => {
  it("logs a handler exception and answers 500 when headers are not sent", () => {
    const lines: string[] = [];
    const m = startStallMonitor({ thresholdMs: 150, tickMs: 20, log: (l) => lines.push(l) });
    const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: vi.fn(), end: vi.fn() });
    m.wrap(() => {
      throw new Error("boom");
    })(fakeReq("/x"), res as never);
    m.stop();
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
    expect(lines.join("\n")).toContain("boom");
  });
});
