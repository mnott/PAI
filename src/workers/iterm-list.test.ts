import { describe, expect, it } from "vitest";
import { listItermSessions } from "./pane.js";

describe("listItermSessions", () => {
  it("keeps a session whose name could not be read", async () => {
    const stdout = "A\t/dev/ttys001\tzsh\nB\t/dev/ttys002\t\nC\t/dev/ttys003\ta\tb\n";
    const got = await listItermSessions(async () => ({ stdout }));
    expect(got).toEqual([
      { id: "A", tty: "/dev/ttys001", name: "zsh" },
      { id: "B", tty: "/dev/ttys002", name: undefined },
      { id: "C", tty: "/dev/ttys003", name: "a\tb" },
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
