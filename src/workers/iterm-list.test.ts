import { describe, expect, it } from "vitest";
import { listItermSessions, resolveHostSession, REBALANCE_SCRIPT } from "./pane.js";

describe("listItermSessions", () => {
  it("keeps a session whose name could not be read", async () => {
    const stdout = "A\t/dev/ttys001\t10\t11\tzsh\nB\t/dev/ttys002\t\t\t\nC\t/dev/ttys003\t30\t31\ta\tb\n";
    const got = await listItermSessions(async () => ({ stdout }));
    expect(got).toEqual([
      { id: "A", tty: "/dev/ttys001", jobPid: 10, pid: 11, name: "zsh" },
      { id: "B", tty: "/dev/ttys002", jobPid: undefined, pid: undefined, name: undefined },
      { id: "C", tty: "/dev/ttys003", jobPid: 30, pid: 31, name: "a\tb" },
    ]);
  });

  it("surfaces a script failure instead of an empty list", async () => {
    await expect(
      listItermSessions(async () => {
        throw new Error("osascript failed");
      })
    ).rejects.toThrow("osascript failed");
  });

  it("retries once when the script fails, then returns the sessions", async () => {
    let calls = 0;
    const got = await listItermSessions(async () => {
      if (++calls === 1) throw new Error("TypeError: null is not an object");
      return { stdout: "A\t/dev/ttys001\t10\t11\tzsh\n" };
    });
    expect(calls).toBe(2);
    expect(got.map((s) => s.id)).toEqual(["A"]);
  });

  it("guards every enumeration level against a closing window", async () => {
    let script = "";
    await listItermSessions(async (sc) => {
      script = sc;
      return { stdout: "" };
    });
    for (const src of [script, REBALANCE_SCRIPT]) {
      expect(src).toContain("try { return f() || []; } catch");
      expect(src).not.toMatch(/\bw\.tabs\(\)\.forEach|app\.windows\(\)\.forEach|=\s*ws\[i\]\.tabs\(\)/);
    }
  });

  it("resolveHostSession reports the listing failure", async () => {
    const r = await resolveHostSession({}, {
      psOf: () => null,
      commandsOf: () => new Map(),
      listSessions: async () => {
        throw new Error("osascript failed");
      },
    });
    expect(r.uid).toBe("");
    expect(r.reason).toContain("session listing failed: osascript failed");
  });
});
