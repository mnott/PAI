import { describe, expect, it } from "vitest";
import type { Messenger } from "./run-events.js";
import { TroubleWatcher } from "./worker-trouble.js";
import { troublePolicy } from "./notice-policy.js";

function setup() {
  const sent: string[] = [];
  const pailot: string[] = [];
  const msg: Messenger = {
    async toSession(_o, text) {
      sent.push(text);
      return true;
    },
    async toPailot(text) {
      pailot.push(text);
      return true;
    },
  };
  let t = 1_000_000;
  const w = new TroubleWatcher("w1", "status line route", msg, { name: "main" }, () => t);
  return { w, sent, pailot, advance: (ms: number) => (t += ms) };
}

describe("TroubleWatcher", () => {
  it("the 3rd denial in the window sends one message, never to PAILot", async () => {
    const { w, sent, pailot, advance } = setup();
    w.onDenial("/h/loop-guard.mjs", "re-running the same test without changes");
    advance(1000);
    w.onDenial("/h/loop-guard.mjs", "x");
    expect(sent).toHaveLength(0);
    advance(1000);
    w.onDenial("/h/loop-guard.mjs", "re-running the same test without changes");
    await w.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^S i=w1 z=guard-denials .*blocked 3x by loop-guard in 10 min: re-running the same test/);
    expect(pailot).toHaveLength(0);
  });

  it("denials spread over more than the window do not count", async () => {
    const { w, sent, advance } = setup();
    for (let i = 0; i < 4; i++) {
      w.onDenial("h", "r");
      advance(6 * 60_000);
    }
    await w.flush();
    expect(sent).toHaveLength(0);
  });

  it("throttles to one message per 5 min", async () => {
    const { w, sent, advance } = setup();
    for (let i = 0; i < 6; i++) w.onDenial("h", "r");
    await w.flush();
    expect(sent).toHaveLength(1);
    advance(troublePolicy().throttleMs + 1);
    w.onDenial("h", "r");
    await w.flush();
    expect(sent).toHaveLength(2);
  });

  it("the hard stop is always sent, even inside the throttle", async () => {
    const { w, sent } = setup();
    for (let i = 0; i < 3; i++) w.onDenial("h", "r");
    w.onLoopStop("same command 6 times");
    await w.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("z=loop-stopped");
  });

  it("stall: quiet for 10 min while running tells once; activity re-arms", async () => {
    const { w, sent, advance } = setup();
    advance(troublePolicy().stallMs - 1000);
    w.tick();
    expect(sent).toHaveLength(0);
    advance(2000);
    w.tick();
    w.tick();
    await w.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("z=stalled");
    w.activity();
    advance(troublePolicy().stallMs + troublePolicy().throttleMs);
    w.tick();
    await w.flush();
    expect(sent).toHaveLength(2);
  });

  it("an unreachable messenger does not throw", async () => {
    const msg: Messenger = { toSession: () => Promise.reject(new Error("down")), toPailot: async () => false };
    const w = new TroubleWatcher("w", "", msg, {}, () => 0);
    w.onLoopStop("r");
    await expect(w.flush()).resolves.toBeUndefined();
  });
});
