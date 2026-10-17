/**
 * Interactive table picker: type to filter, arrows to move, Enter to choose,
 * Esc or Ctrl-C to cancel (resolves null — the caller exits 130 quietly).
 *
 * No prompt library: the picker needs aligned multi-column rows with a live
 * filter, which general prompt libraries do not render, and the whole thing is
 * ~150 lines. The state machine and the view are pure functions; the driver
 * takes any input/output pair, so tests run it with a fake TTY.
 */

import { emitKeypressEvents } from "node:readline";
import { renderTable, type Style } from "../help.js";

export interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

export interface PickerState {
  filter: string;
  cursor: number;
}

export type PickerAction = "none" | "select" | "cancel";

/** Pure: one keypress -> next state and what the driver should do. */
export function pickerKey(state: PickerState, str: string | undefined, key: Key, visibleCount: number): { state: PickerState; action: PickerAction } {
  if ((key.ctrl && key.name === "c") || key.name === "escape") return { state, action: "cancel" };
  if (key.name === "return" || key.name === "enter") return { state, action: visibleCount > 0 ? "select" : "none" };
  if (key.name === "up") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: "none" };
  if (key.name === "down") return { state: { ...state, cursor: Math.min(Math.max(0, visibleCount - 1), state.cursor + 1) }, action: "none" };
  if (key.name === "backspace") return { state: { filter: state.filter.slice(0, -1), cursor: 0 }, action: "none" };
  if (key.ctrl && key.name === "u") return { state: { filter: "", cursor: 0 }, action: "none" };
  if (str && !key.ctrl && str >= " " && str !== "\u007f") return { state: { filter: state.filter + str, cursor: 0 }, action: "none" };
  return { state, action: "none" };
}

export interface PickerOpts<T> {
  title?: string;
  headers: string[];
  items: T[];
  cells(item: T): string[];
  /** Text the filter matches against (case-insensitive, every word must occur). */
  searchText(item: T): string;
  initialFilter?: string;
  footer: string;
  /** Shown under the table for the highlighted row (e.g. a status reason). */
  detail?(item: T): string;
  maxRows?: number;
  empty?: string;
}

export function filterItems<T>(items: T[], filter: string, text: (i: T) => string): T[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? items.filter((i) => words.every((w) => text(i).toLowerCase().includes(w))) : items;
}

/** Pure: the lines for the current state. */
export function pickerView<T>(state: PickerState, opts: PickerOpts<T>, st: Style): string[] {
  const shown = filterItems(opts.items, state.filter, opts.searchText);
  const max = opts.maxRows ?? 12;
  const start = Math.min(Math.max(0, state.cursor - max + 1), Math.max(0, shown.length - max));
  const page = shown.slice(start, start + max);
  const lines: string[] = [];
  if (opts.title) lines.push(st.bold(opts.title), "");
  lines.push(`${st.dim("filter")} ${state.filter}${st.dim(state.filter ? "" : "type to filter")}`, "");
  if (page.length === 0) {
    lines.push(`  ${st.yellow(opts.empty ?? "nothing matches")}`);
  } else {
    const table = renderTable(opts.headers, page.map(opts.cells), st).split("\n");
    lines.push(table[0], table[1]);
    page.forEach((_, i) => {
      const sel = start + i === state.cursor;
      lines.push((sel ? st.cyan("›") : " ") + " " + table[2 + i].slice(2));
    });
  }
  if (shown.length > max) lines.push(st.dim(`  … ${shown.length} in total`));
  const cur = shown[state.cursor];
  const detail = cur && opts.detail ? opts.detail(cur) : "";
  lines.push("", detail ? `  ${detail}` : "", st.dim(opts.footer));
  return lines;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface TtyIn {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  on(ev: "keypress", fn: (str: string | undefined, key: Key) => void): unknown;
  off(ev: "keypress", fn: (str: string | undefined, key: Key) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}
export interface TtyOut {
  write(s: string): unknown;
}

const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";

/** Resolves the chosen item, or null when cancelled. Always restores the terminal. */
export function runPicker<T>(opts: PickerOpts<T>, st: Style, input: TtyIn, output: TtyOut): Promise<T | null> {
  return new Promise((resolve) => {
    let state: PickerState = { filter: opts.initialFilter ?? "", cursor: 0 };
    let drawn = 0;
    const draw = () => {
      const lines = pickerView(state, opts, st);
      output.write((drawn ? `\u001b[${drawn}A` : "") + "\r\u001b[J" + lines.join("\n") + "\n");
      drawn = lines.length;
    };
    const finish = (value: T | null) => {
      input.off("keypress", onKey);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW);
      resolve(value);
    };
    const onKey = (str: string | undefined, key: Key) => {
      const shown = filterItems(opts.items, state.filter, opts.searchText);
      const r = pickerKey(state, str, key ?? {}, shown.length);
      state = r.state;
      if (r.action === "cancel") return finish(null);
      if (r.action === "select") return finish(shown[state.cursor] ?? null);
      draw();
    };
    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume();
    output.write(HIDE);
    draw();
    input.on("keypress", onKey);
  });
}

/** One keypress (for the launch screen). Resolves null on Ctrl-C / Esc. */
export function readOneKey(input: TtyIn): Promise<{ str?: string; key: Key } | null> {
  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: Key) => {
      input.off("keypress", onKey);
      input.setRawMode?.(false);
      input.pause();
      const k = key ?? {};
      resolve((k.ctrl && k.name === "c") || k.name === "escape" ? null : { str, key: k });
    };
    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume();
    input.on("keypress", onKey);
  });
}
