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
  shift?: boolean;
}

export interface PickerState {
  filter: string;
  cursor: number;
  /** Group keys whose older transcripts are listed under the group's newest row. */
  expanded?: string[];
}

export type PickerAction = "none" | "select" | "cancel" | "cd";

/** Pure: one keypress -> next state and what the driver should do. */
export function pickerKey(state: PickerState, str: string | undefined, key: Key, visibleCount: number): { state: PickerState; action: PickerAction } {
  if ((key.ctrl && key.name === "c") || key.name === "escape") return { state, action: "cancel" };
  if (key.name === "return" || key.name === "enter") return { state, action: visibleCount > 0 ? "select" : "none" };
  if (key.name === "up") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: "none" };
  if (key.name === "down") return { state: { ...state, cursor: Math.min(Math.max(0, visibleCount - 1), state.cursor + 1) }, action: "none" };
  if (key.name === "backspace") return { state: { filter: state.filter.slice(0, -1), cursor: 0 }, action: "none" };
  if (key.ctrl && key.name === "u") return { state: { filter: "", cursor: 0 }, action: "none" };
  if (key.ctrl && key.name === "g") return { state, action: "cd" };
  // "/" opens the filter; it is never part of the query
  if (str === "/" && !state.filter) return { state, action: "none" };
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
  /** Rows with the same key (undefined = never grouped) collapse into one: the newest, with a count of the rest. */
  groupKey?(item: T): string | undefined;
  /** Larger = newer; picks the row a group shows (default: first in `items`). */
  recency?(item: T): number;
  maxRows?: number;
  empty?: string;
  /** Called when the user presses Ctrl-G on a row */
  onCd?: (row: T) => void;
  /** Terminal width in columns; when set, no line is ever longer than this. */
  width?: () => number;
  /** Columns for a given width (narrow terminals drop or shorten some); overrides headers and cells. */
  layout?(width: number): { headers: string[]; cells(item: T): string[] };
  /** Replacement items that arrive after the first paint; the table repaints in place. */
  refresh?: Promise<T[]>;
}

// eslint-disable-next-line no-control-regex
const SGR = /\u001b\[[0-9;]*m/g;

/** Cut a (possibly coloured) line to `width` visible characters, ending in an ellipsis when cut. */
export function clipLine(line: string, width: number): string {
  if (line.replace(SGR, "").length <= width) return line;
  let out = "";
  let seen = 0;
  let sawEsc = false;
  for (let i = 0; i < line.length; ) {
    const m = /^\u001b\[[0-9;]*m/.exec(line.slice(i, i + 24));
    if (m) {
      out += m[0];
      i += m[0].length;
      sawEsc = true;
      continue;
    }
    if (seen >= width - 1) break;
    out += line[i++];
    seen++;
  }
  return out + "…" + (sawEsc ? "\u001b[0m" : "");
}

export function filterItems<T>(items: T[], filter: string, text: (i: T) => string): T[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? items.filter((i) => words.every((w) => text(i).toLowerCase().includes(w))) : items;
}

export interface PickerRow<T> {
  item: T;
  /** Group key, when this row belongs to a group of more than one transcript. */
  group?: string;
  /** Older transcripts hidden behind this (newest) row; 0 when expanded or alone. */
  older: number;
  /** An expanded older transcript, shown indented under its group's newest row. */
  child: boolean;
}

/** Pure: the rows on screen — filtered, then one row per group key unless expanded. */
export function displayRows<T>(opts: PickerOpts<T>, state: PickerState): PickerRow<T>[] {
  const matched = filterItems(opts.items, state.filter, opts.searchText);
  if (!opts.groupKey) return matched.map((item) => ({ item, older: 0, child: false }));
  const groups = new Map<string, T[]>();
  for (const it of matched) {
    const k = opts.groupKey(it);
    if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const rec = opts.recency;
  const out: PickerRow<T>[] = [];
  const done = new Set<string>();
  for (const it of matched) {
    const k = opts.groupKey(it);
    if (k === undefined) {
      out.push({ item: it, older: 0, child: false });
      continue;
    }
    if (done.has(k)) continue;
    done.add(k);
    const all = groups.get(k)!;
    const sorted = rec ? [...all].sort((a, b) => rec(b) - rec(a)) : all;
    const open = state.expanded?.includes(k) ?? false;
    out.push({ item: sorted[0], group: sorted.length > 1 ? k : undefined, older: open ? 0 : sorted.length - 1, child: false });
    if (open) for (const c of sorted.slice(1)) out.push({ item: c, group: k, older: 0, child: true });
  }
  return out;
}

/** Pure: expand/collapse keys. Right/Tab opens the group under the cursor, Left/Shift-Tab closes it. */
export function groupKeyState<T>(state: PickerState, key: Key, rows: PickerRow<T>[]): PickerState | null {
  const open = key.name === "right" || (key.name === "tab" && !key.shift);
  const close = key.name === "left" || (key.name === "tab" && !!key.shift);
  if (!open && !close) return null;
  const row = rows[state.cursor];
  if (!row?.group) return null;
  const expanded = state.expanded ?? [];
  if (open) return row.older > 0 ? { ...state, expanded: [...expanded, row.group] } : null;
  if (!expanded.includes(row.group)) return null;
  const head = rows.findIndex((r) => r.group === row.group && !r.child);
  return { ...state, expanded: expanded.filter((k) => k !== row.group), cursor: head >= 0 ? head : state.cursor };
}

/** Pure: the lines for the current state. */
export function pickerView<T>(state: PickerState, opts: PickerOpts<T>, st: Style): string[] {
  const rows = displayRows(opts, state);
  const shown = rows.map((r) => r.item);
  const max = opts.maxRows ?? 12;
  const start = Math.min(Math.max(0, state.cursor - max + 1), Math.max(0, shown.length - max));
  const page = shown.slice(start, start + max);
  const lines: string[] = [];
  if (opts.title) lines.push(st.bold(opts.title), "");
  lines.push(`${st.dim("filter")} ${state.filter}${st.dim(state.filter ? "" : "type to filter")}`, "");
  if (page.length === 0) {
    lines.push(`  ${st.yellow(opts.empty ?? "nothing matches")}`);
  } else {
    const lay = opts.layout?.(opts.width?.() ?? Infinity) ?? opts;
    const cellsOf = (r: PickerRow<T>) => {
      const c = lay.cells(r.item);
      if (r.child) c[0] = "  " + st.dim(c[0]);
      else if (r.older > 0) c[0] += st.dim(` (+${r.older} older)`);
      return c;
    };
    const table = renderTable(lay.headers, rows.slice(start, start + max).map(cellsOf), st).split("\n");
    lines.push(table[0], table[1]);
    page.forEach((_, i) => {
      const sel = start + i === state.cursor;
      lines.push((sel ? st.cyan("›") : " ") + " " + table[2 + i].slice(2));
    });
  }
  if (shown.length > max) lines.push(st.dim(`  … ${shown.length} in total`));
  const cur = shown[state.cursor];
  const detail = cur && opts.detail ? opts.detail(cur) : "";
  lines.push("", detail ? `  ${detail}` : "", st.dim(opts.footer + " · Ctrl-G cd"));
  const width = opts.width?.();
  return width ? lines.map((l) => clipLine(l, width)) : lines;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface TtyIn {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  on(ev: "keypress", fn: (str: string | undefined, key: Key) => void): unknown;
  off(ev: "keypress", fn: (str: string | undefined, key: Key) => void): unknown;
  /** Input closed (EOF, hang-up): a prompt must settle, not wait forever. */
  once(ev: "end" | "close", fn: () => void): unknown;
  off(ev: "end" | "close", fn: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}
export interface TtyOut {
  write(s: string): unknown;
}

const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";

/** Resolves the chosen item, or null when cancelled. Always restores the terminal. */
export function runPicker<T>(opts0: PickerOpts<T>, st: Style, input: TtyIn, output: TtyOut): Promise<T | null> {
  const opts = { ...opts0 };
  return new Promise((resolve) => {
    let state: PickerState = { filter: opts.initialFilter ?? "", cursor: 0 };
    let drawn = 0;
    const draw = () => {
      const lines = pickerView(state, opts, st);
      output.write((drawn ? `\u001b[${drawn}A` : "") + "\r\u001b[J" + lines.join("\n") + "\n");
      drawn = lines.length;
    };
    const onResize = () => draw();
    const out = output as TtyOut & { on?(ev: "resize", fn: () => void): unknown; off?(ev: "resize", fn: () => void): unknown };
    let done = false;
    const finish = (value: T | null) => {
      done = true;
      out.off?.("resize", onResize);
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW);
      resolve(value);
    };
    const onKey = (str: string | undefined, key: Key) => {
      const rows = displayRows(opts, state);
      const shown = rows.map((x) => x.item);
      const g = groupKeyState(state, key ?? {}, rows);
      if (g) {
        state = g;
        return draw();
      }
      const r = pickerKey(state, str, key ?? {}, shown.length);
      state = r.state;
      if (r.action === "cancel") return finish(null);
      if (r.action === "select") return finish(shown[state.cursor] ?? null);
      if (r.action === "cd") {
        const row = shown[state.cursor];
        if (row) {
          opts.onCd?.(row);
          return finish(null);
        }
      }
      draw();
    };
    const onEnd = () => finish(null);
    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume();
    output.write(HIDE);
    draw();
    out.on?.("resize", onResize);
    opts.refresh?.then(
      (items) => {
        if (done) return;
        opts.items = items;
        draw();
      },
      () => undefined
    );
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("close", onEnd);
  });
}

/** One keypress (for the launch screen). Resolves null on Ctrl-C / Esc. */
export function readOneKey(input: TtyIn): Promise<{ str?: string; key: Key } | null> {
  return new Promise((resolve) => {
    const done = () => {
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.setRawMode?.(false);
      input.pause();
    };
    const onEnd = () => {
      done();
      resolve(null);
    };
    const onKey = (str: string | undefined, key: Key) => {
      done();
      const k = key ?? {};
      resolve((k.ctrl && k.name === "c") || k.name === "escape" ? null : { str, key: k });
    };
    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume();
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("close", onEnd);
  });
}
