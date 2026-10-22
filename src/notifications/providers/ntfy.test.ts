import { describe, it, expect, vi, afterEach } from "vitest";
import { NtfyProvider } from "./ntfy.js";
import type { NotificationConfig } from "../types.js";

const config = {
  mode: "auto",
  channels: { ntfy: { enabled: true, url: "https://ntfy.invalid/t" } },
  routing: {},
} as unknown as NotificationConfig;

afterEach(() => vi.unstubAllGlobals());

describe("NtfyProvider title header", () => {
  it("RFC 2047-encodes a non-Latin-1 title so Headers accepts it", async () => {
    let sent: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      new Headers(sent); // throws on chars > U+00FF
      return { ok: true };
    });
    const ok = await new NtfyProvider().send({ event: "info", title: "Done \u{1F389}", message: "m" }, config);
    expect(ok).toBe(true);
    const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(sent["Title"]);
    expect(Buffer.from(m![1], "base64").toString("utf8")).toBe("Done \u{1F389}");
  });

  it("leaves an ASCII title unchanged", async () => {
    let sent: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return { ok: true };
    });
    await new NtfyProvider().send({ event: "info", title: "Plain", message: "m" }, config);
    expect(sent["Title"]).toBe("Plain");
  });
});
