/** follow <id> without a terminal prints the transcript tail instead of streaming. */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsPath } from "./paths.js";
import { followTailOutput } from "./viewer.js";

function logWith(wid: string, n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "follow-tail-"));
  const p = eventsPath(dir, wid);
  mkdirSync(join(p, ".."), { recursive: true });
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `entry-${i}` }] } })
  );
  writeFileSync(p, lines.join("\n") + "\n");
  return dir;
}

describe("followTailOutput", () => {
  it("prints the last 20 entries and notes it on stderr when stdout is not a TTY", () => {
    const dir = logWith("w-1", 30);
    const errs: string[] = [];
    const text = followTailOutput(dir, "w-1", { live: false, autoExit: false }, {}, false, (s) => errs.push(s));
    expect(text).toContain("entry-29");
    expect(text).toContain("entry-10");
    expect(text).not.toContain("entry-9\n");
    expect(errs.join("")).toBe("follow: no terminal, printed the last 20 entries (use --live to stream)\n");
  });

  it("honours --tail", () => {
    const dir = logWith("w-1", 30);
    const text = followTailOutput(dir, "w-1", { live: false, autoExit: false, tail: 2 }, {}, false, () => {});
    expect(text).toContain("entry-29");
    expect(text).not.toContain("entry-27");
  });

  it("treats PAI_WORKER=1 as no terminal even on a TTY", () => {
    const dir = logWith("w-1", 3);
    expect(followTailOutput(dir, "w-1", { live: false, autoExit: false }, { PAI_WORKER: "1" }, true, () => {})).not.toBeNull();
  });

  it("returns null (keep streaming) with --live or --auto-exit", () => {
    const dir = logWith("w-1", 3);
    expect(followTailOutput(dir, "w-1", { live: true, autoExit: false }, {}, false)).toBeNull();
    expect(followTailOutput(dir, "w-1", { live: false, autoExit: true }, {}, false)).toBeNull();
  });

  it("is unchanged on a TTY and without a target", () => {
    const dir = logWith("w-1", 3);
    expect(followTailOutput(dir, "w-1", { live: false, autoExit: false }, {}, true)).toBeNull();
    expect(followTailOutput(dir, null, { live: false, autoExit: false }, {}, false)).toBeNull();
  });
});
