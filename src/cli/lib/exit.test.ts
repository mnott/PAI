import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const fixture = new URL("./exit-fixture.mjs", import.meta.url).pathname;

interface Result {
  code: number | null;
  bytes: number;
  stderr: string;
}

/** Run the fixture with stdout piped to a reader that starts late and reads in small steps. */
function run(size: number, reader: "slow" | "closed"): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fixture, String(size)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0;
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    if (reader === "closed") {
      child.stdout.destroy();
    } else {
      child.stdout.pause();
      setTimeout(() => {
        child.stdout.on("data", (d: Buffer) => {
          bytes += d.length;
          child.stdout.pause();
          setTimeout(() => child.stdout.resume(), 1);
        });
        child.stdout.resume();
      }, 30);
    }
    child.on("close", (code) => resolve({ code, bytes, stderr }));
  });
}

describe("drainStdio with a piped stdout", () => {
  for (const size of [10 * 1024, 200 * 1024]) {
    it(`exits 0 with full output for ${size} bytes`, async () => {
      for (let i = 0; i < 20; i++) {
        const r = await run(size, "slow");
        expect(r.stderr).not.toContain("unsettled top-level await");
        expect(r.code).toBe(0);
        expect(r.bytes).toBe(size);
      }
    }, 120_000);
  }

  it("does not hang when the reader has gone away", async () => {
    const r = await run(200 * 1024, "closed");
    expect(r.stderr).not.toContain("unsettled top-level await");
  }, 15_000);
});
