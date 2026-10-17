import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { makeStyle } from "../help.js";
import { filterItems, pickerKey, pickerView, runPicker, readOneKey, type Key, type PickerOpts, type TtyIn } from "./picker.js";

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
