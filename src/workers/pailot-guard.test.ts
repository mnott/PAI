/** The PAILot gate: one message per text, a per-minute cap, a summary and a ledger entry on overflow. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardedPailot, PAILOT_MAX_PER_MIN } from "./pailot-guard.js";

describe("guardedPailot", () => {
  let dir: string;
  const sent: string[] = [];
  const send = async (t: string) => (sent.push(t), true);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-pg-"));
    sent.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the same text goes out once, also after a restart (persisted)", async () => {
    expect(await guardedPailot(dir, "run X ended", send)).toBe(true);
    for (let i = 0; i < 50; i++) expect(await guardedPailot(dir, "run X ended", send)).toBe(false);
    expect(sent).toEqual(["run X ended"]);
  });
  it("a flood of distinct texts: 5 per minute, one summary, ledger entry; next minute flows again", async () => {
    let t = 1_000_000;
    for (let i = 0; i < 200; i++) await guardedPailot(dir, `msg ${i}`, send, () => t);
    expect(sent.length).toBe(PAILOT_MAX_PER_MIN + 1);
    expect(sent[PAILOT_MAX_PER_MIN]).toMatch(/held back/);
    expect(readFileSync(join(dir, "ledger.log"), "utf8").match(/PAILOT-RATE-LIMIT/g)?.length).toBe(195);
    t += 61_000;
    expect(await guardedPailot(dir, "later", send, () => t)).toBe(true);
  });
});
