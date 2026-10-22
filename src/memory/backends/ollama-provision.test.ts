import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGguf, modelfileText } from "./ollama-provision.js";

const BODY = Buffer.from("fake model bytes");
const SHA = createHash("sha256").update(BODY).digest("hex");
const fakeFetch = (data: Buffer, calls: string[] = []) => async (url: string) => {
  calls.push(url);
  return { ok: true, status: 200, body: new Response(new Uint8Array(data)).body };
};
const src = (data: Buffer, calls?: string[]) => ({ url: "http://x/m.gguf", size: BODY.length, sha256: SHA, fetchFn: fakeFetch(data, calls), log: () => {} });
const tmp = () => mkdtempSync(join(tmpdir(), "prov-"));

describe("ensureGguf", () => {
  it("downloads via .part, verifies, renames", async () => {
    const f = join(tmp(), "m.gguf");
    await ensureGguf(f, src(BODY));
    expect(readFileSync(f).equals(BODY)).toBe(true);
    expect(existsSync(`${f}.part`)).toBe(false);
  });
  it("a checksum mismatch deletes the download, leaves no final file, and says so", async () => {
    const f = join(tmp(), "m.gguf");
    await expect(ensureGguf(f, src(Buffer.from("fake model BYTES")))).rejects.toThrow(/Checksum mismatch.*deleted.*rerun/);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(`${f}.part`)).toBe(false);
  });
  it("a same-size corrupt file is replaced, a good one is kept", async () => {
    const f = join(tmp(), "m.gguf");
    writeFileSync(f, Buffer.from("fake model BYTES"));
    const calls: string[] = [];
    await ensureGguf(f, src(BODY, calls));
    expect(calls).toHaveLength(1);
    expect(readFileSync(f).equals(BODY)).toBe(true);
    await ensureGguf(f, src(BODY, calls));
    expect(calls).toHaveLength(1);
  });
});

describe("modelfileText", () => {
  it("quotes a path with a space", () => {
    expect(modelfileText("/a b/m.gguf")).toBe('FROM "/a b/m.gguf"\n');
  });
});
