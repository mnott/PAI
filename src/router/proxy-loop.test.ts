import { describe, it, expect } from "vitest";
import { monitorReply } from "./proxy-guard.js";
import { conversationKey, LoopStore } from "./proxy-loop.js";

const reply = (id: string, name: string, input: object) => JSON.stringify({ content: [{ type: "tool_use", id, name, input }] });
const write = { file_path: "/tmp/x.ts", content: "export const a = 1;\n" };

/** The request of turn n: the whole conversation so far, the model having written the same file n times. */
function request(n: number, opts: { system?: string; first?: string; user?: string } = {}) {
  const messages: object[] = [{ role: "user", content: opts.first ?? "make x.ts" }];
  for (let i = 1; i <= n; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Write", input: write }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "File written" }] });
  }
  return { system: opts.system ?? "sys", messages, ...(opts.user && { metadata: { user_id: opts.user } }) };
}

function harness() {
  const fired: { id: string; source?: string; model?: string }[] = [];
  const loops = new LoopStore();
  const turn = (req: unknown, n: number) =>
    monitorReply(reply(`t${n + 1}`, "Write", write), "application/json", "m", { rules: () => [], loops, record: (f) => fired.push(f) }, "p", req);
  return { fired, loops, turn };
}

describe("proxy loop state", () => {
  it("a model writing the same content three times fires identical-write (source proxy) on the third turn", () => {
    const { fired, turn } = harness();
    const seen: number[] = [];
    for (let n = 0; n < 3; n++) {
      turn(request(n), n);
      seen.push(fired.filter((f) => f.id === "identical-write").length);
    }
    expect(seen[0]).toBe(0);
    expect(seen[2]).toBeGreaterThan(0);
    expect(fired.filter((f) => f.id === "identical-write").every((f) => f.source === "proxy")).toBe(true);
  });

  it("without the request there is no loop state: nothing fires", () => {
    const { fired, turn } = harness();
    for (let n = 0; n < 3; n++) turn(undefined, n);
    expect(fired.filter((f) => f.id === "identical-write")).toHaveLength(0);
  });

  it("two conversations do not share state", () => {
    const { fired, turn } = harness();
    for (let n = 0; n < 3; n++) {
      turn(request(n, { first: "task A" }), n);
      turn(request(0, { first: `task B${n}` }), 0);
    }
    const a = fired.filter((f) => f.id === "identical-write").length;
    expect(a).toBeGreaterThan(0);
    // the second conversation alone, interleaved, never reached a repeat on its own
    const solo = harness();
    for (let n = 0; n < 3; n++) solo.turn(request(0, { first: `task B${n}` }), 0);
    expect(solo.fired.filter((f) => f.id === "identical-write")).toHaveLength(0);
  });

  it("the key follows system, first user message and metadata.user_id", () => {
    const k = conversationKey(request(1));
    expect(conversationKey(request(5))).toBe(k);
    expect(conversationKey(request(1, { system: "other" }))).not.toBe(k);
    expect(conversationKey(request(1, { user: "u" }))).not.toBe(k);
    expect(conversationKey({ system: "s", messages: [] })).toBeNull();
  });

  it("LRU: bounded by max, least recently used goes first, TTL expires", () => {
    const s = new LoopStore(3, 1000);
    const st = (n: number) => ({ writes: { [`f${n}`]: { key: "k", n, seen: [], reverts: 0 } } }) as never;
    for (let i = 0; i < 3; i++) s.set(`c${i}`, st(i), 0);
    s.set("c0", st(0), 1); // touch c0
    s.set("c3", st(3), 2);
    expect(s.size).toBe(3);
    expect(s.get("c1", 3).writes).toBeUndefined(); // evicted: fresh state
    expect(s.get("c0", 3).writes).toBeDefined();
    expect(s.get("c3", 5000).writes).toBeUndefined(); // expired
  });
});
