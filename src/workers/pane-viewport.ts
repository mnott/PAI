/**
 * pane-viewport.ts — the pane's own scrollback (alternate screen): the rendered transcript rows live in
 * memory, the viewport shows a window of them above the fixed separator / prompt / status rows, so those
 * rows stay on screen however far the operator scrolls. Pure state and byte sequences — pane-bar.ts
 * drives it, the tests assert it without a terminal.
 */

/** Rows kept in memory. */
export const SCROLLBACK_CAP = 5000;

/** Rows one wheel notch / Shift+arrow moves. */
export const WHEEL_STEP = 3;

/** Alternate screen, SGR mouse reporting (wheel), autowrap off (an over-long row is cut, never wrapped to column 0). */
export const PANE_ENTER = "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?7l\x1b[2J";

/** Exactly undo PANE_ENTER (reverse order), show the cursor, drop any scroll region. */
export const PANE_LEAVE = "\x1b[?7h\x1b[?1006l\x1b[?1000l\x1b[?1049l\x1b[r\x1b[?25h";

export class Viewport {
  private rows: string[] = [];
  /** rows scrolled up from the bottom; 0 = following the newest output */
  offset = 0;

  constructor(
    public height: number,
    private cap = SCROLLBACK_CAP
  ) {}

  get length(): number {
    return this.rows.length;
  }

  private get max(): number {
    return Math.max(0, this.rows.length - this.height);
  }

  /** New output: while scrolled up the view stays on the same rows. */
  push(row: string): void {
    this.rows.push(row);
    if (this.offset > 0) this.offset++;
    if (this.rows.length > this.cap) this.rows.shift();
    this.offset = Math.min(this.offset, this.max);
  }

  scrollUp(n = WHEEL_STEP): void {
    this.offset = Math.min(this.max, this.offset + n);
  }

  scrollDown(n = WHEEL_STEP): void {
    this.offset = Math.max(0, this.offset - n);
  }

  /** Follow the newest output again. */
  toEnd(): void {
    this.offset = 0;
  }

  /** Terminal resized: the window changes, the offset stays inside it. */
  resize(height: number): void {
    this.height = height;
    this.offset = Math.min(this.offset, this.max);
  }

  get following(): boolean {
    return this.offset === 0;
  }

  /** The rows on screen, top first (fewer than `height` while the transcript is short). */
  visible(): string[] {
    const end = this.rows.length - this.offset;
    return this.rows.slice(Math.max(0, end - this.height), end);
  }

  /** Every row kept, oldest first. */
  all(): string[] {
    return this.rows.slice();
  }

  /** The status-row marker while scrolled up, "" while following. */
  indicator(): string {
    return this.offset > 0 ? `↑ ${this.offset} lines — End to follow` : "";
  }

  /** Redraw the viewport area (rows 1..height): each row cleared and rewritten, the rest blanked. */
  frame(): string {
    const vis = this.visible();
    let out = "\x1b7";
    for (let r = 0; r < this.height; r++) out += `\x1b[${r + 1};1H\x1b[2K${vis[r] ?? ""}`;
    return out + "\x1b8";
  }
}

export type ScrollAction = "up" | "down" | "pageUp" | "pageDown" | "end";

/**
 * Pull the scroll input out of a stdin chunk: SGR wheel reports (`ESC[<64;x;yM` up, `65` down), PageUp /
 * PageDown, Shift+Up / Shift+Down and End. `rest` is the chunk without them — what readline should see.
 * Other mouse reports (clicks, releases) are dropped too, so they never land in the prompt as text.
 */
export function parseScrollInput(chunk: string): { actions: ScrollAction[]; rest: string } {
  const actions: ScrollAction[] = [];
  const re = /\x1b\[<(\d+);\d+;\d+[Mm]|\x1b\[5(?:;\d+)?~|\x1b\[6(?:;\d+)?~|\x1b\[1;2A|\x1b\[1;2B|\x1b\[(?:4|8)~|\x1b\[1?F|\x1bOF/g;
  const rest = chunk.replace(re, (m, btn?: string) => {
    if (btn !== undefined) {
      const b = Number(btn);
      if (b & 64 && (b & 3) < 2) actions.push((b & 3) === 0 ? "up" : "down"); // sideways wheel: ignored
      return "";
    }
    if (m === "\x1b[1;2A") actions.push("up");
    else if (m === "\x1b[1;2B") actions.push("down");
    else if (m.startsWith("\x1b[5")) actions.push("pageUp");
    else if (m.startsWith("\x1b[6")) actions.push("pageDown");
    else actions.push("end");
    return "";
  });
  return { actions, rest };
}

/** Apply one scroll action to the viewport. */
export function applyScroll(v: Viewport, a: ScrollAction): void {
  if (a === "up") v.scrollUp();
  else if (a === "down") v.scrollDown();
  else if (a === "pageUp") v.scrollUp(Math.max(1, v.height - 1));
  else if (a === "pageDown") v.scrollDown(Math.max(1, v.height - 1));
  else v.toEnd();
}
