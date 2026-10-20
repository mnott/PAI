/**
 * pane-title.ts tests: the escape helpers, the OSC sequences the follow /
 * pane-run start writes, and the tmux pane-title path — no real tmux, no real
 * terminal.
 */

import { describe, expect, it, vi } from "vitest";
import { escapePaneTitle, paneTitle, writePaneTitle } from "./pane-title.js";

describe("escapePaneTitle", () => {
  it("drops control chars (ESC, BEL, NUL) and quotes, collapses whitespace", () => {
    expect(escapePaneTitle('cockpit: fit  viewport')).toBe("cockpit: fit viewport");
    expect(escapePaneTitle('a\x1b]2;b\x07c\x00d\x7f"e')).toBe("a ]2;b c d e");
  });

  it("caps at ~40 chars", () => {
    expect(escapePaneTitle("x".repeat(100))).toHaveLength(40);
  });
});

describe("paneTitle", () => {
  it("worker pane: label · provider or model, label capped at ~40", () => {
    expect(paneTitle("cockpit: fit viewport", "gyro-m")).toBe("cockpit: fit viewport · gyro-m");
    expect(paneTitle("x".repeat(60), "gyro-m")).toBe(`${"x".repeat(40)} · gyro-m`);
  });

  it("pane-run pane: the label alone", () => {
    expect(paneTitle("tests")).toBe("tests");
    expect(paneTitle("tests", "")).toBe("tests");
  });

  it("an empty label yields no title at all", () => {
    expect(paneTitle("", "gyro-m")).toBe("");
    expect(paneTitle("\x07\x1b", "gyro-m")).toBe("");
  });
});

describe("writePaneTitle", () => {
  it("emits OSC 1 and OSC 2 with the escaped title", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writePaneTitle('cockpit: fit\x1b viewport · gyro-m', {}, undefined, true);
      const written = err.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toBe("\x1b]1;cockpit: fit viewport · gyro-m\x07\x1b]2;cockpit: fit viewport · gyro-m\x07");
    } finally {
      err.mockRestore();
    }
  });

  it("writes no OSC sequences when not a terminal, but still sets the tmux title", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tmux = vi.fn();
    try {
      writePaneTitle("tests", { TMUX: "x" }, tmux, false);
      expect(err.mock.calls.length).toBe(0);
      expect(tmux).toHaveBeenCalledWith(["select-pane", "-T", "tests"]);
    } finally {
      err.mockRestore();
    }
  });

  it("writes nothing for an empty title", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writePaneTitle("", {}, undefined, true);
      expect(err.mock.calls.length).toBe(0);
    } finally {
      err.mockRestore();
    }
  });

  it("tmux: sets the pane title with select-pane -T, targeting TMUX_PANE", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tmux = vi.fn();
    try {
      writePaneTitle("tests", { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" }, tmux, true);
      expect(tmux).toHaveBeenCalledWith(["select-pane", "-t", "%3", "-T", "tests"]);
      // the OSC sequences go out too, so the title holds outside tmux as well
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("\x1b]2;tests\x07");
    } finally {
      err.mockRestore();
    }
  });

  it("tmux without TMUX_PANE: select-pane -T without a target; a failing tmux is swallowed", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const tmux = vi.fn(() => {
        throw new Error("no server");
      });
      writePaneTitle("tests", { TMUX: "x" }, tmux, true);
      expect(tmux).toHaveBeenCalledWith(["select-pane", "-T", "tests"]);
    } finally {
      err.mockRestore();
    }
  });
});
