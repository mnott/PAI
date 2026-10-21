import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Same extraction trick as win-tree.test.ts: the string is the whole contract here.
const src = readFileSync(fileURLToPath(new URL("./win/actions.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_ACTIONS_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_ACTIONS_JS not found in win/actions.ts");
const api = (new Function(
  `${m[1]}\nreturn {defAction:defAction,actionDef:actionDef,winBody:winBody,runAction:runAction,winJobStatus:winJobStatus,winClick:winClick,armConfirm:armConfirm,disarmConfirm:disarmConfirm};`,
) as any)();
const { defAction, winBody, runAction, winJobStatus, winClick } = api;

type Call = { url: string; body: any };
function fakeHost(reply: (c: Call) => unknown) {
  const calls: Call[] = [];
  const statuses: [string, string, string][] = [];
  const busy: [string, boolean][] = [];
  const refreshes: string[][] = [];
  const fetch = vi.fn(async (url: string, opts: any) => {
    const c: Call = { url, body: JSON.parse(opts.body) };
    calls.push(c);
    return reply(c);
  });
  const host = {
    fetch,
    setStatus: (id: string, kind: string, text: string) => void statuses.push([id, kind, text]),
    setBusy: (id: string, on: boolean) => void busy.push([id, on]),
    refresh: (feeds: string[]) => void refreshes.push(feeds),
    watchJob: vi.fn(),
  };
  const lastStatus = () => statuses[statuses.length - 1];
  return { host, calls, statuses, busy, refreshes, lastStatus };
}
const ok = (j: unknown) => ({ status: 200, json: async () => j });
const def = (over: any = {}) => ({
  fields: ["target"],
  build: (a: any) => ({ action: "local.stop", target: a.target }),
  doneRefresh: ["models"],
  ...over,
});

describe("win actions (spec 5.2)", () => {
  it("pending then ok: status flow, control disabled while pending, ok clears after STATUS_OK_MS, feeds refresh", async () => {
    vi.useFakeTimers();
    defAction("stop-a", def());
    const h = fakeHost(() => ok({ ok: true, message: "gyro-m stopped" }));
    const p = runAction("card1", "stop-a", { target: "gyro-m" }, null, h.host);
    expect(h.statuses).toEqual([["card1", "pending", "stop-a ..."]]);
    expect(h.busy).toEqual([["card1", true]]);
    const r = await p;
    expect(r).toEqual({ ok: true, message: "gyro-m stopped" });
    expect(h.lastStatus()).toEqual(["card1", "ok", "gyro-m stopped"]);
    expect(h.busy[h.busy.length - 1]).toEqual(["card1", false]);
    expect(h.refreshes).toEqual([["models"]]);
    // the ok status stays for STATUS_OK_MS, then clears
    vi.advanceTimersByTime(7999);
    expect(h.lastStatus()[1]).toBe("ok");
    vi.advanceTimersByTime(1);
    expect(h.lastStatus()).toEqual(["card1", "", ""]);
    vi.useRealTimers();
  });

  it("the body posted is exactly what build produced (fields target/value/count)", async () => {
    defAction("scale-a", {
      fields: ["target", "count"],
      build: (a: any) => ({ action: "local.scale", target: a.target, count: a.count }),
    });
    const h = fakeHost(() => ok({ ok: true, message: "scaled" }));
    await runAction("c", "scale-a", { target: "gyro-m", count: 2 }, null, h.host);
    expect(h.calls[0].url).toBe("/cockpit/action");
    expect(h.calls[0].body).toEqual({ action: "local.scale", target: "gyro-m", count: 2 });
  });

  it("ok:false shows the server's message and keeps it (no timer clears it)", async () => {
    defAction("stop-b", def());
    const h = fakeHost(() => ok({ ok: false, message: "2 requests in flight" }));
    const r = await runAction("c", "stop-b", { target: "gyro-m" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(h.lastStatus()).toEqual(["c", "err", "2 requests in flight"]);
    expect(h.refreshes).toEqual([]);
  });

  it("HTTP 500 shows an error, never silent", async () => {
    defAction("stop-c", def());
    const h = fakeHost(() => ({ status: 500, json: async () => ({}) }));
    const r = await runAction("c", "stop-c", { target: "x" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no answer");
    expect(r.message).toContain("HTTP 500");
    expect(h.lastStatus()[1]).toBe("err");
  });

  it("a non-JSON body shows an error", async () => {
    defAction("stop-d", def());
    const h = fakeHost(() => ({ status: 200, json: async () => { throw new Error("bad json"); } }));
    const r = await runAction("c", "stop-d", { target: "x" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no answer");
    expect(r.message).toContain("not JSON");
  });

  it("a JSON body without ok shows an error", async () => {
    defAction("stop-e", def());
    const h = fakeHost(() => ok({ message: "no ok field" }));
    const r = await runAction("c", "stop-e", { target: "x" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no answer");
    expect(h.lastStatus()[1]).toBe("err");
  });

  it("a network failure shows an error", async () => {
    defAction("stop-f", def());
    const h = fakeHost(() => { throw new Error("offline"); });
    const r = await runAction("c", "stop-f", { target: "x" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no answer");
    expect(r.message).toContain("offline");
  });

  it("an unknown verb errors without a POST", async () => {
    const h = fakeHost(() => ok({ ok: true }));
    const r = await runAction("c", "nope", {}, null, h.host);
    expect(r.ok).toBe(false);
    expect(h.calls.length).toBe(0);
  });

  it("a reply with jobId keeps the card pending and busy and watches the job; winJobStatus finishes it", async () => {
    vi.useFakeTimers();
    defAction("start-g", { fields: ["target"], build: (a: any) => ({ action: "local.start", target: a.target }), doneRefresh: ["models"] });
    const h = fakeHost(() => ok({ ok: true, message: "starting gyro-m", jobId: "abc123" }));
    const r = await runAction("c", "start-g", { target: "gyro-m" }, null, h.host);
    expect(r.jobId).toBe("abc123");
    expect(h.lastStatus()).toEqual(["c", "pending", "starting gyro-m ..."]);
    expect(h.busy[h.busy.length - 1]).toEqual(["c", true]);
    expect((h.host.watchJob as any).mock.calls).toEqual([["abc123"]]);
    // the watcher reports progress, then the job ends ok
    winJobStatus("c", "start-g", { state: "running", message: "loading", elapsedSec: 4 }, h.host);
    expect(h.lastStatus()).toEqual(["c", "pending", "loading ... 4 s"]);
    winJobStatus("c", "start-g", { state: "done", message: "gyro-m up" }, h.host);
    expect(h.lastStatus()).toEqual(["c", "ok", "gyro-m up"]);
    expect(h.busy[h.busy.length - 1]).toEqual(["c", false]);
    expect(h.refreshes).toEqual([["models"]]);
    winJobStatus("c", "start-g", { state: "failed", message: "server exited" }, h.host);
    expect(h.lastStatus()).toEqual(["c", "err", "server exited"]);
    vi.useRealTimers();
  });

  it("confirm needs two clicks: the first arms (label becomes the confirm text), the second runs", () => {
    vi.useFakeTimers();
    defAction("off-h", { fields: [], build: () => ({ action: "local.off" }), confirm: "stop every local - click again" });
    const h = fakeHost(() => ok({ ok: true, message: "stopping" }));
    const el: any = { textContent: "off" };
    winClick(el, "c", "off-h", {}, h.host);
    expect(h.calls.length).toBe(0);
    expect(el.textContent).toBe("stop every local - click again");
    winClick(el, "c", "off-h", {}, h.host);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].body).toEqual({ action: "local.off" });
    expect(el.textContent).toBe("off"); // the label is restored when it runs
    vi.useRealTimers();
  });

  it("an armed confirm reverts after CONFIRM_MS without a second click", () => {
    vi.useFakeTimers();
    defAction("off-i", { fields: [], build: () => ({ action: "local.off" }), confirm: "click again" });
    const h = fakeHost(() => ok({ ok: true }));
    const el: any = { textContent: "off" };
    winClick(el, "c", "off-i", {}, h.host);
    expect(el.textContent).toBe("click again");
    vi.advanceTimersByTime(4000);
    expect(el.textContent).toBe("off");
    // a click after the revert arms again, it does not run
    winClick(el, "c", "off-i", {}, h.host);
    expect(h.calls.length).toBe(0);
    vi.useRealTimers();
  });

  it("a queue action posts to its own route", async () => {
    defAction("next-q", { fields: ["id"], route: "/cockpit/queue/next", build: (a: any) => ({ action: "queue.next", body: { id: a.id } }) });
    const h = fakeHost(() => ok({ ok: true, message: "moved" }));
    await runAction("c", "next-q", { id: "w1" }, null, h.host);
    expect(h.calls[0].url).toBe("/cockpit/queue/next");
    expect(h.calls[0].body).toEqual({ id: "w1" });
  });

  it("winBody drops undefined fields", () => {
    expect(winBody(def(), {})).toEqual({ action: "local.stop" });
    expect(winBody(def(), { target: "m" })).toEqual({ action: "local.stop", target: "m" });
  });
});
