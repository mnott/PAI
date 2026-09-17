/**
 * Tests for the chat line of a follow pane: visible-width measurement and
 * ANSI-aware wrapping (so the gutter stays the leftmost column), the scroll
 * region / insert-above-prompt escape sequences, prompt command parsing and
 * the auto-exit guard. Pure strings — no terminal, no worker.
 */

import { describe, it, expect } from "vitest";
import { makeColor } from "./render.js";
import {
  CHAT_HELP,
  CHAT_PROMPT,
  chatEnter,
  chatInsertLine,
  chatLeave,
  chatPromptRow,
  chatScrollRegion,
  chatTickerRow,
  holdAutoExit,
  parseChatLine,
  visibleWidth,
  wrapText,
} from "./chatui.js";

const color = makeColor(true);

describe("visibleWidth", () => {
  it("counts printable columns only — escapes measure zero", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("\x1b[31mabc\x1b[0m")).toBe(3);
    expect(visibleWidth(`${color("dim", "ab")}c`)).toBe(3);
    expect(visibleWidth("")).toBe(0);
  });

  it("never confuses CSI finals with content", () => {
    expect(visibleWidth("\x1b[2J\x1b[1;22rx")).toBe(1);
    expect(visibleWidth("\x1b7ab\x1b8")).toBe(2);
  });
});

describe("wrapText", () => {
  it("a 120-character line at 40 columns is three 40-column rows", () => {
    const rows = wrapText("x".repeat(120), 40);
    expect(rows).toHaveLength(3);
    expect(rows.map(visibleWidth)).toEqual([40, 40, 40]);
    expect(rows.join("")).toBe("x".repeat(120));
  });

  it("breaks on whitespace where possible", () => {
    expect(wrapText("aaa bbb ccc ddd", 7)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(wrapText("word word word", 4)).toEqual(["word", "word", "word"]);
  });

  it("hard-wraps a word longer than the width", () => {
    expect(wrapText("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });

  it("an oversized word after a short one fills the line, loses no chars", () => {
    expect(wrapText("a " + "y".repeat(10), 5)).toEqual(["a yyy", "yyyyy", "yy"]);
    // a wide gap before the oversized word: the word starts on a fresh row
    expect(wrapText("ab  " + "y".repeat(10), 5)).toEqual(["ab  y", "yyyyy", "yyyy"]);
  });

  it("keeps a leading indent on the first row", () => {
    expect(wrapText("    -removed line here", 10)).toEqual(["    -remov", "ed line", "here"]);
  });

  it("returns short lines untouched (no copy semantics surprises)", () => {
    expect(wrapText("short", 40)).toEqual(["short"]);
    expect(wrapText("x".repeat(40), 40)).toEqual(["x".repeat(40)]);
  });

  it("never splits an ANSI escape and carries colour to continuation rows", () => {
    const red = color("red", "y".repeat(100));
    const rows = wrapText(red, 40);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.startsWith("\x1b[31m")).toBe(true); // re-opened on every row
      expect(r.includes("\x1b[0m")).toBe(true); // closed again
    }
    // reassembled text has the same visible width and colour state
    expect(rows.map(visibleWidth)).toEqual([40, 40, 20]);
  });

  it("carries colour across a whitespace break inside a coloured span", () => {
    const rows = wrapText(color("green", "aa bb cc dd ee ff"), 5);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.startsWith("\x1b[32m")).toBe(true);
  });

  it("uncoloured rows gain no escapes", () => {
    for (const r of wrapText("z".repeat(90), 30)) expect(r).not.toContain("\x1b");
  });
});

// ---------------------------------------------------------------------------
// the layout: scroll region + fixed prompt/ticker rows
// ---------------------------------------------------------------------------

describe("scroll region layout", () => {
  it("setup restricts scrolling to rows 1..rows-2 and parks on the prompt row", () => {
    expect(chatScrollRegion(24)).toBe("\x1b[1;22r");
    expect(chatEnter(24)).toBe("\x1b[2J\x1b[1;22r\x1b[23;1H");
    expect(chatEnter(30)).toBe("\x1b[2J\x1b[1;28r\x1b[29;1H");
  });

  it("teardown resets the region and drops to the last row", () => {
    expect(chatLeave(24)).toBe("\x1b[r\x1b[?25h\x1b[24;1H");
  });

  it("degenerate heights clamp instead of going negative", () => {
    expect(chatScrollRegion(2)).toBe("\x1b[1;1r");
    expect(chatEnter(3)).toBe("\x1b[2J\x1b[1;1r\x1b[2;1H");
  });

  it("the ticker redraws its own row around a saved cursor", () => {
    expect(chatTickerRow("⋯ 7s", 24)).toBe("\x1b7\x1b[24;1H\x1b[K⋯ 7s\x1b8");
  });

  it("the prompt row parks on rows-1 with the marker and optional hint", () => {
    expect(chatPromptRow(24)).toBe("\x1b[23;1H" + CHAT_PROMPT);
    expect(chatPromptRow(24, CHAT_PROMPT, "hint")).toBe("\x1b[23;1H" + CHAT_PROMPT + "hint");
  });
});

describe("chatInsertLine", () => {
  it("fills the region top-down while it is still empty", () => {
    const a = chatInsertLine("one", 0, 22);
    expect(a.seq).toBe("\x1b7\x1b[1;1Hone\x1b[K\x1b8");
    expect(a.fill).toBe(1);
    const b = chatInsertLine("two", 1, 22);
    expect(b.seq).toBe("\x1b7\x1b[2;1Htwo\x1b[K\x1b8");
    expect(b.fill).toBe(2);
  });

  it("once full, scrolls the region with a newline at its bottom row", () => {
    const r = chatInsertLine("later", 22, 22);
    expect(r.seq).toBe("\x1b7\x1b[22;1H\nlater\x1b[K\x1b8");
    expect(r.fill).toBe(22); // stays full from here on
  });

  it("an empty line is a blank row (the turn separator)", () => {
    expect(chatInsertLine("", 0, 22).seq).toBe("\x1b7\x1b[1;1H\x1b[K\x1b8");
  });
});

// ---------------------------------------------------------------------------
// prompt commands
// ---------------------------------------------------------------------------

describe("parseChatLine", () => {
  it("recognises the three commands", () => {
    expect(parseChatLine("/help")).toEqual({ kind: "help" });
    expect(parseChatLine("/quit")).toEqual({ kind: "quit" });
    expect(parseChatLine("/status")).toEqual({ kind: "status" });
    expect(parseChatLine("  /status  ")).toEqual({ kind: "status" });
  });

  it("/resume carries its text; bare it comes back empty for the usage note", () => {
    expect(parseChatLine("/resume keep going")).toEqual({ kind: "resume", text: "keep going" });
    expect(parseChatLine("/resume")).toEqual({ kind: "resume", text: "" });
    expect(parseChatLine("/resume   spaced   ")).toEqual({ kind: "resume", text: "spaced" });
  });

  it("anything else is a message, trimmed", () => {
    expect(parseChatLine("  run the tests  ")).toEqual({ kind: "message", text: "run the tests" });
    expect(parseChatLine("/unknown")).toEqual({ kind: "message", text: "/unknown" });
  });

  it("empty input is an empty message the caller ignores", () => {
    expect(parseChatLine("   ")).toEqual({ kind: "message", text: "" });
  });

  it("the help text names the three commands", () => {
    const all = CHAT_HELP.join("\n");
    expect(all).toContain("/quit");
    expect(all).toContain("/resume <text>");
    expect(all).toContain("/status");
  });
});

describe("holdAutoExit", () => {
  it("holds while the prompt has unsent text", () => {
    expect(holdAutoExit("draft")).toBe(true);
    expect(holdAutoExit("  draft  ")).toBe(true);
  });

  it("does not hold for an empty or missing prompt", () => {
    expect(holdAutoExit("")).toBe(false);
    expect(holdAutoExit("   ")).toBe(false);
    expect(holdAutoExit(null)).toBe(false);
    expect(holdAutoExit(undefined)).toBe(false);
  });
});
