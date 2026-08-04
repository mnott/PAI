/**
 * Wire-format tests for the AIBroker IPC client.
 *
 * These exist because `sendToSession` was written as
 *
 *     callAiBroker("send_to_session", { sessionId, text })
 *
 * — the shape of the function's own parameters rather than the shape of the
 * IPC, which takes `{ target, message }`. Every call was rejected with
 * "target is required" before the handler looked at anything else.
 *
 * It survived because `pai pause all` was the sole caller and its `--dry-run`
 * branch returns before sending. The dry run was the only branch anyone ran, so
 * a command that could never work reported all 15 sessions correctly enumerated
 * right up until the moment it was used in anger.
 *
 * The confusion is understandable and worth pinning against: `sessionId` IS a
 * real field on the request envelope — it identifies the CALLER. The recipient
 * is `params.target`. One name, two meanings, one layer apart.
 *
 * So these assert the bytes on the wire rather than the arguments in, which is
 * the only level at which a cross-repo contract like this is actually testable
 * from here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/** Captures whatever the client writes, and replies with a canned success. */
const written: string[] = [];

class FakeSocket extends EventEmitter {
  write(data: string): boolean {
    written.push(data);
    // Answer on the next tick so the client's handlers are attached first.
    setImmediate(() => this.emit("data", Buffer.from(JSON.stringify({ ok: true, result: {} }) + "\n")));
    return true;
  }
  destroy(): void {
    /* no socket to close */
  }
}

vi.mock("node:net", () => ({
  connect: (_path: string, onConnect: () => void) => {
    const s = new FakeSocket();
    setImmediate(onConnect);
    return s;
  },
}));

/** The single JSON request the client sent. */
function sentRequest(): { method: string; params: Record<string, unknown>; sessionId?: string } {
  expect(written).toHaveLength(1);
  return JSON.parse(written[0]);
}

describe("sendToSession wire format", () => {
  beforeEach(() => {
    written.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("addresses the recipient as params.target", async () => {
    const { sendToSession } = await import("./aibroker-client.js");
    const r = await sendToSession("7552A02E-E322-4891-82E9-BCD6778B068D", "pause session");
    expect(r.ok).toBe(true);
    // The exact key the handler validates. `sessionId` here fails outright.
    expect(sentRequest().params.target).toBe("7552A02E-E322-4891-82E9-BCD6778B068D");
  });

  it("carries the body as params.message", async () => {
    const { sendToSession } = await import("./aibroker-client.js");
    await sendToSession("uuid-1", "pause session");
    expect(sentRequest().params.message).toBe("pause session");
  });

  it("sends neither of the names this was originally written with", async () => {
    // Both were wrong. `target` was merely the one validated first, so fixing
    // only that would have delivered an empty message to the right session.
    const { sendToSession } = await import("./aibroker-client.js");
    await sendToSession("uuid-1", "pause session");
    const { params } = sentRequest();
    expect(params.text).toBeUndefined();
    expect(params.sessionId).toBeUndefined();
  });

  it("keeps the caller's own id on the envelope, not in params", async () => {
    // This is the distinction that made the bug plausible: the envelope really
    // does have a sessionId, and it means "who is calling".
    vi.stubEnv("TERM_SESSION_ID", "caller-abc");
    const { sendToSession } = await import("./aibroker-client.js");
    await sendToSession("recipient-xyz", "pause session");
    const req = sentRequest();
    expect(req.sessionId).toBe("caller-abc");
    expect(req.params.target).toBe("recipient-xyz");
  });

  it("does not append a newline — the transport adds Enter itself", async () => {
    // sendText is called with { enter: true }. A trailing \n therefore submits
    // twice: once for the text, once for an empty prompt.
    const { sendToSession } = await import("./aibroker-client.js");
    await sendToSession("uuid-1", "pause session");
    expect(sentRequest().params.message).not.toMatch(/\n$/);
  });

  it("reports the handler's own error rather than throwing", async () => {
    // How the failure surfaced: 15 identical "FAILED: Error: target is required"
    // lines. Worth keeping — a throw here would have aborted the whole loop on
    // the first session instead of reporting each.
    vi.resetModules();
    vi.doMock("node:net", () => ({
      connect: (_p: string, onConnect: () => void) => {
        const s = new (class extends EventEmitter {
          write(): boolean {
            setImmediate(() =>
              this.emit("data", Buffer.from(JSON.stringify({ ok: false, error: "target is required" }) + "\n"))
            );
            return true;
          }
          destroy(): void {}
        })();
        setImmediate(onConnect);
        return s;
      },
    }));
    const { sendToSession } = await import("./aibroker-client.js");
    const r = await sendToSession("", "pause session");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("target is required");
    vi.doUnmock("node:net");
    vi.resetModules();
  });
});
