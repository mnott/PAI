import { describe, it, expect } from "vitest";
import { allocatePort, checkStart, freeMemoryGb, neededGb, canBind } from "./local-memory.js";
import { createServer } from "node:net";

const GB = 1024 ** 3;
// 16 KiB pages: 1 GiB = 65536 pages
const vm = (freeGb: number, inactiveGb = 0) =>
  `Mach Virtual Memory Statistics: (page size of 16384 bytes)\n` +
  `Pages free: ${freeGb * 65536}.\nPages speculative: 0.\nPages inactive: ${inactiveGb * 65536}.\n` +
  `Pages wired down: 1000.\nPages occupied by compressor: 1000.\n`;
const deps = (freeGb: number, inactiveGb = 0) => ({
  vmStat: async () => vm(freeGb, inactiveGb),
  memTotal: async () => 64 * GB,
});

describe("allocatePort", () => {
  it("skips taken and un-bindable ports", async () => {
    const p = await allocatePort(8035, [8035, 8036], async (x) => x !== 8037);
    expect(p).toBe(8038);
  });
  it("prefers the base port when free", async () => {
    expect(await allocatePort(8035, [], async () => true)).toBe(8035);
  });
  it("throws when the span is exhausted", async () => {
    await expect(allocatePort(9000, [], async () => false)).rejects.toThrow(/no free port/);
  });
  it("canBind sees a really bound port", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    expect(await canBind(port)).toBe(false);
    await new Promise((r) => srv.close(r));
    expect(await canBind(port)).toBe(true);
  });
});

describe("freeMemoryGb / neededGb", () => {
  it("counts free + inactive minus the reserve", async () => {
    expect(await freeMemoryGb(4, deps(10, 6))).toBeCloseTo(12, 1);
  });
  it("is undefined without vm_stat", async () => {
    expect(await freeMemoryGb(4, { vmStat: async () => undefined, memTotal: async () => 1 })).toBeUndefined();
  });
  it("takes the max of hint, footprint and disk x 1.1", () => {
    expect(neededGb({ memoryGb: 20, footprintGb: 25, diskGb: 10 })).toBe(25);
    expect(neededGb({ diskGb: 10 })).toBeCloseTo(11);
    expect(neededGb({})).toBe(0);
  });
});

describe("checkStart", () => {
  it("refuses with the reason when memory is short", async () => {
    const free = await freeMemoryGb(4, deps(10, 0));
    const c = checkStart({ label: "gyro-m #2", needGb: 20, freeGb: free });
    expect(c.ok).toBe(false);
    expect(c.message).toBe("refuse to start gyro-m #2: needs ~20 GB, free 6 GB (reserve 4)");
  });
  it("allows when it fits, or with force, or when unmeasurable", () => {
    expect(checkStart({ label: "m", needGb: 5, freeGb: 6 }).ok).toBe(true);
    expect(checkStart({ label: "m", needGb: 50, freeGb: 6, force: true }).ok).toBe(true);
    expect(checkStart({ label: "m", needGb: 50, freeGb: undefined }).ok).toBe(true);
  });
  it("counts a start in flight as used", () => {
    expect(checkStart({ label: "m #1", needGb: 10, freeGb: 12 }).ok).toBe(true);
    const second = checkStart({ label: "m #2", needGb: 10, freeGb: 12, inflightGb: 10 });
    expect(second.ok).toBe(false);
    expect(second.message).toContain("free 2 GB");
  });
});
