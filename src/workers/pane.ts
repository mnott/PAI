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
import { panesDir, statusPath } from "./paths.js";
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
// JXA scripts (arguments are passed as argv items, never interpolated).
// JXA, not AppleScript: iTerm's AppleScript window collection can get stuck
// failing every enumeration ("every window doesn't understand the count
// message", -1708) while the JXA object model keeps answering.
// ---------------------------------------------------------------------------

// Shared prelude: locate the window/tab/session with a given unique id.
const FIND_SESSION = `function findSession(app, id) {
    var ws = app.windows();
    for (var i = 0; i < ws.length; i++) {
        var ts = ws[i].tabs();
        for (var j = 0; j < ts.length; j++) {
            var ss = ts[j].sessions();
            for (var k = 0; k < ss.length; k++) {
                if (ss[k].id() === id) return { w: ws[i], t: ts[j], s: ss[k], all: ss };
            }
        }
    }
    return null;
}`;

// Smallest height a follow pane may be split down to (the visible-pane gate
// refuses anything under 8 rows).
const MIN_ROWS = 8;

// Equalise the follow panes' heights. iTerm exposes no pane position, so panes
// are grouped by column count: panes stacked in one column share it, and a
// group of equal width splits its summed rows evenly. ponytail: two columns of
// equal width but unequal stack height are balanced as one group; upgrade to
// real geometry if iTerm ever exposes it. Expects the `live` session list.
const REBALANCE = `var groups = {};
    live.forEach(function (o) { var c = o.columns(); (groups[c] = groups[c] || []).push([o, o.rows()]); });
    Object.keys(groups).forEach(function (c) {
        var g = groups[c];
        var want = Math.floor(g.reduce(function (a, e) { return a + e[1]; }, 0) / g.length);
        g.forEach(function (e) { try { e[0].rows = want; } catch (x) {} });
    });`;

// One pane per worker: split the launching session vertically, or the lowest
// live candidate horizontally. Returns "<live ids>,|<new session id>".
// Exported for the script-content tests (window size, argv-only arguments).
export const WORKER_SPLIT_SCRIPT = `${FIND_SESSION}
var MIN_ROWS = ${MIN_ROWS};
function run(argv) {
    var targetID = argv[0], candList = argv[1], followCmd = argv[2], profileName = argv[3];
    var app = Application("iTerm2");
    if (!app.running()) return "notrunning";
    var f = findSession(app, targetID);
    if (!f) return "notfound";
    // sizing the new session would grow the whole window: pin the window's
    // bounds now and restore them after the split, so the panes share the
    // existing space
    var winBounds = f.w.bounds();
    var sessIDs = f.all.map(function (o) { return o.id(); });
    var lived = [];
    var live = [];
    (candList === "" ? [] : candList.split(",")).forEach(function (cid) {
        var at = sessIDs.indexOf(cid);
        if (at < 0) return;
        lived.push(cid);
        live.push(f.all[at]);
    });
    // split the LARGEST worker pane (by area), never the newest: halving the
    // newest pane caps a tab at ~4 workers. Stack (horizontal split) while
    // both halves keep >= MIN_ROWS rows, else add a column (vertical split).
    var splitS = null;
    live.forEach(function (o) { if (!splitS || o.columns() * o.rows() > splitS.columns() * splitS.rows()) splitS = o; });
    var stack = splitS && Math.floor(splitS.rows() / 2) >= MIN_ROWS + 1;
    // the follow command is part of the split itself: the pane is born already
    // running it, so no text is ever typed into any session — a typing step
    // raced the operator's keystrokes and could even land in the operator's
    // own session
    var newS;
    if (!splitS || !stack) {
        var base = splitS || f.s;
        newS = profileName === ""
            ? base.splitVerticallyWithDefaultProfile({ command: followCmd })
            : base.splitVertically({ withProfile: profileName, command: followCmd });
    } else {
        newS = profileName === ""
            ? splitS.splitHorizontallyWithDefaultProfile({ command: followCmd })
            : splitS.splitHorizontally({ withProfile: profileName, command: followCmd });
    }
    live.push(newS);
    ${REBALANCE}
    // a split makes the new session the tab's active one: re-select the
    // launching session so focus returns to where the operator was typing,
    // never the new pane
    try { f.s.select(); } catch (e) {}
    try { f.w.bounds = winBounds; } catch (e) {}
    return lived.map(function (l) { return l + ","; }).join("") + "|" + newS.id();
}`;

// TTys of every session in the launching session's tab (no-worker pane variant),
// comma-joined.
const TAB_TTYS_SCRIPT = `${FIND_SESSION}
function run(argv) {
    var app = Application("iTerm2");
    if (!app.running()) return "notrunning";
    var f = findSession(app, argv[0]);
    if (!f) return "notfound";
    return f.all.map(function (o) { return o.tty(); }).join(",");
}`;

// Bounds (x1, y1, x2, y2, comma-joined) of the window hosting one iTerm
// session — read-only, for `pai worker pane <id> --check`. Exported for the
// script-content tests (reads bounds, never sets them).
export const WINDOW_BOUNDS_SCRIPT = `${FIND_SESSION}
function run(argv) {
    var app = Application("iTerm2");
    if (!app.running()) return "notrunning";
    var f = findSession(app, argv[0]);
    if (!f) return "notfound";
    var b = f.w.bounds();
    return [b.x, b.y, b.x + b.width, b.y + b.height].join(", ");
}`;

// Split the launching session vertically and run followCmd in the new pane.
// Exported for the script-content tests (focus stays on the launching session).
export const SPLIT_SCRIPT = `${FIND_SESSION}
function run(argv) {
    var followCmd = argv[1];
    var app = Application("iTerm2");
    if (!app.running()) return "notrunning";
    var f = findSession(app, argv[0]);
    if (!f) return "notfound";
    // the follow command is part of the split itself (see WORKER_SPLIT_SCRIPT):
    // nothing is ever typed into a session afterwards
    f.s.splitVerticallyWithDefaultProfile({ command: followCmd });
    // keep the tab's active session where it was (see WORKER_SPLIT_SCRIPT)
    try { f.s.select(); } catch (e) {}
    return "opened";
}`;

// ---------------------------------------------------------------------------
// osascript / ps / defaults helpers
// ---------------------------------------------------------------------------

/** Run a JXA script with argv. Rejects when osascript itself cannot run. */
function osascript(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", ["-l", "JavaScript", "-", ...args], { stdio: ["pipe", "pipe", "pipe"] });
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

// One listing for every caller. Each property is read on its own: iTerm 3.7 can
// throw on name() for a session, which must not drop the others.
const LIST_SESSIONS_SCRIPT = `function run(argv) {
    var app = Application("iTerm2");
    if (!app.running()) return "";
    function get(s, k) { try { return String(s[k]()); } catch (e) { return ""; } }
    var out = "";
    app.windows().forEach(function (w) {
        w.tabs().forEach(function (t) {
            t.sessions().forEach(function (s) {
                var id = get(s, "id");
                function v(n) { try { return String(s.variable({ named: n })); } catch (e) { return ""; } }
                if (id) out += id + "\\t" + get(s, "tty") + "\\t" + v("jobPid") + "\\t" + v("pid") + "\\t" + get(s, "name") + "\\n";
            });
        });
    });
    return out;
}`;

export interface ItermSession {
  id: string;
  tty: string;
  /** Pid of the session's foreground job (variable "jobPid"), undefined when iTerm gave none. */
  jobPid?: number;
  /** Pid of the session's root process (variable "pid"). */
  pid?: number;
  /** Undefined when iTerm would not give the session's name. */
  name?: string;
}

/** Every open iTerm session. [] when iTerm is not running; rejects when the script fails. */
export async function listItermSessions(
  run: (script: string, args: string[]) => Promise<{ stdout: string }> = osascript
): Promise<ItermSession[]> {
  const p = await run(LIST_SESSIONS_SCRIPT, []);
  return p.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, tty, jobPid, pid, ...name] = l.split("\t");
      return { id, tty, jobPid: Number(jobPid) || undefined, pid: Number(pid) || undefined, name: name.join("\t") || undefined };
    });
}

// Ends one session by its unique id, never a window or the app.
const END_SESSION_SCRIPT = `${FIND_SESSION}
function run(argv) {
    var app = Application("iTerm2");
    if (!app.running()) return "notrunning";
    var f = findSession(app, argv[0]);
    if (!f) return "notfound";
    f.s.close();
    return "closed";
}`;

// Re-balance the follow panes (argv[0]: comma-joined session ids) after a close.
export const REBALANCE_SCRIPT = `${FIND_SESSION}
function run(argv) {
    var ids = argv[0].split(",");
    var app = Application("iTerm2");
    if (!app.running()) return "notrunning";
    var f = null;
    for (var i = 0; i < ids.length && !f; i++) f = findSession(app, ids[i]);
    if (!f) return "notfound";
    var winBounds = f.w.bounds();
    var live = f.all.filter(function (o) { return ids.indexOf(o.id()) >= 0; });
    ${REBALANCE}
    try { f.w.bounds = winBounds; } catch (e) {}
    return "balanced";
}`;

/** The real iTerm / tmux calls, swappable so tests never touch either. */
export interface PaneOps {
  listIterm(): Promise<Array<{ id: string; name: string }>>;
  closeIterm(id: string): Promise<boolean>;
  listTmux(): Array<{ id: string; command: string }>;
  closeTmux(id: string): boolean;
  /** Equalise the heights of the given follow panes (optional: tests omit it). */
  rebalanceIterm?(ids: string[]): Promise<void>;
}

export const realPaneOps: PaneOps = {
  async listIterm() {
    if (process.platform !== "darwin") return [];
    const sessions = await listItermSessions();
    // iTerm renames a pane after its running command ("node"), so the follow
    // command is looked up by the session's tty instead
    const cmdByTty = new Map<string, string>();
    for (const line of psOutput("tty=,command=").split("\n")) {
      const [tty, ...rest] = line.trim().split(/\s+/);
      if (tty && tty !== "??") cmdByTty.set(`/dev/${tty}`, rest.join(" "));
    }
    return sessions.map((x) => ({ id: x.id, name: `${x.name ?? ""} ${cmdByTty.get(x.tty) ?? ""}`.trim() }));
  },
  async closeIterm(id) {
    const p = await osascript(END_SESSION_SCRIPT, [id]);
    return p.stdout.trim() === "closed";
  },
  async rebalanceIterm(ids) {
    if (ids.length) await osascript(REBALANCE_SCRIPT, [ids.join(",")]);
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

/**
 * The follow pane closing its own iTerm session on exit, so a pane closes even
 * when the runner died and even under a profile without Close Sessions On End.
 * No-op outside iTerm.
 */
export async function closeOwnPane(env: NodeJS.ProcessEnv = process.env, ops: PaneOps = realPaneOps): Promise<boolean> {
  const uid = itermUuid(env.ITERM_SESSION_ID ?? "");
  if (!uid) return false;
  return ops.closeIterm(uid).catch(() => false);
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
  // iTerm unreachable: no live-session view, registry entries are still handled
  const sessions = await ops.listIterm().catch(() => []);
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
  // closed panes leave uneven neighbours: re-balance what is left
  if (!dryRun && res.closed.length) {
    await ops.rebalanceIterm?.(loadRegistry(logDir).map((e) => e.session)).catch(() => undefined);
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
 * No --auto-exit: a finished worker's pane stays until the operator closes it
 * (exit the follow) or the next pane opened in the same scope replaces it.
 * Absolute node on the CLI entry file also sidesteps the panes' bare launchd
 * PATH (no pai, no node) and the `#!/usr/bin/env node` shebang.
 */
export function followCommand(wid: string): string {
  return `${process.execPath} ${absoluteCliPath()} worker follow ${wid}`;
}

/** Absolute path of the running pai CLI; falls back to PATH lookup at spawn. */
function absoluteCliPath(): string {
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith("pai")) return argv1;
  return "pai";
}

// ---------------------------------------------------------------------------
// Host session — which iTerm session launched this process
// ---------------------------------------------------------------------------

/** Lookups behind resolveHostSession, swappable so tests never touch ps or iTerm. */
export interface HostDeps {
  /** [ppid, tty] of a pid, null when ps cannot say. tty is as ps prints it ("ttys004", "??"). */
  psOf(pid: number): [number, string] | null;
  /** Command line per pid, one batched ps call; pids ps does not know are absent. */
  commandsOf(pids: number[]): Map<number, string>;
  /** Every open iTerm session. Empty when iTerm is not running or unreachable. */
  listSessions(): Promise<ItermSession[]>;
}

export const realHostDeps: HostDeps = {
  psOf(pid) {
    try {
      const out = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      }).trim();
      const [ppid, tty] = out.split(/\s+/);
      return ppid && tty ? [Number(ppid), tty] : null;
    } catch {
      return null;
    }
  },
  commandsOf(pids) {
    const m = new Map<number, string>();
    if (!pids.length) return m;
    let out = "";
    try {
      out = execFileSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? ""; // ps exits 1 when some pid is gone
    }
    for (const l of out.split("\n")) {
      const r = /^\s*(\d+)\s+(.*)$/.exec(l);
      if (r) m.set(Number(r[1]), r[2]);
    }
    return m;
  },
  async listSessions() {
    if (process.platform !== "darwin") return [];
    try {
      return await listItermSessions();
    } catch {
      return [];
    }
  },
};

/** Pids from `start` up through its parents (self included), stopping at init or an unknown pid. */
function ancestorPids(deps: HostDeps, start: number): number[] {
  const pids: number[] = [];
  for (let pid = start; pids.length < 64 && pid > 1; ) {
    pids.push(pid);
    const row = deps.psOf(pid);
    if (!row) break;
    pid = row[0];
  }
  return pids;
}

/** /dev/ttysNNN of the nearest ancestor (self included) that has a real tty, null when none. */
export function ancestorTty(deps: HostDeps = realHostDeps, start: number = process.pid): string | null {
  let pid = start;
  for (let i = 0; i < 64 && pid > 1; i++) {
    const row = deps.psOf(pid);
    if (!row) return null;
    const [ppid, tty] = row;
    if (tty && tty !== "??" && tty !== "?") return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    pid = ppid;
  }
  return null;
}

export interface HostSession {
  /** iTerm unique id of the host session, "" when none was found. */
  uid: string;
  /** ITERM_SESSION_ID-shaped value for status/scope: the env value when it names the host, else the bare uid. "" when none. */
  term: string;
  /** Which step resolved it: "foreground jobPid", "attach <short>", "tty", "env", or "none". */
  via: string;
  reason?: string;
}

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Claude session id from a Claude process command line: `--session-id <uuid>` or `--bg-pty-host …/pty/<short>.sock`. */
function claudeIdOf(cmd: string): string | undefined {
  return new RegExp(`--session-id[ =](${UUID_RE})`, "i").exec(cmd)?.[1] ?? /--bg-pty-host\s+\S*\/pty\/([0-9a-f]{8})\.sock/i.exec(cmd)?.[1];
}

/**
 * The one place that decides which iTerm session hosts this process; first hit
 * wins:
 *  1. foreground: a session whose jobPid is CLAUDE_PID or an ancestor pid
 *  2. background (`claude attach <short>`): the Claude session id from env or an
 *     ancestor's command line, matched against each session's jobPid command;
 *     several matches are ambiguous and fail loudly
 *  3. the tty of the nearest ancestor that has one
 *  4. ITERM_SESSION_ID, only when it names a live session — a reattached session
 *     keeps its old id in the process env for good
 */
export async function resolveHostSession(
  env: NodeJS.ProcessEnv = process.env,
  deps: HostDeps = realHostDeps,
  start: number = process.pid
): Promise<HostSession> {
  const sessions = await deps.listSessions();
  const envTerm = env.ITERM_SESSION_ID ?? "";
  const envUid = itermUuid(envTerm);
  const found = (s: { id: string }, via: string): HostSession => ({ uid: s.id, term: s.id === envUid ? envTerm : s.id, via });
  const notes: string[] = [];

  const ancestors = ancestorPids(deps, start);
  const jobPids = sessions.flatMap((s) => (s.jobPid ? [s.jobPid] : []));
  const cmds = deps.commandsOf([...new Set([...ancestors, ...jobPids])]);

  const fg = new Set(ancestors);
  if (Number(env.CLAUDE_PID)) fg.add(Number(env.CLAUDE_PID));
  const byJob = sessions.find((s) => s.jobPid && fg.has(s.jobPid));
  if (byJob) return found(byJob, "foreground jobPid");
  notes.push(`foreground: no session jobPid is CLAUDE_PID ${env.CLAUDE_PID || "(unset)"} or an ancestor`);

  const cid = env.CLAUDE_CODE_SESSION_ID || ancestors.map((p) => claudeIdOf(cmds.get(p) ?? "")).find(Boolean);
  if (cid) {
    const short = cid.slice(0, 8);
    const attach = new RegExp(`\\battach\\s+(${short}|${cid})\\b`, "i");
    const hits = sessions.filter((s) => s.jobPid && attach.test(cmds.get(s.jobPid) ?? ""));
    if (hits.length === 1) return found(hits[0], `attach ${short}`);
    const why = hits.length ? `ambiguous, ${hits.length} sessions run attach ${short}: ${hits.map((s) => s.id).join(", ")}` : `no session runs attach ${short}`;
    if (hits.length) return { uid: "", term: "", via: "none", reason: [...notes, `attach: ${why}`].join("; ") };
    notes.push(`attach: ${why}`);
  } else {
    notes.push("attach: no Claude session id in env or ancestors");
  }

  const tty = ancestorTty(deps, start);
  const byTty = tty ? sessions.find((s) => s.tty === tty) : undefined;
  if (byTty) return found(byTty, "tty");
  notes.push(tty ? `tty: ancestor tty ${tty} matched no session` : "tty: no tty ancestor");

  if (envUid && sessions.some((s) => s.id === envUid)) return { uid: envUid, term: envTerm, via: "env" };
  notes.push(`env: ITERM_SESSION_ID ${envTerm ? `${envTerm} is not live` : "is unset"}`);

  const why = sessions.length === 0 ? "iTerm2 not running or unreachable" : "no live iTerm2 session matched";
  return { uid: "", term: "", via: "none", reason: `${why}; ${notes.join("; ")}` };
}

export type PaneBackend = "tmux" | "iterm" | "none";

/** The one place that decides where a follow pane opens: tmux (any OS) > iTerm2 (macOS) > nowhere. */
export function paneBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  hostTerm: string = ""
): PaneBackend {
  if (env.TMUX) return "tmux";
  if (platform === "darwin" && (env.ITERM_SESSION_ID || hostTerm)) return "iterm";
  return "none";
}

const NO_HOST = "pai worker pane: no live iTerm2 host session (foreground, attach, tty lookups found none, ITERM_SESSION_ID not live)";

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

/** Worker state straight from its status file (pane.ts cannot import status.ts: it imports us). */
function workerEnded(logDir: string, wid: string): boolean {
  try {
    const st = JSON.parse(readFileSync(statusPath(logDir, wid), "utf8")) as { state?: string };
    return !!st.state && st.state !== "running";
  } catch {
    return false;
  }
}

/** The replacement rule: a new pane in a scope closes that scope's panes of ended workers. */
async function closeEndedInScope(logDir: string, scope: string, ops: PaneOps = realPaneOps): Promise<void> {
  for (const e of loadRegistry(logDir, scope)) {
    if (!workerEnded(logDir, e.worker)) continue;
    await ops.closeIterm(e.session).catch(() => false);
    dropEntry(logDir, e);
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
  const backend = paneBackend(process.env, process.platform, term);
  if (backend === "none") return { message: noPaneMessage(wid), session: null };
  if (backend === "tmux") {
    tmuxSplit(followCommand(wid));
    return { message: `pane opened for ${wid}`, session: null };
  }
  const uid = itermUuid(term);
  if (!uid) throw new Error(NO_HOST);
  const scope = scopeKey(term);
  await closeEndedInScope(logDir, scope);
  const reg = loadRegistry(logDir, scope);
  const profile = await followProfile(config.pane.fontSize);
  const cmd = followCommand(wid);
  // registry newest first: the split lands below the lowest live worker pane
  const cands = [...reg].reverse().map((e) => e.session).join(",");
  const p = await osascript(WORKER_SPLIT_SCRIPT, [uid, cands, cmd, profile]);
  const out = p.stdout.trim();
  if (out === "notfound" || out === "notrunning") {
    throw new Error(
      out === "notfound"
        ? "pai worker pane: resolved iTerm2 session vanished"
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
  if (paneBackend(process.env, process.platform, term) !== "iterm") return lines.join("\n");
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
  const backend = paneBackend(process.env, process.platform, term);
  if (backend === "none") return noPaneMessage();
  if (backend === "tmux") {
    if (checkOnly) return "no follow pane";
    tmuxSplit(`${process.execPath} ${absoluteCliPath()} worker follow`);
    return "follow pane opened";
  }
  const uid = itermUuid(term);
  if (!uid) throw new Error(NO_HOST);
  const p = await osascript(TAB_TTYS_SCRIPT, [uid]);
  const out = p.stdout.trim();
  if (out === "notfound") throw new Error("pai worker pane: resolved iTerm2 session vanished");
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
  if (sout === "notfound") throw new Error("pai worker pane: resolved iTerm2 session vanished");
  throw new Error(`pai worker pane: osascript failed: ${(s.stderr || sout).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Fail-closed visibility: a headless worker runs only behind a verified pane
// ---------------------------------------------------------------------------

/**
 * The operator-only switch that lets a run go headless: this file's existence.
 * The PreToolUse Bash hook denies any command naming it, so a Claude session
 * cannot create it through Bash; only the operator's own shell can.
 */
export function headlessOverridePath(): string {
  return process.env.PAI_HEADLESS_OK_FILE ?? join(homedir(), ".claude", "pai", "headless-ok");
}

/**
 * Why this process may run a worker without a verified pane, null when it may
 * not. Two reasons only: it is itself a worker (PAI_WORKER=1: a child spawned
 * inside its parent's pane may stay headless) or the operator created the
 * override file.
 */
export function headlessAllowed(env: NodeJS.ProcessEnv = process.env, file: string = headlessOverridePath()): string | null {
  if (env.PAI_WORKER === "1") return "PAI_WORKER=1 (child of a worker, runs inside its parent's pane)";
  if (existsSync(file)) return `operator override file ${file}`;
  return null;
}

// Brings the host's window and tab to the front, then reports where the pane
// sits. JSON on stdout; `fail` set when the pane is not a visible, usable
// neighbour of the host session.
export const VERIFY_PANE_SCRIPT = `${FIND_SESSION}
function run(argv) {
    var app = Application("iTerm2");
    if (!app.running()) return JSON.stringify({ fail: "iTerm2 is not running" });
    var h = findSession(app, argv[0]);
    if (!h) return JSON.stringify({ fail: "host session " + argv[0] + " is gone" });
    var p = findSession(app, argv[1]);
    if (!p) return JSON.stringify({ fail: "pane session " + argv[1] + " is gone (closed right after opening)" });
    function ids(ss) { return ss.map(function (o) { return o.id(); }); }
    if (h.w.id() !== p.w.id()) return JSON.stringify({ fail: "pane is in window " + p.w.id() + ", host in window " + h.w.id() });
    if (ids(h.all).indexOf(argv[1]) < 0) return JSON.stringify({ fail: "pane is not in the host's tab" });
    try { h.w.miniaturized = false; } catch (e) {}
    try { h.t.select(); } catch (e) {}
    try { h.w.select(); } catch (e) {}
    try { h.s.select(); } catch (e) {}
    var tabs = h.w.tabs();
    var tabIdx = 0;
    for (var i = 0; i < tabs.length; i++) if (ids(tabs[i].sessions()).indexOf(argv[0]) >= 0) tabIdx = i + 1;
    var selected = ids(h.w.currentTab().sessions()).indexOf(argv[1]) >= 0;
    var front = app.currentWindow().id() === h.w.id();
    var b = h.w.bounds();
    return JSON.stringify({
        window: h.w.id(), bounds: [b.x, b.y, b.width, b.height], tab: tabIdx + "/" + tabs.length,
        selectedTab: selected, frontWindow: front, miniaturized: h.w.miniaturized(),
        rows: p.s.rows(), cols: p.s.columns(), tty: p.s.tty(), hostRows: h.s.rows(), hostCols: h.s.columns()
    });
}`;

const MIN_PANE_ROWS = 8;
const MIN_PANE_COLS = 40;

/** True while a `worker follow <wid>` process runs on that tty. */
function followRunsOn(tty: string, wid: string): boolean {
  const short = tty.replace(/^\/dev\//, "");
  return psOutput("tty=,command=")
    .split("\n")
    .some((ln) => ln.trim().startsWith(`${short} `) && new RegExp(`worker follow ${wid}\\b`).test(ln));
}

/**
 * Check, and bring forward, the iTerm pane of a worker. Resolves with a line
 * naming window, tab and size; rejects with the reason when the pane is not
 * something the operator can see: gone, other window or tab, tab not selected,
 * window behind or minimised, too small, or its follow command not running
 * (polled for up to ~7 s while the new session starts it).
 */
export async function verifyPane(
  hostUid: string,
  paneUid: string,
  wid: string,
  run: (script: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = osascript,
  running: (tty: string, wid: string) => boolean = followRunsOn,
  tries = 25,
  pollMs = 300
): Promise<string> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const p = await run(VERIFY_PANE_SCRIPT, [hostUid, paneUid]);
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(p.stdout.trim()) as Record<string, unknown>;
    } catch {
      throw new Error(`pane verification failed: osascript said ${(p.stderr || p.stdout || "nothing").trim().slice(0, 200)}`);
    }
    if (typeof r.fail === "string") throw new Error(`pane verification failed: ${r.fail}`);
    const rows = Number(r.rows);
    const cols = Number(r.cols);
    const where = `window ${r.window} [${(r.bounds as number[]).join(",")}] tab ${r.tab}, pane ${cols}x${rows}, ${r.tty}`;
    if (r.miniaturized === true) throw new Error(`pane verification failed: window is minimised (${where})`);
    if (r.selectedTab !== true) throw new Error(`pane verification failed: its tab is not the selected one (${where})`);
    if (r.frontWindow !== true) throw new Error(`pane verification failed: its window is not the front iTerm2 window (${where})`);
    if (rows < MIN_PANE_ROWS || cols < MIN_PANE_COLS) {
      throw new Error(`pane verification failed: pane too small, ${cols}x${rows} < ${MIN_PANE_COLS}x${MIN_PANE_ROWS} (${where})`);
    }
    if (running(String(r.tty), wid)) return where;
    last = where;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  throw new Error(`pane verification failed: \`worker follow ${wid}\` is not running in the pane (${last})`);
}

/**
 * Open the worker's pane and prove the operator can see it, or throw the
 * reason (the pane just opened is closed again). Needs a live iTerm2 host
 * session that ITERM_SESSION_ID itself names, or tmux; a stale or invented
 * id is refused, whatever the process-tree lookup would find.
 */
export async function openVerifiedPane(
  logDir: string,
  config: WorkersConfig,
  wid: string,
  term: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (env.TMUX) {
    const r = await openPaneForWorker(logDir, config, wid, term);
    if (!r.message.startsWith("pane opened")) throw new Error(`pane verification failed: ${r.message}`);
    return "tmux pane";
  }
  const envUid = itermUuid(env.ITERM_SESSION_ID ?? "");
  const hostUid = itermUuid(term);
  if (!envUid) throw new Error("neither TMUX nor ITERM_SESSION_ID is set: this process does not run in a terminal pane the operator sees");
  if (envUid !== hostUid) {
    throw new Error(`ITERM_SESSION_ID names ${envUid}, which is not a live iTerm2 session${hostUid ? ` (host found: ${hostUid})` : ""}`);
  }
  const r = await openPaneForWorker(logDir, config, wid, term);
  if (!r.session) throw new Error(`pane verification failed: ${r.message}`);
  try {
    return `${await verifyPane(hostUid, r.session, wid)} (iTerm session ${r.session})`;
  } catch (e) {
    await closePaneForWorker(logDir, wid).catch(() => false);
    throw e;
  }
}

/** CLI entry check: --no-pane and PAI_WORKER_AUTOPANE=0 are refused unless headlessAllowed(). */
export function assertPaneNotDisabled(noPaneFlag: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const what = noPaneFlag ? "--no-pane" : env.PAI_WORKER_AUTOPANE === "0" ? "PAI_WORKER_AUTOPANE=0" : "";
  if (what && !headlessAllowed(env)) {
    throw new Error(`${what} refused: every worker runs behind a visible pane (only a worker's own children or the operator's ${headlessOverridePath()} may skip it)`);
  }
}
