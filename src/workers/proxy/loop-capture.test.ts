/**
 * loop-capture.test.ts — the loop guard's request capture: the last 3 translated
 * turns of a local run are written on a simulated loop-stop, secrets stripped,
 * and the in-memory ring stays bounded.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  LoopCaptureRing,
  LOOP_CAPTURE_KEEP,
  captureOnLoopStop,
  maybeFlushLoopCapture,
  stripSecrets,
  writeLoopCapture,
  loopCapturePath,
} from "./loop-capture.js";
import { createProxyServer, listenProxy, type ProviderResolver } from "./server.js";
import type { WorkerProvider } from "../config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "loop-capture-"));
}

function provider(baseUrl: string): WorkerProvider {
  return {
    name: "local",
    enabled: true,
    protocol: "openai",
    baseUrl,
    upstreamUrl: baseUrl,
    keyFile: null,
    models: { default: "m", tiers: {} },
  } as unknown as WorkerProvider;
}

describe("LoopCaptureRing", () => {
  it("keeps the last 3 turns, oldest dropped", () => {
    const ring = new LoopCaptureRing();
    for (let i = 1; i <= 5; i++) ring.record("w1", { n: i }, `resp${i}`);
    const turns = ring.get("w1");
    expect(turns.length).toBe(LOOP_CAPTURE_KEEP);
    expect(turns.map((t) => (t.request as { n: number }).n)).toEqual([3, 4, 5]);
    expect(turns.map((t) => t.response)).toEqual(["resp3", "resp4", "resp5"]);
  });

  it("bounds memory by bytes: drops oldest until under the budget", () => {
    const ring = new LoopCaptureRing(10, 1000);
    const big = "x".repeat(400);
    for (let i = 0; i < 10; i++) ring.record("w1", { i }, big);
    const turns = ring.get("w1");
    expect(turns.length).toBeLessThan(10);
    let bytes = 0;
    for (const t of turns) bytes += Buffer.byteLength(JSON.stringify(t));
    expect(bytes).toBeLessThanOrEqual(1000);
    // the newest turn always survives
    expect((turns[turns.length - 1].request as { i: number }).i).toBe(9);
  });

  it("tracks runs separately", () => {
    const ring = new LoopCaptureRing();
    ring.record("a", { n: 1 }, "ra");
    ring.record("b", { n: 2 }, "rb");
    expect(ring.get("a").length).toBe(1);
    expect(ring.get("b").length).toBe(1);
    expect(ring.size).toBe(2);
    ring.clear("a");
    expect(ring.get("a")).toEqual([]);
  });
});

describe("stripSecrets", () => {
  it("drops auth headers and api-key keys at any depth", () => {
    const v = stripSecrets({
      headers: { authorization: "Bearer sk-top", "x-api-key": "sk-top", "content-type": "application/json" },
      nested: { api_key: "sk-deep", token: "t", secret: "s", keep: 1 },
      list: [{ Authorization: "Bearer x" }, { ok: true }],
    });
    const s = JSON.stringify(v);
    expect(s).not.toContain("sk-top");
    expect(s).not.toContain("sk-deep");
    expect(s).not.toContain("Bearer");
    expect(s).toContain("application/json");
    expect(s).toContain("keep");
  });
});

describe("writeLoopCapture", () => {
  it("writes mode 600 and a ledger line", () => {
    const dir = tempDir();
    try {
      const path = writeLoopCapture(dir, "w1", [{ ts: "t", request: { a: 1 }, response: "r" }], "loop guard");
      expect(path).toBe(loopCapturePath(dir, "w1"));
      if (!path) throw new Error("capture not written");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).turns.length).toBe(1);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const ledger = readFileSync(join(dir, "ledger.log"), "utf8");
      expect(ledger).toContain(`LOOP-CAPTURE id=w1 path=${path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when there are no turns", () => {
    const dir = tempDir();
    try {
      expect(writeLoopCapture(dir, "w1", [], "loop guard")).toBeNull();
      expect(existsSync(loopCapturePath(dir, "w1"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("maybeFlushLoopCapture", () => {
  it("flushes on a loop-stop marker for a local provider", () => {
    const dir = tempDir();
    try {
      const ring = new LoopCaptureRing();
      ring.record("w1", { n: 1 }, "r1");
      ring.record("w1", { n: 2 }, "r2");
      writeFileSync(join(dir, "w1.loop-stop"), JSON.stringify({ ts: "t", reason: "same call 5 times" }));
      const path = maybeFlushLoopCapture(dir, "w1", "http://127.0.0.1:1234", ring);
      expect(path).toBe(loopCapturePath(dir, "w1"));
      if (!path) throw new Error("capture not written");
      const cap = JSON.parse(readFileSync(path, "utf8"));
      expect(cap.reason).toBe("same call 5 times");
      expect(cap.turns.length).toBe(2);
      expect(ring.get("w1")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not capture for a cloud provider", () => {
    const dir = tempDir();
    try {
      const ring = new LoopCaptureRing();
      ring.record("w1", { n: 1 }, "r1");
      writeFileSync(join(dir, "w1.loop-stop"), JSON.stringify({ ts: "t", reason: "loop" }));
      expect(maybeFlushLoopCapture(dir, "w1", "https://api.anthropic.com", ring)).toBeNull();
      expect(existsSync(loopCapturePath(dir, "w1"))).toBe(false);
      expect(ring.get("w1").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing without a marker", () => {
    const dir = tempDir();
    try {
      const ring = new LoopCaptureRing();
      ring.record("w1", { n: 1 }, "r1");
      expect(maybeFlushLoopCapture(dir, "w1", "http://127.0.0.1:1234", ring)).toBeNull();
      expect(ring.get("w1").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureOnLoopStop", () => {
  it("writes what the ring holds and clears it", () => {
    const dir = tempDir();
    try {
      const ring = new LoopCaptureRing();
      ring.record("w1", { n: 1 }, "r1");
      const path = captureOnLoopStop(dir, "w1", "loop guard", ring);
      expect(path).toBe(loopCapturePath(dir, "w1"));
      expect(ring.get("w1")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when the ring is empty (cloud run)", () => {
    const dir = tempDir();
    try {
      expect(captureOnLoopStop(dir, "w1", "loop guard", new LoopCaptureRing())).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("proxy end-to-end: loop-guard stop writes the capture", () => {
  it("a simulated loop-stop after 5 turns captures the last 3, no auth header", async () => {
    const dir = tempDir();
    // fake upstream: a local http server answering chat/completions
    const fake = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: `echo ${body.length}` } }] }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const port = (fake.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const resolve: ProviderResolver = () => ({ local: provider(baseUrl) });
    const ring = new LoopCaptureRing();
    const server = createProxyServer({ resolveProvider: resolve, captureRing: ring, captureLogDir: dir });
    const proxyPort = await listenProxy(server, 0);

    try {
      for (let i = 1; i <= 5; i++) {
        const res = await fetch(`http://127.0.0.1:${proxyPort}/local/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "sk-secret" },
          body: JSON.stringify({
            model: "m",
            max_tokens: 10,
            metadata: { user_id: "run-1" },
            messages: [{ role: "user", content: `turn ${i}` }],
          }),
        });
        expect(res.status).toBe(200);
      }
      expect(ring.get("run-1").length).toBe(3);

      // simulate the loop guard stopping the worker
      writeFileSync(join(dir, "run-1.loop-stop"), JSON.stringify({ ts: "t", reason: "identical call repeated" }));
      const res = await fetch(`http://127.0.0.1:${proxyPort}/local/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 10, metadata: { user_id: "run-1" }, messages: [{ role: "user", content: "after stop" }] }),
      });
      expect(res.status).toBe(200);

      const path = loopCapturePath(dir, "run-1");
      expect(existsSync(path)).toBe(true);
      const cap = JSON.parse(readFileSync(path, "utf8"));
      expect(cap.turns.length).toBe(3);
      expect(cap.reason).toBe("identical call repeated");
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain("sk-secret");
      expect(raw).not.toContain("Bearer");
      expect(raw.toLowerCase()).not.toContain("authorization");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const ledger = readFileSync(join(dir, "ledger.log"), "utf8");
      expect(ledger).toContain(`LOOP-CAPTURE id=run-1 path=${path}`);
    } finally {
      server.close();
      fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
