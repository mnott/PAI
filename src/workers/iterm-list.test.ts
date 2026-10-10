import { describe, expect, it } from "vitest";
import { listItermSessions } from "./pane.js";

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
});
