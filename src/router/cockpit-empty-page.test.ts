import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleCockpit } from "./cockpit.js";

vi.mock("./cockpit-page.js", () => ({ cockpitHtml: () => "" }));

describe("GET /cockpit never answers 200 with an empty body", () => {
  it("answers 503 when the page is empty, with a body and a retry hint", () => {
    const headers: Record<string, unknown> = {};
    let status = 0;
    let body = "";
    const res = {
      setHeader: (k: string, v: unknown) => void (headers[k] = v),
      writeHead: (s: number, h: Record<string, unknown>) => {
        status = s;
        Object.assign(headers, h);
      },
      end: (b: string) => void (body = b),
    } as unknown as http.ServerResponse;
    const req = { url: "/cockpit", method: "GET" } as http.IncomingMessage;
    const handled = handleCockpit(req, res, { get: async () => [] } as never, () => [], () => new Map(), undefined, () => []);
    expect(handled).toBe(true);
    expect(status).toBe(503);
    expect(body).not.toBe("");
    expect(headers["retry-after"]).toBe("1");
    expect(headers["content-length"]).toBe(Buffer.byteLength(body));
  });
});
