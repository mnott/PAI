import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Same extraction trick as win-tree.test.ts: the string is the whole contract here.
const src = readFileSync(fileURLToPath(new URL("./win/actions.ts", import.meta.url)), "utf8");
const m = src.match(/export const WIN_ACTIONS_JS = String\.raw`([\s\S]*?)`;/);
if (!m) throw new Error("WIN_ACTIONS_JS not found in win/actions.ts");
const api = (new Function(
  `${m[1]}\nreturn {defAction:defAction,actionDef:actionDef,winBody:winBody,runAction:function(cardId,verb,args,el,host){return runAction(cardId,verb,args,el,host,{pollMs:1})},runActionReal:runAction,winClick:winClick,winPost:winPost,clearStatus:clearStatus,armConfirm:armConfirm,disarmConfirm:disarmConfirm,WIN_VERBS:WIN_VERBS,STATUS_OK_MS:STATUS_OK_MS,JOB_POLL:JOB_POLL,JOB_TRIES:JOB_TRIES};`,
) as any)();
const { defAction, actionDef, winBody, runAction, winClick, clearStatus, WIN_VERBS } = api;

type Call = { url: string; body: any };
function fakeHost(reply: (c: Call) => unknown) {
  const calls: Call[] = [];
  const statuses: [string, string, string][] = [];
  const busy: [string, boolean, unknown][] = [];
  const refreshes: string[][] = [];
  const cleared: string[] = [];
  const fetch = vi.fn(async (url: string, opts: any) => {
    const c: Call = { url, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(c);
    return reply(c);
  });
  const host = {
    fetch,
    setStatus: (id: string, kind: string, text: string) => void statuses.push([id, kind, text]),
    setBusy: (id: string, on: boolean, el?: unknown) => void busy.push([id, on, el]),
    clearStatus: (id: string) => void cleared.push(id),
    refresh: (feeds: string[]) => void refreshes.push(feeds),
  };
  const lastStatus = () => statuses[statuses.length - 1];
  return { host, calls, statuses, busy, refreshes, cleared, lastStatus };
}
// the page's fetch shape: a Response-like {status,text}
const ok = (j: unknown) => ({ status: 200, text: async () => JSON.stringify(j) });
const def = (over: any = {}) => ({
  fields: ["target"],
  build: (a: any) => ({ action: "local.stop", target: a.target }),
  doneRefresh: ["models"],
  ...over,
});

describe("win actions", () => {
  it("pending then ok: status flow, control disabled while pending, ok clears after STATUS_OK_MS, feeds refresh", async () => {
    vi.useFakeTimers();
    defAction("stop-a", def());
    const h = fakeHost(() => ok({ ok: true, message: "gyro-m stopped" }));
    const p = runAction("card1", "stop-a", { target: "gyro-m" }, null, h.host);
    expect(h.statuses).toEqual([["card1", "pending", "stop-a ..."]]);
    expect(h.busy).toEqual([["card1", true, null]]);
    const r = await p;
    expect(r).toEqual({ ok: true, message: "gyro-m stopped" });
    expect(h.lastStatus()).toEqual(["card1", "ok", "gyro-m stopped"]);
    expect(h.busy[h.busy.length - 1]).toEqual(["card1", false, null]);
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

  it("D5: the invoking control is disabled, not the whole card — setBusy carries el", async () => {
    defAction("stop-el", def());
    const h = fakeHost(() => ok({ ok: true, message: "done" }));
    const el: any = { disabled: false };
    await runAction("c", "stop-el", { target: "x" }, el, h.host);
    expect(h.busy[0]).toEqual(["c", true, el]);
    expect(h.busy[h.busy.length - 1]).toEqual(["c", false, el]);
  });

  it("D5: a second run while one is pending for the same control is refused with 'already running'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const h = fakeHost(async () => {
      await gate;
      return ok({ ok: true, message: "done" });
    });
    defAction("slow-a", def());
    const el: any = {};
    const p1 = runAction("c", "slow-a", { target: "x" }, el, h.host);
    const r2 = await runAction("c", "slow-a", { target: "x" }, el, h.host);
    expect(r2).toEqual({ ok: false, message: "already running" });
    expect(h.lastStatus()).toEqual(["c", "err", "already running"]);
    expect(h.calls.length).toBe(1); // the refusal posted nothing
    release();
    await p1;
    // once the first run finished, the same control runs again
    const p3 = runAction("c", "slow-a", { target: "x" }, el, h.host);
    expect(h.calls.length).toBe(2);
    await p3;
  });

  it("D5: clearStatus clears the status line and cancels the pending ok timer", async () => {
    vi.useFakeTimers();
    defAction("stop-cl", def());
    const h = fakeHost(() => ok({ ok: true, message: "done" }));
    await runAction("c", "stop-cl", { target: "x" }, null, h.host);
    expect(h.lastStatus()).toEqual(["c", "ok", "done"]);
    clearStatus(h.host, "c");
    expect(h.cleared).toEqual(["c"]);
    vi.advanceTimersByTime(8000);
    expect(h.lastStatus()).toEqual(["c", "ok", "done"]); // the ok timer was cancelled: no late ""
    vi.useRealTimers();
  });

  it("HTTP 500 with a non-JSON body shows 'no answer: HTTP 500'", async () => {
    defAction("stop-c", def());
    const h = fakeHost(() => ({ status: 500, text: async () => "boom" }));
    const r = await runAction("c", "stop-c", { target: "x" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no answer");
    expect(r.message).toContain("HTTP 500");
    expect(h.lastStatus()[1]).toBe("err");
  });

  it("D6: a non-200 whose body is JSON {ok:false,message} shows the server's message", async () => {
    defAction("stop-d6", def());
    const h = fakeHost(() => ({ status: 409, text: async () => JSON.stringify({ ok: false, message: "worker is running" }) }));
    const r = await runAction("c", "stop-d6", { target: "x" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("worker is running");
    expect(h.lastStatus()).toEqual(["c", "err", "worker is running"]);
  });

  it("D6: a queue-style non-200 {error} body shows the error text with the status", async () => {
    defAction("move-d6", { fields: ["id"], route: "/cockpit/queue/move", build: (a: any) => ({ action: "queue.move", body: { id: a.id } }) });
    const h = fakeHost(() => ({ status: 409, text: async () => JSON.stringify({ error: "worker is running" }) }));
    const r = await runAction("c", "move-d6", { id: "w1" }, null, h.host);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("HTTP 409");
    expect(r.message).toContain("worker is running");
  });

  it("a non-JSON body on a 200 shows an error", async () => {
    defAction("stop-d", def());
    const h = fakeHost(() => ({ status: 200, text: async () => "<html>not json" }));
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

  it("D2: a reply with jobId polls /cockpit/job per the JOB_* policy and ends ok", async () => {
    vi.useFakeTimers();
    defAction("start-g", { fields: ["target"], build: (a: any) => ({ action: "local.start", target: a.target }), doneRefresh: ["models"] });
    let polls = 0;
    const h = fakeHost((c) => {
      if (c.url === "/cockpit/action") return ok({ ok: true, message: "starting gyro-m", jobId: "abc123" });
      polls++;
      if (polls < 2) return ok({ id: "abc123", state: "running", message: "loading", elapsedSec: 4 });
      return ok({ id: "abc123", state: "done", message: "gyro-m up" });
    });
    const el: any = {};
    const p = runAction("c", "start-g", { target: "gyro-m" }, el, h.host);
    expect(h.lastStatus()).toEqual(["c", "pending", "start-g ..."]);
    expect(h.busy[0]).toEqual(["c", true, el]);
    await pump(1);
    expect(h.calls[1].url).toBe("/cockpit/job?id=abc123");
    expect(h.lastStatus()).toEqual(["c", "pending", "loading ... 4 s"]);
    // advance only to the next poll: past it the ok status would hit its STATUS_OK_MS clear
    await pump(1);
    const r = await p;
    expect(r).toEqual({ ok: true, message: "gyro-m up" });
    expect(h.lastStatus()).toEqual(["c", "ok", "gyro-m up"]);
    expect(h.busy[h.busy.length - 1]).toEqual(["c", false, el]);
    expect(h.refreshes).toEqual([["models"]]);
    vi.useRealTimers();
  });

  it("D2: a job that fails ends err with the job's message", async () => {
    vi.useFakeTimers();
    defAction("start-h", { fields: ["target"], build: (a: any) => ({ action: "local.start", target: a.target }) });
    const h = fakeHost((c) => {
      if (c.url === "/cockpit/action") return ok({ ok: true, message: "starting", jobId: "j1" });
      return ok({ id: "j1", state: "failed", message: "server exited" });
    });
    const p = runAction("c", "start-h", { target: "gyro-m" }, null, h.host);
    await pump(2);
    const r = await p;
    expect(r).toEqual({ ok: false, message: "server exited" });
    expect(h.lastStatus()).toEqual(["c", "err", "server exited"]);
    vi.useRealTimers();
  });

  it("D2: a job that never ends ends err 'no result after N s' after JOB_TRIES polls", async () => {
    vi.useFakeTimers();
    defAction("start-i", { fields: ["target"], build: (a: any) => ({ action: "local.start", target: a.target }) });
    let polls = 0;
    const h = fakeHost((c) => {
      if (c.url === "/cockpit/action") return ok({ ok: true, message: "starting", jobId: "j2" });
      polls++;
      return ok({ id: "j2", state: "running", message: "still going" });
    });
    const p = runAction("c", "start-i", { target: "gyro-m" }, null, h.host);
    await pump(api.JOB_TRIES + 5);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toBe(`no result after ${Math.round((api.JOB_TRIES * api.JOB_POLL) / 1000)} s`);
    expect(h.lastStatus()).toEqual(["c", "err", r.message]);
    expect(polls).toBe(api.JOB_TRIES);
    vi.advanceTimersByTime(10000); // the err status stays: no timer clears it
    expect(h.lastStatus()).toEqual(["c", "err", r.message]);
    vi.useRealTimers();
  });

  it("D2: a job id that is gone (404 twice) ends err 'no such job' without sitting out the budget", async () => {
    vi.useFakeTimers();
    defAction("start-j", { fields: ["target"], build: (a: any) => ({ action: "local.start", target: a.target }) });
    let polls = 0;
    const h = fakeHost((c) => {
      if (c.url === "/cockpit/action") return ok({ ok: true, message: "starting", jobId: "gone" });
      polls++;
      return { status: 404, text: async () => JSON.stringify({ error: "no such job" }) };
    });
    const p = runAction("c", "start-j", { target: "gyro-m" }, null, h.host);
    await pump(5);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toBe("no such job");
    expect(h.lastStatus()).toEqual(["c", "err", "no such job"]);
    expect(polls).toBe(2); // early end: not the whole JOB_TRIES budget
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

  it("D4: WIN_VERBS is the production table and carries the queue verbs with their routes", () => {
    for (const verb of ["queue.next", "queue.up", "queue.front", "queue.move"]) {
      expect(WIN_VERBS[verb], `${verb} must be in WIN_VERBS`).toBeTruthy();
      expect(WIN_VERBS[verb].route).toBe(`/cockpit/queue/${verb.split(".")[1]}`);
      expect(actionDef(verb), `${verb} must be registered from WIN_VERBS`).toBe(WIN_VERBS[verb]);
    }
    expect(winBody(WIN_VERBS["queue.move"], { id: "w1", position: 2 })).toEqual({ id: "w1", position: 2 });
  });
});

// drains microtasks so a fake-timer poll chain can advance
function tick() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}
// drains the microtask queue only (no timer advance): lets a promise chain that resolves
// a timer with a promise (res(step())) settle, so the next wait timer exists to advance
async function drain() {
  for (let i = 0; i < 30; i++) await tick();
}
// vitest's advanceTimersByTime runs only the timers queued at call time, and an async
// fetch settles between them: advance one poll at a time with a drain in between.
// The runner under test polls with pollMs=1 (see the extraction above).
async function pump(ms: number) {
  for (let i = 0; i < Math.ceil(ms); i++) {
    await drain();
    vi.advanceTimersByTime(1);
  }
  await drain();
}

describe("C1 guards: job watcher wording", () => {
  // w=7 job watcher text: a runtime job shows "<message> ... N s · last log line" while it runs ("starting", "stopping") and the text clears into the result when it ends.
  it("shows the job message with seconds and the last log line while it runs, then the result", async () => {
    vi.useFakeTimers();
    defAction("job-w", { fields: ["target"], build: (a: any) => ({ action: "local.stop", target: a.target }) });
    for (const [word, done] of [["starting", "started"], ["stopping", "stopped"]] as const) {
      let polls = 0;
      const h = fakeHost((c) => {
        if (c.url === "/cockpit/action") return ok({ ok: true, message: word, jobId: "jw" });
        polls++;
        return polls < 3
          ? ok({ id: "jw", state: "running", message: word, elapsedSec: polls * 5, tail: "loading shards" })
          : ok({ id: "jw", state: "done", message: done });
      });
      const p = runAction("c", "job-w", { target: "gyro-m" }, null, h.host);
      await pump(6);
      const r = await p;
      const pending = h.statuses.filter((s) => s[1] === "pending").map((s) => s[2]);
      expect(pending).toContain(`${word} ...`);
      expect(pending).toContain(`${word} ... 5 s · loading shards`);
      expect(pending).toContain(`${word} ... 10 s · loading shards`);
      expect(r).toEqual({ ok: true, message: done });
      expect(h.lastStatus()).toEqual(["c", "ok", done]); // the progress text is replaced by the result
      expect(h.busy.at(-1)![1]).toBe(false);
    }
    vi.useRealTimers();
  });
});
