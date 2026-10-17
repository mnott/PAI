/**
 * generateSystemdUnit is the systemd-user-unit analogue of the launchd plist:
 * a pure function so the unit's shape (ExecStart, Restart=on-failure) is
 * pinned without touching a real systemd instance.
 */

import { describe, it, expect } from "vitest";
import { generateSystemdUnit, ensureLinger } from "./daemon.js";

describe("generateSystemdUnit", () => {
  it("runs the resolved daemon entry via the given node binary with the serve subcommand", () => {
    const unit = generateSystemdUnit("/repo/dist/daemon/index.mjs", "/usr/bin/node");
    expect(unit).toContain("ExecStart=/usr/bin/node /repo/dist/daemon/index.mjs serve");
  });

  it("restarts on failure so it behaves like the launchd KeepAlive plist", () => {
    const unit = generateSystemdUnit("/repo/dist/daemon/index.mjs", "/usr/bin/node");
    expect(unit).toContain("Restart=on-failure");
  });

  it("is a user-scoped unit wanted by the default target", () => {
    const unit = generateSystemdUnit("/repo/dist/daemon/index.mjs", "/usr/bin/node");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("ensureLinger", () => {
  const run = (states: string[], enableOk: boolean) => {
    const calls: string[][] = [];
    const out: string[] = [];
    const runner = (args: string[]) => {
      calls.push(args);
      if (args[0] === "show-user") return { status: 0, stdout: `Linger=${states.shift() ?? "no"}\n` };
      return { status: enableOk ? 0 : 1, stdout: "" };
    };
    ensureLinger("linux", "alice", runner, (s) => out.push(s));
    return { calls, out: out.join("\n") };
  };
  const enables = (calls: string[][]) => calls.filter((c) => c[0] === "--no-ask-password");

  it("does nothing when linger is already on", () => {
    const { calls, out } = run(["yes"], true);
    expect(enables(calls)).toHaveLength(0);
    expect(out).toBe("");
  });

  it("enables linger without sudo and reports on", () => {
    const { calls, out } = run(["no", "yes"], true);
    expect(enables(calls)).toEqual([["--no-ask-password", "enable-linger", "alice"]]);
    expect(out).toContain("linger: on (daemon survives logout)");
  });

  it("prints the sudo advice when enabling fails", () => {
    const { out } = run(["no", "no"], false);
    expect(out).toContain("sudo loginctl enable-linger alice");
  });

  it("does nothing off Linux", () => {
    const calls: string[][] = [];
    ensureLinger("darwin", "alice", (a) => (calls.push(a), { status: 0, stdout: "" }), () => {});
    expect(calls).toHaveLength(0);
  });
});
