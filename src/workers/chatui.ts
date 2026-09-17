/**
 * chatui.ts — the chat line of a `follow` pane.
 *
 * A follow pane with a target behaves like a small chat, Claude Code style:
 * the transcript lives in a terminal scroll region that ends two rows above
 * the pane's bottom; the last two rows are fixed — the prompt row (`› `,
 * readline line editing) and the ticker row. A transcript line is inserted
 * above the fixed rows with a save-cursor / scroll-region / restore-cursor
 * write that never touches them; the scroll region makes the transcript roll
 * inside itself. Everything here builds strings (or parses one line), so the
 * tests assert exact byte sequences — no terminal needed.
 */

/** The prompt marker of the chat row. */
export const CHAT_PROMPT = "› ";

/** Dim hint shown once behind the cursor until the first line is typed. */
export const CHAT_HINT = "type here and press Enter · /help for commands";

/** What `/help` prints (one command per line, dim). */
export const CHAT_HELP = [
  "/quit            close this pane",
  "/resume <text>   continue the finished worker with <text>",
  "/status          one-line worker status",
  "anything else is sent to the worker — said while it runs, resumed after",
];

// ---------------------------------------------------------------------------
// visible width & wrapping (the gutter must stay the leftmost column)
// ---------------------------------------------------------------------------

/** Index just past the escape starting at `i` (CSI, OSC or a two-char one). */
function endOfEscape(s: string, i: number): number {
  const n = s[i + 1];
  if (n === "[") {
    let j = i + 2;
    while (j < s.length && !(s[j]! >= "@" && s[j]! <= "~")) j++;
    return Math.min(s.length, j + 1);
  }
  if (n === "]") {
    let j = i + 2;
    while (j < s.length && s[j] !== "\x07") j++;
    return Math.min(s.length, j + 1);
  }
  return i + 2;
}

/** Printable columns of `s` — ANSI escape sequences measure zero. */
export function visibleWidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      i = endOfEscape(s, i);
      continue;
    }
    w += 1;
    i += 1;
  }
  return w;
}

/**
 * The SGR sequences in effect at `upto`: everything opened since the last
 * reset, in order. Anything that is not an SGR escape is ignored (it does
 * not change colour state).
 */
function sgrStateAt(text: string, upto: number): string[] {
  const open: string[] = [];
  let i = 0;
  while (i < Math.min(upto, text.length)) {
    if (text[i] === "\x1b") {
      const end = endOfEscape(text, i);
      const esc = text.slice(i, end);
      if (/^\x1b\[[0-9;]*m$/.test(esc)) {
        const params = esc.slice(2, -1);
        const resets = params === "" || params.split(";").includes("0");
        if (resets) open.length = 0;
        if (!(params === "" || params === "0")) open.push(esc);
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return open;
}

/**
 * Wrap one rendered row to `width` printable columns. Breaks on whitespace
 * where possible, hard-wraps words longer than the width, never splits an
 * ANSI escape, and re-opens the colours it wraps inside of, so a diff row
 * keeps its `-`/`+` colour on every continuation row.
 */
export function wrapText(text: string, width: number): string[] {
  if (width < 1 || visibleWidth(text) <= width) return [text];

  // visible characters by their index in `text`
  const chars: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      i = endOfEscape(text, i) - 1;
      continue;
    }
    chars.push(i);
  }

  // words as [first, last] indexes into `chars` (escapes ride along later)
  const words: Array<{ s: number; e: number; w: number }> = [];
  {
    let s = -1;
    let w = 0;
    for (let k = 0; k <= chars.length; k++) {
      const ch = k === chars.length ? " " : text[chars[k]!]!;
      if (ch === " ") {
        if (s >= 0) {
          words.push({ s, e: k - 1, w });
          s = -1;
          w = 0;
        }
      } else {
        if (s < 0) s = k;
        w++;
      }
    }
  }
  // a leading indent (diff rows) belongs to the first word, width counted
  if (words.length && words[0]!.s > 0) {
    words[0] = { s: 0, e: words[0]!.e, w: words[0]!.w + words[0]!.s };
  }

  // chunk spans [start, end] over `chars`, greedy on visible width — the
  // width of a chunk is simply its span in `chars`, inner spaces included
  const spans: Array<[number, number]> = [];
  let cs = -1;
  let ce = -1;
  for (const word of words) {
    if (word.w > width) {
      // oversized word: fill the rest of the line, then full-width rows.
      // `take` is the word's chars that still fit — the gap before the word
      // eats into the room, and when it eats all of it the word starts fresh
      const room = cs < 0 ? 0 : width - (ce - cs + 1);
      const take = room > 0 ? ce + room - word.s + 1 : 0;
      if (take > 0) spans.push([cs, ce + room]);
      else if (cs >= 0) spans.push([cs, ce]);
      let pos = word.s + Math.max(0, take);
      let remaining = word.w - Math.max(0, take);
      while (remaining > width) {
        spans.push([pos, pos + width - 1]);
        pos += width;
        remaining -= width;
      }
      cs = pos;
      ce = pos + remaining - 1;
      continue;
    }
    if (cs < 0) {
      cs = word.s;
      ce = word.e;
      continue;
    }
    if (word.e - cs + 1 <= width) {
      ce = word.e;
      continue;
    }
    spans.push([cs, ce]);
    cs = word.s;
    ce = word.e;
  }
  if (cs >= 0) spans.push([cs, ce]);

  const out: string[] = [];
  for (const [a, b] of spans) {
    const from = chars[a]!;
    // take trailing escapes up to the next visible char with the chunk
    let end = chars[b]! + 1;
    while (end < text.length && text[end] === "\x1b") end = endOfEscape(text, end);
    let piece = text.slice(from, end);
    const reopen = sgrStateAt(text, from);
    if (reopen.length) piece = reopen.join("") + piece;
    if (sgrStateAt(text, end).length) piece += "\x1b[0m";
    out.push(piece);
  }
  return out.length ? out : [""];
}

// ---------------------------------------------------------------------------
// the layout: scroll region + two fixed rows
// ---------------------------------------------------------------------------

/** Restrict scrolling to the transcript region (rows 1 … rows-2). */
export function chatScrollRegion(rows: number): string {
  return `\x1b[1;${Math.max(1, rows - 2)}r`;
}

/**
 * Enter the chat layout: clear the pane, set the scroll region, park the
 * cursor at column 1 of the prompt row (rows-1). The ticker owns row `rows`.
 */
export function chatEnter(rows: number): string {
  return "\x1b[2J" + chatScrollRegion(rows) + `\x1b[${Math.max(1, rows - 1)};1H`;
}

/** Leave it: reset the scroll region, show the cursor, drop to the last row. */
export function chatLeave(rows: number): string {
  return "\x1b[r\x1b[?25h" + `\x1b[${Math.max(1, rows)};1H`;
}

/** Redraw the ticker on its own row without moving the user's cursor. */
export function chatTickerRow(text: string, rows: number): string {
  return "\x1b7" + `\x1b[${Math.max(1, rows)};1H\x1b[K` + text + "\x1b8";
}

/** Move to column 1 of the prompt row and draw prompt (and hint). */
export function chatPromptRow(rows: number, prompt = CHAT_PROMPT, hint?: string): string {
  return `\x1b[${Math.max(1, rows - 1)};1H` + prompt + (hint ?? "");
}

export interface ChatInsert {
  seq: string;
  /** rows filled after this one (caps at regionRows, then it always scrolls). */
  fill: number;
}

/**
 * Insert one transcript row above the fixed prompt/ticker rows. While the
 * region is still filling (`fill < regionRows`) the row is placed top-down;
 * once full, the cursor moves to the region's bottom row and a newline
 * scrolls the region up by one — the two fixed rows are never touched. The
 * user's cursor is saved before and restored after, so readline keeps its
 * position on the prompt row.
 */
export function chatInsertLine(line: string, fill: number, regionRows: number): ChatInsert {
  const growing = fill < regionRows;
  const seq =
    "\x1b7" +
    (growing
      ? `\x1b[${fill + 1};1H${line}\x1b[K`
      : `\x1b[${regionRows};1H\n${line}\x1b[K`) +
    "\x1b8";
  return { seq, fill: Math.min(fill + 1, regionRows) };
}

// ---------------------------------------------------------------------------
// prompt command parsing
// ---------------------------------------------------------------------------

export type ChatAction =
  | { kind: "message"; text: string }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "status" }
  | { kind: "resume"; text: string };

/**
 * One submitted prompt line → what to do with it. `/help`, `/quit`,
 * `/status` and `/resume <text>` are commands (a bare `/resume` comes back
 * with empty text so the caller can print its usage); anything else,
 * including any other `/word`, is a message for the worker.
 */
export function parseChatLine(raw: string): ChatAction {
  const text = raw.trim();
  if (text === "/help") return { kind: "help" };
  if (text === "/quit") return { kind: "quit" };
  if (text === "/status") return { kind: "status" };
  if (text.startsWith("/resume")) return { kind: "resume", text: text.slice("/resume".length).trim() };
  return { kind: "message", text };
}

/**
 * The auto-exit countdown must not fire while the prompt holds unsent text:
 * true while it does. null/undefined (no prompt wired) never holds.
 */
export function holdAutoExit(promptText: string | null | undefined): boolean {
  return typeof promptText === "string" && promptText.trim() !== "";
}
