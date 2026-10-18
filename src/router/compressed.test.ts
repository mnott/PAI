import { describe, it, expect } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import { parseWorkersConfig } from "../workers/config.js";
import { createRouter, decodeBody } from "./router.js";

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const plain = Buffer.from(JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hello" }] }));

const encoders: Record<string, (b: Buffer) => Buffer> = {
  gzip: zlib.gzipSync,
  deflate: zlib.deflateSync,
  br: zlib.brotliCompressSync,
};

describe("compressed request bodies", () => {
  it("decodeBody handles identity, gzip, deflate, br, corrupt and unknown", () => {
    for (const [enc, fn] of Object.entries(encoders)) {
      const r = decodeBody(fn(plain), enc);
      expect(r.ok && r.body.equals(plain)).toBe(true);
    }
    expect(decodeBody(plain, undefined)).toMatchObject({ ok: true, encoded: false });
    expect(decodeBody(Buffer.from("not gzip"), "gzip")).toMatchObject({ ok: false, status: 400 });
    expect(decodeBody(plain, "zstd")).toMatchObject({ ok: false, status: 415 });
  });

  it("routes by model like a plain body; upstream gets plain body, no Content-Encoding, right length", async () => {
    const seen: Array<{ headers: http.IncomingHttpHeaders; body: string; url?: string }> = [];
    const up = http.createServer((req, res) => {
      const c: Buffer[] = [];
      req.on("data", (x) => c.push(x));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: Buffer.concat(c).toString(), url: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const upPort = await listen(up);
    const prov = parseWorkersConfig({
      providers: { p: { baseUrl: `http://127.0.0.1:${upPort}/provider`, models: { default: "glm-5.3" } } },
    }).providers;
    const logs: string[] = [];
    const r = createRouter(() => prov, `http://127.0.0.1:${upPort}/w/claude`, (l) => logs.push(l));
    const port = await listen(r);
    const post = (data: Buffer, enc?: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const q = http.request(
          { port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { ...(enc ? { "content-encoding": enc } : {}), "content-length": data.length } },
          (x) => {
            let b = "";
            x.on("data", (c) => (b += c));
            x.on("end", () => resolve({ status: x.statusCode ?? 0, body: b }));
          }
        );
        q.end(data);
      });
    try {
      expect((await post(plain)).status).toBe(200);
      const base = seen[0]!;
      expect(logs.some((l) => l.includes("compressed"))).toBe(false);
      for (const [enc, fn] of Object.entries(encoders)) {
        seen.length = 0;
        expect((await post(fn(plain), enc)).status).toBe(200);
        const s = seen[0]!;
        expect(s.url).toBe(base.url);
        expect(s.body).toBe(base.body);
        expect(s.headers["content-encoding"]).toBeUndefined();
        expect(s.headers["content-length"]).toBe(String(Buffer.byteLength(s.body)));
      }
      expect(logs.filter((l) => l.includes("router: request bodies arrive")).length).toBe(1);
      seen.length = 0;
      const bad = await post(Buffer.from("garbage"), "gzip");
      expect(bad.status).toBe(400);
      expect(bad.body).toContain("not valid gzip");
      expect((await post(plain, "zstd")).status).toBe(415);
      expect(seen).toEqual([]);
    } finally {
      r.close();
      up.close();
    }
  });
});
