/**
 * Tests for the `engine: image` worker: a real local HTTP server standing in
 * for an OpenAI-compatible images API, so the request shape (body, bearer
 * header) and the file it writes are both verified end to end.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImageCapability } from "./image.js";
import { WorkersConfigError, type WorkerProvider } from "../config.js";

// the smallest possible valid PNG (1x1, transparent) — enough to prove
// bytes round-trip through base64 decode + file write untouched
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let server: Server;
let baseUrl: string;
let lastRequest: { path: string; auth: string | undefined; body: unknown } | null = null;
let responseOverride: { status: number; body: string } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastRequest = {
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      };
      if (responseOverride) {
        res.writeHead(responseOverride.status, { "content-type": "application/json" });
        res.end(responseOverride.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const dir = mkdtempSync(join(tmpdir(), "pai-image-engine-"));

function provider(overrides: Partial<WorkerProvider> = {}): WorkerProvider {
  return {
    enabled: true,
    protocol: "anthropic",
    baseUrl,
    keyFile: null,
    key: "test-image-key",
    models: { default: "example-image-model", image: "example-image-model" },
    engine: "image",
    env: {},
    ...overrides,
  };
}

describe("runImageCapability", () => {
  it("POSTs the OpenAI-compatible request body with a bearer header, writes the PNG, returns the result", async () => {
    responseOverride = null;
    const outPath = join(dir, "out.png");
    const result = await runImageCapability({
      providerName: "pictures",
      provider: provider(),
      model: "example-image-model",
      prompt: "a red circle",
      outPath,
      size: "512x512",
    });
    expect(lastRequest?.path).toBe("/images/generations");
    expect(lastRequest?.auth).toBe("Bearer test-image-key");
    expect(lastRequest?.body).toEqual({
      model: "example-image-model",
      prompt: "a red circle",
      size: "512x512",
      n: 1,
      response_format: "b64_json",
    });
    expect(result).toEqual({
      ok: true,
      path: outPath,
      model: "example-image-model",
      provider: "pictures",
      durationMs: expect.any(Number),
      bytes: expect.any(Number),
    });
    const written = readFileSync(outPath);
    expect(written.equals(Buffer.from(TINY_PNG_B64, "base64"))).toBe(true);
  });

  it("defaults the size to 1024x1024 when none is given", async () => {
    responseOverride = null;
    await runImageCapability({
      providerName: "pictures",
      provider: provider(),
      model: "example-image-model",
      prompt: "a blue square",
      outPath: join(dir, "default-size.png"),
    });
    expect((lastRequest?.body as { size: string }).size).toBe("1024x1024");
  });

  it("errors clearly when the provider has no url configured", async () => {
    await expect(
      runImageCapability({
        providerName: "no-url",
        provider: provider({ baseUrl: "" }),
        model: "example-image-model",
        prompt: "x",
        outPath: join(dir, "never.png"),
      })
    ).rejects.toThrow(/no "url" configured/);
  });

  it("surfaces a non-2xx response with the status and body", async () => {
    responseOverride = { status: 402, body: JSON.stringify({ error: "quota exceeded" }) };
    await expect(
      runImageCapability({
        providerName: "pictures",
        provider: provider(),
        model: "example-image-model",
        prompt: "x",
        outPath: join(dir, "never2.png"),
      })
    ).rejects.toThrow(/failed \(402\)/);
    responseOverride = null;
  });

  it("times out and reports it clearly, without hanging", async () => {
    const slow = createServer((req) => {
      req.on("data", () => {});
      // never responds — the client must give up on its own
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const addr = slow.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    try {
      await expect(
        runImageCapability({
          providerName: "slow",
          provider: provider({ baseUrl: `http://127.0.0.1:${addr.port}` }),
          model: "example-image-model",
          prompt: "x",
          outPath: join(dir, "never3.png"),
          timeoutMs: 50,
        })
      ).rejects.toThrow(WorkersConfigError);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
