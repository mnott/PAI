/**
 * pane-title.ts — the pane's purpose in its terminal title.
 *
 * Worker panes all show "node" in iTerm2's title bar (iTerm renames a session
 * after its running command), so the purpose — which worker, which task — was
 * only in the bottom status line, which is often cut off. The title is set in
 * two places: the iTerm2 split script names the new session at birth, and the
 * follow / pane-run view writes the title escape sequences at its start, so the
 * title holds whatever process runs inside (and works in tmux too).
 *
 * Leaf module: pane.ts, pane-run.ts and viewer.ts all use it, so nothing here
 * may import from them.
 */

import { execFileSync } from "node:child_process";
import { panePolicy } from "./pane-policy.js";

/** Titles cap at this many characters (the title bar cannot show more). */

/**
 * Title text safe for the terminal: control characters (including ESC and BEL,
 * which would break out of an OSC sequence) and the double quote are removed,
 * whitespace collapsed, and the result capped at `max` characters.
 */
export function escapePaneTitle(s: string, max = panePolicy().titleMax): string {
  const clean = s.replace(/[\x00-\x1f\x7f"]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

/**
 * The title a pane shows: "<label, up to ~40 chars> · <provider or model short
 * name>" for a worker pane, "<label>" alone for a `pai pane run` pane (no
 * provider). An empty label yields "" — a caller then sets nothing.
 */
export function paneTitle(label: string, providerOrModel?: string): string {
  const l = escapePaneTitle(label);
  if (!l) return "";
  const p = escapePaneTitle(providerOrModel ?? "", 20);
  return p ? `${l} · ${p}` : l;
}

/**
 * Write the terminal title: OSC 1 (icon name) and OSC 2 (window title), the way
 * terminals and tmux read it. Under tmux the pane title is additionally set
 * with `select-pane -T`, because tmux shows its own pane title in the border
 * and does not forward OSC to the outer terminal. Never throws: a title is
 * decoration, not a reason a pane fails. `tmux` is injectable so tests never
 * touch a real tmux. The OSC sequences go out only to a terminal (`tty`, default:
 * stdout is a TTY): captured output must not start with title garbage.
 */
export function writePaneTitle(
  title: string,
  env: NodeJS.ProcessEnv = process.env,
  tmux: (args: string[]) => void = (args) => execFileSync("tmux", args, { stdio: "ignore" }),
  tty: boolean = process.stdout.isTTY === true
): void {
  const t = escapePaneTitle(title);
  if (!t) return;
  if (tty) {
    try {
      process.stderr.write(`\x1b]1;${t}\x07\x1b]2;${t}\x07`);
    } catch {
      /* unwritable stderr: the title just stays as it is */
    }
  }
  if (env.TMUX) {
    try {
      const target = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : [];
      tmux(["select-pane", ...target, "-T", t]);
    } catch {
      /* tmux gone or the target is stale */
    }
  }
}
