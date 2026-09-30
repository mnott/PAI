/**
 * pane.ts — the per-worker follow pane in iTerm2.
 *
 * One small-font pane per worker, stacked in a right-hand column: the first
 * worker of a scope splits the launching session vertically, every further
 * one splits the lowest live worker pane horizontally, so panes stack top to
 * bottom. The split never sizes the new session — that would grow the whole
 * window; instead the window's bounds are read before the split and restored
 * right after, so the panes share the space the window already had. The follow
 * command is part of the split itself — iTerm creates the new session already
 * running it — so no text is ever typed into any session afterwards; a separate
 * typing step raced the operator's keystrokes (focus briefly sits on the new
 * pane after a split, and in one observed failure the command landed in the
 * operator's own shell). A split still makes the new session the tab's active
 * one — the scripts re-select the launching session right after, so a pane
 * opening never steals the keystrokes the operator is typing. Each
 * pane runs `pai worker follow <id> --auto-exit <n>` under the `pai-worker`
 * dynamic profile (Close Sessions On End), so panes disappear by themselves.
 *
 * Panes are tracked per scope (AIBroker session id, else tab key) in
 * <logDir>/panes/<key>/<worker id>.json (one file per worker), iTerm session unique id, newest first —
 * the split lands below the lowest live worker pane.
 *
 * The dynamic profile's font is the family of iTerm's DEFAULT profile (the
 * `Default Bookmark Guid` entry in New Bookmarks) at workers.pane.fontSize —
 * never the launching session's profile, which the Python version did and
 * which produced iTerm's "unknown parent name" dialog whenever the two
 * differed. `Dynamic Profile Parent Name` is only written when that name
 * actually exists in New Bookmarks; when iTerm's preferences cannot be read
 * the profile is still written, with font Menlo-Regular and no parent.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkersConfig } from "./config.js";
import { panesDir } from "./paths.js";
import { itermUuid, scopeKey } from "./scope.js";

export const PROFILE_NAME = "pai-worker";

/** Where the dynamic profile lives (env override keeps tests off the real one). */
export function dynamicProfilePath(): string {
  return process.env.PAI_WORKER_PROFILE ?? join(
    homedir(),
    "Library",
    "Application Support",
    "iTerm2",
    "DynamicProfiles",
    "pai-worker.json"
  );
}

// ---------------------------------------------------------------------------
// AppleScripts (arguments are passed as argv items, never interpolated)
// ---------------------------------------------------------------------------

// One pane per worker: split the launching session vertically, or the lowest
// live candidate horizontally. Returns "<live ids>,|<new session id>".
// Exported for the script-content tests (window size, argv-only arguments).
export const WORKER_SPLIT_SCRIPT = `on run(argv)
    set targetID to item 1 of argv
    set candList to item 2 of argv
    set followCmd to item 3 of argv
    set profileName to item 4 of argv
    tell application id "com.googlecode.iterm2"
        if not running then return "notrunning"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if id of s is targetID then
                        -- sizing the new session would grow the whole window:
                        -- pin the window's bounds now and restore them after
                        -- the split, so the panes share the existing space.
                        -- copy, never set: set stores the property
                        -- reference lazily, so restoring it would re-read the
                        -- post-split bounds instead of these — observed as the
                        -- window jumping to the main display
                        copy bounds of w to winBounds
                        set sessIDs to {}
                        repeat with other in sessions of t
                            set end of sessIDs to (id of other as text)
                        end repeat
                        set lived to {}
                        set splitS to missing value
                        repeat with cid in my splitIds(candList)
                            set cidText to (cid as text)
                            if sessIDs contains cidText then
                                set end of lived to cidText
                                if splitS is missing value then
                                    set splitS to first session of t whose id is cidText
                                end if
                            end if
                        end repeat
                        -- the follow command is part of the split itself: the
                        -- pane is born already running it, so no text is ever
                        -- typed into any session — a typing step raced the
                        -- operator's keystrokes and could even land in the
                        -- operator's own session
                        if profileName is "" then
                            if splitS is missing value then
                                tell s
                                    set newS to split vertically with default profile command followCmd
                                end tell
                            else
                                tell splitS
                                    set newS to split horizontally with default profile command followCmd
                                end tell
                            end if
                        else
                            if splitS is missing value then
                                tell s
                                    set newS to split vertically with profile profileName command followCmd
                                end tell
                            else
                                tell splitS
                                    set newS to split horizontally with profile profileName command followCmd
                                end tell
                            end if
                        end if
                        -- a split makes the new session the tab's active one:
                        -- re-select the launching session so focus returns to
                        -- where the operator was typing, never the new pane
                        try
                            select s
                        end try
                        try
                            set bounds of w to winBounds
                        end try
                        set out to ""
                        repeat with lid in lived
                            set out to out & lid & ","
                        end repeat
                        return out & "|" & (id of newS as text)
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run

on splitIds(s)
    set out to {}
    if s is "" then return out
    set prevDels to AppleScript's text item delimiters
    set AppleScript's text item delimiters to ","
    repeat with part in text items of s
        set end of out to (part as text)
    end repeat
    set AppleScript's text item delimiters to prevDels
    return out
end splitIds`;

// TTys of every session in the launching session's tab (no-worker pane variant).
const TAB_TTYS_SCRIPT = `on run(argv)
    set targetID to item 1 of argv
    tell application id "com.googlecode.iterm2"
        if not running then return "notrunning"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if id of s is targetID then
                        set ttys to {}
                        repeat with other in sessions of t
                            copy (tty of other) to end of ttys
                        end repeat
                        return ttys
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run`;

// Bounds (x1, y1, x2, y2, comma-joined) of the window hosting one iTerm
// session — read-only, for `pai worker pane <id> --check`. Exported for the
// script-content tests (reads bounds, never sets them).
export const WINDOW_BOUNDS_SCRIPT = `on run(argv)
    set targetID to item 1 of argv
    tell application id "com.googlecode.iterm2"
        if not running then return "notrunning"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if id of s is targetID then
                        copy bounds of w to winBounds
                        set prevDels to AppleScript's text item delimiters
                        set AppleScript's text item delimiters to ", "
                        set out to winBounds as text
                        set AppleScript's text item delimiters to prevDels
                        return out
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run`;

// Split the launching session vertically and run followCmd in the new pane.
// Exported for the script-content tests (focus stays on the launching session).
export const SPLIT_SCRIPT = `on run(argv)
    set targetID to item 1 of argv
    set followCmd to item 2 of argv
    tell application id "com.googlecode.iterm2"
        if not running then return "notrunning"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if id of s is targetID then
                        -- the follow command is part of the split itself (see
                        -- WORKER_SPLIT_SCRIPT): nothing is ever typed into a
                        -- session afterwards
                        tell s
                            set newS to split vertically with default profile command followCmd
                        end tell
                        -- keep the tab's active session where it was (see
                        -- WORKER_SPLIT_SCRIPT)
                        try
                            select s
                        end try
                        return "opened"
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run`;

// ---------------------------------------------------------------------------
// osascript / ps / defaults helpers
// ---------------------------------------------------------------------------

/**
 * True for the transient "every window doesn't understand the count message"
 * (-1708) failure iTerm throws while enumerating windows during a race with
 * window/session churn — seen to succeed on immediate retry. No other error
 * matches: a retry here only re-runs the enumeration, before any split, so it
 * cannot double-create a pane.
 */
export function isRetryableIterm2Error(stderr: string): boolean {
  return stderr.includes("every window doesn") && stderr.includes("(-1708)");
}

const OSASCRIPT_MAX_ATTEMPTS = 6;
const OSASCRIPT_RETRY_DELAY_MS = 500;

function runOsascriptOnce(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", ["-", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", () => resolve({ stdout: out, stderr: err }));
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/** Run an AppleScript with argv. Rejects when osascript itself cannot run. */
async function osascript(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  let result = await runOsascriptOnce(script, args);
  for (let attempt = 1; attempt < OSASCRIPT_MAX_ATTEMPTS && isRetryableIterm2Error(result.stderr); attempt++) {
    await new Promise((r) => setTimeout(r, OSASCRIPT_RETRY_DELAY_MS));
    result = await runOsascriptOnce(script, args);
  }
  return result;
}

function psOutput(format: string): string {
  try {
    return execFileSync("ps", ["-axo", format], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/** TTys of running `worker follow` processes, normalised to /dev/ttysNNN. */
function followTtys(): Set<string> {
  const ttys = new Set<string>();
  for (const line of psOutput("tty=,command=").split("\n")) {
    const parts = line.trim().split(/\s+/, 2);
    if (parts.length < 2 || parts[0] === "ps") continue;
    if (!/(^|\/)(worker-follow|pai worker follow|glm-ps follow)\b/.test(parts[1])) continue;
    if (parts[0].startsWith("ttys")) ttys.add(`/dev/${parts[0]}`);
  }
  return ttys;
}

/** True while a `follow <wid>` process runs (its pane shows that worker). */
export function workerPaneOpen(wid: string): boolean {
  const pat = new RegExp(`(?:worker follow|worker-follow|glm-ps follow) ${wid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return psOutput("command=").split("\n").some((ln) => pat.test(ln));
}

/** One entry of iTerm's New Bookmarks (the fields the pane cares about). */
export interface Bookmark {
  Name?: string;
  Guid?: string;
  "Normal Font"?: string;
}

/** What reading iTerm's preferences yielded — `error` carries the reason. */
export interface PrefsRead {
  bookmarks: Bookmark[];
  defaultGuid: string | null;
  error: string | null;
}

/** plutil's message for an ExecFileSync failure, else the exception text. */
function toolErr(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
  return (stderr || err.message || String(e)).trim();
}

/**
 * Read New Bookmarks and Default Bookmark Guid from an iTerm preferences
 * plist. Key-scoped `plutil -extract`, never a whole-file JSON conversion:
 * real iTerm preferences carry `<date>` objects (SULastCheckTime & friends)
 * which `plutil -convert json` rejects outright — "Invalid object in plist
 * for JSON format" — so the whole-file read always failed and the dynamic
 * profile was never written.
 */
export function readItermPlist(plistPath: string): PrefsRead {
  let bookmarks: Bookmark[] = [];
  try {
    const out = execFileSync(
      "plutil",
      ["-extract", "New Bookmarks", "json", "-o", "-", plistPath],
      { encoding: "utf8", timeout: 10_000 }
    );
    const parsed = JSON.parse(out) as unknown;
    if (Array.isArray(parsed)) bookmarks = parsed as Bookmark[];
  } catch (e) {
    return { bookmarks: [], defaultGuid: null, error: `extracting New Bookmarks: ${toolErr(e)}` };
  }
  let defaultGuid: string | null = null;
  try {
    const out = execFileSync(
      "plutil",
      ["-extract", "Default Bookmark Guid", "raw", "-o", "-", plistPath],
      { encoding: "utf8", timeout: 10_000 }
    );
    defaultGuid = out.trim() || null;
  } catch {
    // no default guid set — defaultBookmarkFrom() yields null, fine
  }
  return { bookmarks, defaultGuid, error: null };
}

/** iTerm's exported preferences, via a temp plist (no shell pipe involved). */
export function itermPrefs(): PrefsRead {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "pai-iterm-"));
    const plist = join(dir, "iterm2.plist");
    execFileSync("defaults", ["export", "com.googlecode.iterm2", plist], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return readItermPlist(plist);
  } catch (e) {
    return { bookmarks: [], defaultGuid: null, error: `defaults export: ${toolErr(e)}` };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup of a temp dir
      }
    }
  }
}

/** The New Bookmarks entry of that profile name, null if absent. */
function bookmarkFrom(read: PrefsRead, named: string): Bookmark | null {
  return read.bookmarks.find((b) => b.Name === named) ?? null;
}

/** The bookmark iTerm marks default, null when it is missing or unreadable. */
function defaultBookmarkFrom(read: PrefsRead): Bookmark | null {
  return read.defaultGuid
    ? read.bookmarks.find((b) => b.Guid === read.defaultGuid) ?? null
    : null;
}

/** The default profile, read fresh from iTerm's preferences. */
export function defaultBookmark(): Bookmark | null {
  return defaultBookmarkFrom(itermPrefs());
}

/**
 * The pane profile's font: the family of iTerm's default profile at
 * `fontSize` points ("MesloLGLNFM-Regular 18" + 13 → "MesloLGLNFM-Regular 13"),
 * or "Menlo-Regular <fontSize>" when the default font cannot be read.
 */
export function paneFont(font: string | undefined, fontSize: number): string {
  const idx = (font ?? "").lastIndexOf(" ");
  if (idx > 0) {
    const family = font!.slice(0, idx);
    if (!Number.isNaN(parseFloat(font!.slice(idx + 1)))) return `${family} ${fontSize}`;
  }
  return `Menlo-Regular ${fontSize}`;
}

/** Write the pai-worker dynamic profile; iTerm2 loads that directory itself. */
export function writeDynamicProfile(
  parent: Bookmark | null,
  fontSize: number,
  read: () => PrefsRead = itermPrefs
): void {
  const profile: Record<string, unknown> = {
    Name: PROFILE_NAME,
    Guid: "pai-worker-dynamic-profile",
    "Normal Font": paneFont(parent?.["Normal Font"], fontSize),
    "Close Sessions On End": true,
  };
  // Parent name only when iTerm actually has that profile loaded — a name it
  // does not know makes every split open an error dialog instead of a pane.
  if (parent?.Name && bookmarkFrom(read(), parent.Name)) {
    profile["Dynamic Profile Parent Name"] = parent.Name;
  }
  const path = dynamicProfilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ Profiles: [profile] }, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

let warnedPrefs = false;

/**
 * Profile for new worker panes, creating the small-font one on demand.
 * "" means "split with the default profile" (also the fallback when the
 * dynamic profile does not show up in time).
 *
 * The profile file is written whenever it is missing — even when iTerm's
 * preferences cannot be read; then it gets font "Menlo-Regular <fontSize>"
 * and no parent, and the reason is logged to stderr once.
 */
export async function followProfile(
  fontSize: number,
  read: () => PrefsRead = itermPrefs
): Promise<string> {
  const first = read();
  const parent = defaultBookmarkFrom(first);
  const path = dynamicProfilePath();
  const existed = existsSync(path);
  if (!existed) writeDynamicProfile(parent, fontSize, () => first);
  if (!parent) {
    if (!warnedPrefs) {
      warnedPrefs = true;
      const reason = first.error ?? "no profile is marked default";
      const what = existed
        ? `keeping ${path} as-is`
        : `wrote ${path} with Menlo-Regular ${fontSize} and no parent`;
      process.stderr.write(
        `pai worker pane: cannot read iTerm's default profile (${reason}) — ${what}\n`
      );
    }
    if (first.error) return ""; // polling cannot succeed against unreadable prefs
  }
  for (let i = 0; i < 10; i++) {
    // iTerm2 picks DynamicProfiles up quickly; allow it 2 s
    if (bookmarkFrom(read(), PROFILE_NAME)) return PROFILE_NAME;
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stderr.write(`pai worker pane: profile ${PROFILE_NAME} not visible, splitting with default\n`);
  return "";
}

// ---------------------------------------------------------------------------
// Pane registry
// ---------------------------------------------------------------------------

export interface PaneEntry {
  session: string;
  worker: string;
  opened: string;
  /** the scope (registry key) the entry was opened under */
  scope?: string;
}

/**
 * One file per worker, `<panes>/<scope>/<worker id>.json`: concurrent opens
 * for the same scope write different files, so none can be lost (the former
 * shared `<scope>.json` list was a read-modify-write that dropped entries when
 * workers started a second apart). Legacy `<scope>.json` lists are still read.
 */
function readEntry(path: string, scope: string): PaneEntry[] {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return (Array.isArray(v) ? v : [v])
      .filter((e): e is PaneEntry => !!e && typeof (e as PaneEntry).session === "string" && typeof (e as PaneEntry).worker === "string")
      .map((e) => ({ ...e, scope }));
  } catch {
    return [];
  }
}

/** Registry entries of one scope (`scope` set) or of all scopes, oldest first. */
export function loadRegistry(logDir: string, scope?: string): PaneEntry[] {
  const root = panesDir(logDir);
  const out: PaneEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const full = join(root, name);
    if (name.endsWith(".json")) {
      const sc = name.slice(0, -5);
      if (!scope || sc === scope) out.push(...readEntry(full, sc));
    } else if (!scope || name === scope) {
      try {
        for (const f of readdirSync(full)) if (f.endsWith(".json")) out.push(...readEntry(join(full, f), name));
      } catch {
        /* not a directory */
      }
    }
  }
  return out.sort((x, y) => x.opened.localeCompare(y.opened));
}

function entryPath(logDir: string, e: PaneEntry): string {
  return join(panesDir(logDir), e.scope ?? "", `${e.worker}.json`);
}

function saveEntry(logDir: string, e: PaneEntry): void {
  const path = entryPath(logDir, e);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ session: e.session, worker: e.worker, opened: e.opened }, null, 1), "utf8");
  renameSync(tmp, path);
}

/** Forget an entry (its per-worker file; a legacy list is rewritten without it). */
function dropEntry(logDir: string, e: PaneEntry): void {
  const legacy = join(panesDir(logDir), `${e.scope}.json`);
  rmSync(entryPath(logDir, e), { force: true });
  if (existsSync(legacy)) {
    const rest = readEntry(legacy, e.scope ?? "").filter((x) => x.session !== e.session);
    writeFileSync(legacy, JSON.stringify(rest.map(({ scope: _s, ...x }) => x), null, 1), "utf8");
  }
}

// ---------------------------------------------------------------------------
// Ending panes of finished workers
// ---------------------------------------------------------------------------

const LIST_SESSIONS_SCRIPT = `on run(argv)
    set out to ""
    tell application id "com.googlecode.iterm2"
        if not running then return ""
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    set out to out & (id of s as text) & (ASCII character 9) & (tty of s as text) & (ASCII character 9) & (name of s as text) & linefeed
                end repeat
            end repeat
        end repeat
    end tell
    return out
end run`;

// Ends one session by its unique id, never a window or the app.
const END_SESSION_SCRIPT = `on run(argv)
    set targetID to item 1 of argv
    tell application id "com.googlecode.iterm2"
        if not running then return "notrunning"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if id of s is targetID then
                        close s
                        return "closed"
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run`;

/** The real iTerm / tmux calls, swappable so tests never touch either. */
export interface PaneOps {
  listIterm(): Promise<Array<{ id: string; name: string }>>;
  closeIterm(id: string): Promise<boolean>;
  listTmux(): Array<{ id: string; command: string }>;
  closeTmux(id: string): boolean;
}

export const realPaneOps: PaneOps = {
  async listIterm() {
    if (process.platform !== "darwin") return [];
    try {
      const p = await osascript(LIST_SESSIONS_SCRIPT, []);
      // iTerm renames a pane after its running command ("node"), so the follow
      // command is looked up by the session's tty instead
      const cmdByTty = new Map<string, string>();
      for (const line of psOutput("tty=,command=").split("\n")) {
        const [tty, ...rest] = line.trim().split(/\s+/);
        if (tty && tty !== "??") cmdByTty.set(`/dev/${tty}`, rest.join(" "));
      }
      return p.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [id, tty, ...name] = l.split("\t");
          return { id, name: `${name.join("\t")} ${cmdByTty.get(tty) ?? ""}`.trim() };
        });
    } catch {
      return [];
    }
  },
  async closeIterm(id) {
    const p = await osascript(END_SESSION_SCRIPT, [id]);
    return p.stdout.trim() === "closed";
  },
  listTmux() {
    try {
      const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_start_command}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.split("\n").filter(Boolean).map((l) => ({ id: l.split("\t")[0], command: l.split("\t").slice(1).join(" ") }));
    } catch {
      return [];
    }
  },
  closeTmux(id) {
    try {
      execFileSync("tmux", ["kill-pane", "-t", id], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
};

const FOLLOW_ID = /worker[- ]follow (\d{8}-\d{6}-\d+)/;

/** End one worker's registered iTerm pane, found by worker id. True if a pane was closed. */
export async function closePaneForWorker(logDir: string, wid: string, ops: PaneOps = realPaneOps): Promise<boolean> {
  let closed = false;
  for (const e of loadRegistry(logDir).filter((x) => x.worker === wid)) {
    try {
      if (await ops.closeIterm(e.session)) closed = true;
    } catch {
      /* iTerm gone: the entry is stale either way */
    }
    dropEntry(logDir, e);
  }
  return closed;
}

export interface CloseEndedResult {
  closed: string[];
  kept: string[];
}

/**
 * Close every open follow pane whose worker has ended: registry entries first
 * (by worker id), then any iTerm session named after / tmux pane started with a
 * `worker follow <id>` command of an ended worker. `ended(id)` says whether
 * that worker is over; unknown ids are never closed. `dryRun` only reports.
 */
export async function closeEndedPanes(
  logDir: string,
  ended: (wid: string) => boolean,
  dryRun: boolean,
  ops: PaneOps = realPaneOps
): Promise<CloseEndedResult> {
  const res: CloseEndedResult = { closed: [], kept: [] };
  const seen = new Set<string>();
  const handle = async (backend: "iterm" | "tmux", id: string, worker: string, entry?: PaneEntry): Promise<void> => {
    const key = `${backend}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!ended(worker)) {
      res.kept.push(`${worker} ${key} (running)`);
      return;
    }
    if (!dryRun) {
      const ok = backend === "tmux" ? ops.closeTmux(id) : await ops.closeIterm(id).catch(() => false);
      if (entry) dropEntry(logDir, entry); // stale whether or not the pane still existed
      if (!ok && !entry) return;
    }
    res.closed.push(`${worker} ${key}${dryRun ? " (dry run)" : ""}`);
  };
  const sessions = await ops.listIterm();
  const open = new Set(sessions.map((s) => s.id));
  for (const e of loadRegistry(logDir)) {
    // iTerm answered and the session is gone: a stale entry, forgotten without a close
    if (sessions.length && !open.has(e.session)) {
      if (!dryRun) dropEntry(logDir, e);
      continue;
    }
    await handle("iterm", e.session, e.worker, e);
  }
  for (const s of sessions) {
    const m = FOLLOW_ID.exec(s.name);
    if (m) await handle("iterm", s.id, m[1]);
  }
  for (const t of ops.listTmux()) {
    const m = FOLLOW_ID.exec(t.command);
    if (m) await handle("tmux", t.id, m[1]);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * The command a worker pane runs: one exec-able line with no shell syntax —
 * iTerm's split command parameter execs without a shell (proven live: panes
 * survive `sleep 30` and a single-quoted `/bin/sh -c`, die instantly on
 * `export …; …` or a redirect), so the command must be one exec-able line.
 * Absolute node on the CLI entry file also sidesteps the panes' bare launchd
 * PATH (no pai, no node) and the `#!/usr/bin/env node` shebang.
 */
export function followCommand(wid: string, autoExitSecs: number): string {
  return `${process.execPath} ${absoluteCliPath()} worker follow ${wid} --auto-exit ${autoExitSecs}`;
}

/** Absolute path of the running pai CLI; falls back to PATH lookup at spawn. */
function absoluteCliPath(): string {
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith("pai")) return argv1;
  return "pai";
}

export type PaneBackend = "tmux" | "iterm" | "none";

/** The one place that decides where a follow pane opens: tmux (any OS) > iTerm2 (macOS) > nowhere. */
export function paneBackend(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): PaneBackend {
  if (env.TMUX) return "tmux";
  if (platform === "darwin" && env.ITERM_SESSION_ID) return "iterm";
  return "none";
}

export function noPaneMessage(wid?: string): string {
  return `no pane support here, use: pai worker follow${wid ? ` ${wid}` : ""}`;
}

/** Split the current tmux window horizontally (right-hand column) and run cmd in it, focus stays put. */
function tmuxSplit(cmd: string): void {
  const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
  try {
    execFileSync("tmux", ["split-window", "-h", "-d", "-l", "40%", ...target, cmd], { stdio: "pipe" });
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    throw new Error(`pai worker pane: tmux split-window failed: ${(err.stderr?.toString() || err.message || "").trim().slice(0, 200)}`);
  }
}

/** Outcome of opening a worker's follow pane: the report line plus, on a fresh open, the new iTerm session id. */
export interface PaneOpenResult {
  message: string;
  session: string | null;
}

/** Open (or only report on) the stacked follow pane of one worker. */
export async function openPaneForWorker(
  logDir: string,
  config: WorkersConfig,
  wid: string,
  term: string
): Promise<PaneOpenResult> {
  if (workerPaneOpen(wid)) return { message: `pane for ${wid} already open`, session: null };
  const backend = paneBackend();
  if (backend === "none") return { message: noPaneMessage(wid), session: null };
  if (backend === "tmux") {
    tmuxSplit(followCommand(wid, config.pane.autoExitSecs));
    return { message: `pane opened for ${wid}`, session: null };
  }
  const uid = itermUuid(term);
  const scope = scopeKey(term);
  const reg = loadRegistry(logDir, scope);
  const profile = await followProfile(config.pane.fontSize);
  const cmd = followCommand(wid, config.pane.autoExitSecs);
  // registry newest first: the split lands below the lowest live worker pane
  const cands = [...reg].reverse().map((e) => e.session).join(",");
  const p = await osascript(WORKER_SPLIT_SCRIPT, [uid, cands, cmd, profile]);
  const out = p.stdout.trim();
  if (out === "notfound" || out === "notrunning") {
    throw new Error(
      out === "notfound"
        ? "pai worker pane: no open iTerm2 session matches ITERM_SESSION_ID"
        : "pai worker pane: iTerm2 is not running"
    );
  }
  const bar = out.indexOf("|");
  if (bar < 0) {
    throw new Error(
      `pai worker pane: osascript failed: ${(p.stderr || out).slice(0, 200)}`
    );
  }
  const live = new Set(out.slice(0, bar).split(",").filter(Boolean));
  for (const e of reg) if (!live.has(e.session)) dropEntry(logDir, e);
  saveEntry(logDir, {
    session: out.slice(bar + 1),
    worker: wid,
    opened: new Date().toISOString().replace("T", " ").slice(0, 19),
    scope,
  });
  return { message: `pane opened for ${wid}`, session: out.slice(bar + 1) };
}

/**
 * One `--check` line with the bounds of the window hosting `term`'s iTerm
 * session — the before/after pair that shows whether a split moved it.
 * Read-only; never touches the window.
 */
async function windowBoundsLine(term: string): Promise<string> {
  const uid = itermUuid(term);
  if (!uid) return "window bounds: (not in iTerm2)";
  try {
    const p = await osascript(WINDOW_BOUNDS_SCRIPT, [uid]);
    const out = p.stdout.trim();
    if (out && out !== "notfound" && out !== "notrunning") return `window bounds: ${out}`;
    const why =
      out === "notfound" ? "iTerm2 session not found"
      : out === "notrunning" ? "iTerm2 not running"
      : (p.stderr.trim() || "no output").slice(0, 120);
    return `window bounds: (${why})`;
  } catch (e) {
    return `window bounds: (osascript: ${String((e as Error).message ?? e).slice(0, 120)})`;
  }
}

/**
 * Report-only variant used by `pai worker pane <id> --check`: whether a pane
 * runs for the worker, the bounds of the window hosting the asking session,
 * plus the dynamic profile's path, its existence, and the font it contains
 * (or, when missing, would write).
 */
export async function checkPaneForWorker(wid: string, fontSize: number, term: string): Promise<string> {
  const lines = [workerPaneOpen(wid) ? `pane for ${wid} open` : `no pane for ${wid}`];
  if (paneBackend() !== "iterm") return lines.join("\n");
  lines.push(await windowBoundsLine(term));
  const path = dynamicProfilePath();
  if (existsSync(path)) {
    let font = "(unreadable)";
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        Profiles?: Array<{ "Normal Font"?: string }>;
      };
      font = parsed.Profiles?.[0]?.["Normal Font"] ?? "(none)";
    } catch {
      // font stays "(unreadable)"
    }
    lines.push(`profile file: ${path} (exists)`);
    lines.push(`profile font: ${font}`);
  } else {
    const parent = defaultBookmark();
    lines.push(`profile file: ${path} (missing)`);
    lines.push(`profile font (would write): ${paneFont(parent?.["Normal Font"], fontSize)}`);
  }
  return lines.join("\n");
}

/**
 * Split this iTerm tab and run `pai worker follow` in the new pane, unless
 * one already runs here (detected by TTY — iTerm overwrites session names
 * with the running command, so names cannot serve as idempotence).
 */
export async function openFollowPane(
  logDir: string,
  _config: WorkersConfig,
  term: string,
  checkOnly: boolean
): Promise<string> {
  void logDir;
  const backend = paneBackend();
  if (backend === "none") return noPaneMessage();
  if (backend === "tmux") {
    if (checkOnly) return "no follow pane";
    tmuxSplit(`${process.execPath} ${absoluteCliPath()} worker follow`);
    return "follow pane opened";
  }
  const uid = itermUuid(term);
  const p = await osascript(TAB_TTYS_SCRIPT, [uid]);
  const out = p.stdout.trim();
  if (out === "notfound") throw new Error("pai worker pane: no open iTerm2 session matches ITERM_SESSION_ID");
  if (out === "notrunning") throw new Error("pai worker pane: iTerm2 is not running");
  const tabTtys = new Set(out.split(",").map((t) => t.trim()).filter(Boolean));
  const overlap = [...tabTtys].filter((t) => followTtys().has(t));
  if (overlap.length > 0) return "follow pane already open";
  if (checkOnly) return "no follow pane";
  // one exec-able line, no shell syntax — see followCommand()
  const cmd = `${process.execPath} ${absoluteCliPath()} worker follow`;
  const s = await osascript(SPLIT_SCRIPT, [uid, cmd]);
  const sout = s.stdout.trim();
  if (sout === "opened") return "follow pane opened";
  if (sout === "notfound") throw new Error("pai worker pane: no open iTerm2 session matches ITERM_SESSION_ID");
  throw new Error(`pai worker pane: osascript failed: ${(s.stderr || sout).slice(0, 200)}`);
}
