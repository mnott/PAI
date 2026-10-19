import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { makeStyle } from "../help.js";
import { displayRows, filterItems, groupKeyState, pickerKey, pickerView, runPicker, readOneKey, type Key, type PickerOpts, type TtyIn } from "./picker.js";

const st = makeStyle(false);
const items = [
  { name: "alpha site", project: "web" },
  { name: "beta api", project: "backend" },
  { name: "alpha docs", project: "docs" },
];
const opts: PickerOpts<(typeof items)[number]> = {
  headers: ["Name", "Project"],
  items,
  cells: (i) => [i.name, i.project],
  searchText: (i) => `${i.name} ${i.project}`,
  footer: "keys",
};

/** A fake TTY: emits keypress events like readline would. */
class FakeIn extends EventEmitter {
  isTTY = true;
  raw = false;
  paused = true;
  setRawMode(on: boolean) {
    this.raw = on;
  }
  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  press(str: string | undefined, key: Key) {
    this.emit("keypress", str, key);
  }
}

describe("filterItems", () => {
  it("requires every word, case-insensitively", () => {
    expect(filterItems(items, "ALPHA do", opts.searchText).map((i) => i.name)).toEqual(["alpha docs"]);
    expect(filterItems(items, "", opts.searchText)).toHaveLength(3);
  });
});

describe("pickerKey", () => {
  const s0 = { filter: "", cursor: 0 };
  it("moves within bounds", () => {
    expect(pickerKey(s0, undefined, { name: "up" }, 3).state.cursor).toBe(0);
    expect(pickerKey(s0, undefined, { name: "down" }, 3).state.cursor).toBe(1);
    expect(pickerKey({ filter: "", cursor: 2 }, undefined, { name: "down" }, 3).state.cursor).toBe(2);
  });
  it("types, deletes and resets the cursor", () => {
    const t = pickerKey({ filter: "a", cursor: 2 }, "b", { name: "b" }, 3).state;
    expect(t).toEqual({ filter: "ab", cursor: 0 });
    expect(pickerKey(t, undefined, { name: "backspace" }, 3).state.filter).toBe("a");
  });
  it("Enter selects only when something is shown; Esc and Ctrl-C cancel", () => {
    expect(pickerKey(s0, "\r", { name: "return" }, 2).action).toBe("select");
    expect(pickerKey(s0, "\r", { name: "return" }, 0).action).toBe("none");
    expect(pickerKey(s0, undefined, { name: "escape" }, 2).action).toBe("cancel");
    expect(pickerKey(s0, "\u0003", { name: "c", ctrl: true }, 2).action).toBe("cancel");
  });
  it("Ctrl-G triggers cd action", () => {
    expect(pickerKey(s0, undefined, { name: "g", ctrl: true }, 2).action).toBe("cd");
  });
});

describe("pickerView", () => {
  it("renders a header row, a marker on the cursor row and the footer", () => {
    const lines = pickerView({ filter: "", cursor: 1 }, opts, st);
    const text = lines.join("\n");
    expect(text).toContain("Name");
    expect(lines.find((l) => l.startsWith("›"))).toContain("beta api");
    expect(text).toContain("keys");
  });
  it("says so when the filter matches nothing", () => {
    expect(pickerView({ filter: "zzz", cursor: 0 }, opts, st).join("\n")).toContain("nothing matches");
  });
});

describe("runPicker with a fake TTY", () => {
  it("filter + Enter resolves the item and restores the terminal", async () => {
    const input = new FakeIn();
    const out: string[] = [];
    const p = runPicker(opts, st, input as unknown as TtyIn, { write: (s) => out.push(s) });
    expect(input.raw).toBe(true);
    for (const ch of "beta") input.press(ch, { name: ch });
    input.press("\r", { name: "return" });
    await expect(p).resolves.toEqual(items[1]);
    expect(input.raw).toBe(false);
    expect(input.paused).toBe(true);
    expect(out.join("")).toContain("\u001b[?25h");
  });
  it("Ctrl-C resolves null (the caller exits 130) and restores the terminal", async () => {
    const input = new FakeIn();
    const p = runPicker(opts, st, input as unknown as TtyIn, { write: () => undefined });
    input.press("\u0003", { name: "c", ctrl: true });
    await expect(p).resolves.toBeNull();
    expect(input.raw).toBe(false);
  });
  it("Ctrl-G calls onCd and resolves null", async () => {
    const onCd = vi.fn();
    const input = new FakeIn();
    const p = runPicker({ ...opts, onCd }, st, input as unknown as TtyIn, { write: () => undefined });
    input.press(undefined, { name: "g", ctrl: true });
    await expect(p).resolves.toBeNull();
    expect(onCd).toHaveBeenCalledWith(items[0]);
  });
  it("input closing (EOF) settles the prompt with null instead of hanging", async () => {
    const a = new FakeIn();
    const pa = runPicker(opts, st, a as unknown as TtyIn, { write: () => undefined });
    a.emit("end");
    await expect(pa).resolves.toBeNull();
    const b = new FakeIn();
    const pb = readOneKey(b as unknown as TtyIn);
    b.emit("close");
    await expect(pb).resolves.toBeNull();
  });
  it("readOneKey returns the key, or null on Esc", async () => {
    const a = new FakeIn();
    const pa = readOneKey(a as unknown as TtyIn);
    a.press("s", { name: "s" });
    expect((await pa)?.str).toBe("s");
    const b = new FakeIn();
    const pb = readOneKey(b as unknown as TtyIn);
    b.press(undefined, { name: "escape" });
    expect(await pb).toBeNull();
  });
});

describe("search key and grouping", () => {
  type R = { name: string; at: number; named: boolean };
  const rows: R[] = [
    { name: "Team Alpha", at: 1, named: true },
    { name: "Team Alpha", at: 3, named: true },
    { name: "Team Alpha", at: 2, named: true },
    { name: "scratch", at: 5, named: false },
    { name: "scratch", at: 4, named: false },
  ];
  const g: PickerOpts<R> = {
    headers: ["Name"],
    items: rows,
    cells: (r) => [r.name],
    searchText: (r) => r.name,
    footer: "keys",
    groupKey: (r) => (r.named ? r.name : undefined),
    recency: (r) => r.at,
  };
  const s0 = { filter: "", cursor: 0 };

  it('"/" opens the filter with an empty query; later keys filter by the typed text only', () => {
    const a = pickerKey(s0, "/", { name: "/" }, 3).state;
    expect(a.filter).toBe("");
    let s = a;
    for (const ch of "alp") s = pickerKey(s, ch, { name: ch }, 3).state;
    expect(s.filter).toBe("alp");
  });
  it("collapses same-named transcripts into one newest row with a count; unnamed stay single", () => {
    const d = displayRows(g, s0);
    expect(d.map((r) => `${r.item.name}:${r.item.at}:${r.older}`)).toEqual(["Team Alpha:3:2", "scratch:5:0", "scratch:4:0"]);
    const text = pickerView(s0, g, st).join("\n");
    expect(text).toContain("Team Alpha (+2 older)");
    expect(pickerView({ filter: "team", cursor: 0 }, g, st).filter((l) => l.includes("Team Alpha"))).toHaveLength(1);
  });
  it("Right/Tab expands the older transcripts indented; Left/Shift-Tab collapses and returns to the head", () => {
    const open = groupKeyState(s0, { name: "right" }, displayRows(g, s0))!;
    const d = displayRows(g, open);
    expect(d.map((r) => `${r.item.at}${r.child ? "c" : ""}`)).toEqual(["3", "2c", "1c", "5", "4"]);
    expect(pickerView(open, g, st).some((l) => /^ {2,}\s*Team Alpha$/.test(l.trim() ? l : "") || l.includes("  Team Alpha"))).toBe(true);
    const onChild = { ...open, cursor: 2 };
    const closed = groupKeyState(onChild, { name: "tab", shift: true }, d)!;
    expect(closed.expanded).toEqual([]);
    expect(closed.cursor).toBe(0);
    expect(groupKeyState(s0, { name: "tab" }, displayRows(g, s0))?.expanded).toEqual(["Team Alpha"]);
    expect(groupKeyState({ ...s0, cursor: 1 }, { name: "right" }, displayRows(g, s0))).toBeNull();
  });
});
