/**
 * pick.ts — Interactive project/session picker (`pai` with no args).
 *
 * One door for "find where I worked on something and go there." A self-contained
 * modal TUI (no fzf) over a UNIFIED, deduped list of:
 *   - PROJECTS  (places where knowledge lives — every active project, even cold)
 *   - SESSIONS  (past conversations — live / resumable / transcript)
 * tagged so the two stay visibly distinct.
 *
 * Two modes (see runSelector):
 *   - command (default): ↑↓/j/k move · g go-to-tab · n new · c cd · f finder · q quit
 *   - search (after s or /): type to filter, Enter/esc back to command
 * Action keys fire IMMEDIATELY on the highlighted row — letters are commands in
 * command mode, filter text only in the explicit, visible search mode. This is
 * why a single fzf-style "type to filter" box couldn't work: there, every letter
 * is filter input and can never also be an action.
 *
 * Design decisions (all driven by real pain):
 *   - Filtering matches names, paths, AND folded-in note file/folder names, so
 *     typing "samba" surfaces a project whose *name* is "Chenarlier".
 *   - The detail panel shows context for the HIGHLIGHTED row only (recent notes),
 *     computed lazily — avoids the ~8s/all-sessions live-prompt fetch.
 *   - Actions launch Claude in the CURRENT terminal (g switches the iTerm tab via
 *     the screenshot reveal mechanism; n starts fresh; c hands the dir to the
 *     pai() shell wrapper to cd; f opens the OS file manager).
 *   - Every rendered line is truncated to the window width so nothing wraps
 *     (wrapping desyncs the one-row-per-line layout).
 */

import type { Database } from "better-sqlite3";
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import chalk from "chalk";
import { dim, encodeDir, now } from "../utils.js";
import { scanSessions, fmtAge, type ScannedSession } from "../lib/session-scan.js";
import {
  buildDeduped,
  normalizeName,
  type UnifiedSession,
  type RegisteredProject,
} from "../lib/dedup-sessions.js";
import { writeFileSync } from "node:fs";
import { fetchLiveSessions, revealItermSession } from "../lib/aibroker-client.js";
import { renderDedupedSessions } from "../lib/dedup-sessions.js";
import { launchInDir } from "../lib/launch.js";
import { printExitDir } from "../lib/exit-dir.js";

// ---------------------------------------------------------------------------
// Dispatch record — one per selectable row.
// ---------------------------------------------------------------------------

interface PickRecord {
  /** 'D' = has a directory to act on; 'L' = live-only, no dir. */
  t: "D" | "L";
  name: string;
  dir?: string;
  /** Best resumable session UUID for the dir, if any. */
  uuid?: string;
  /** Live AIBroker / iTerm2 session id (present whenever the row is live). */
  live?: string;
  /** Registry slug, when this row maps to a registered project (enables 'd'). */
  slug?: string;
}

// ---------------------------------------------------------------------------
// Project registry query (ALL active projects — cold ones included on purpose)
// ---------------------------------------------------------------------------

function getProjects(db: Database, includeArchived: boolean): RegisteredProject[] {
  try {
    const rows = db
      .prepare(`
        SELECT p.slug, p.display_name, p.root_path, p.status,
               COUNT(s.id) AS session_count,
               MAX(s.created_at) AS last_active
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id
        GROUP BY p.id
        ORDER BY last_active DESC NULLS LAST, p.updated_at DESC
      `)
      .all() as RegisteredProject[];
    return includeArchived ? rows : rows.filter((p) => p.status === "active");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Note-keyword folding — cheap topic hints from file/folder names
// ---------------------------------------------------------------------------

const KW_SKIP = new Set([
  "node_modules", ".git", ".obsidian", "dist", "build", ".cache", "vendor",
  ".next", "target", "__pycache__", ".venv", "coverage",
]);
const KW_STOP = new Set([
  "the", "and", "for", "with", "notes", "note", "readme", "index", "src",
  "untitled", "new", "draft", "md", "txt",
]);

/** Collect topic tokens from markdown file/folder names, depth-limited. */
function noteKeywords(root: string, maxTokens = 14): string {
  const tokens = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || tokens.size >= maxTokens * 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || KW_SKIP.has(name)) continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        for (const tok of tokenize(name)) tokens.add(tok);
        walk(full, depth + 1);
      } else if (name.toLowerCase().endsWith(".md")) {
        for (const tok of tokenize(name)) tokens.add(tok);
      }
    }
  };
  walk(root, 0);
  return Array.from(tokens).slice(0, maxTokens).join(" ");
}

function tokenize(s: string): string[] {
  return s
    .replace(/\.md$/i, "")
    .replace(/[0-9]+/g, " ")
    .split(/[^a-zA-ZÀ-ſ]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !KW_STOP.has(t));
}

// ---------------------------------------------------------------------------
// Feed construction
// ---------------------------------------------------------------------------

interface FeedLine {
  record: PickRecord;
  /** ANSI-colored display row. */
  display: string;
  /** Lowercased plain text (name · dir · keywords) used for filtering. */
  search: string;
}

function tagFor(status: UnifiedSession["status"]): string {
  switch (status) {
    case "live":
      return chalk.green("live   ");
    case "resumable":
      return chalk.cyan("resume ");
    case "project":
      return chalk.magenta("project");
    default:
      return chalk.dim("old    ");
  }
}

function pad(s: string, n: number): string {
  // pad based on visible length (strip ANSI)
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= n) return s;
  return s + " ".repeat(n - visible.length);
}

function shorten(p: string, max = 40): string {
  if (!p) return "";
  return p.length <= max ? p : "…" + p.slice(-(max - 1));
}

/**
 * Build the candidate list. buildDeduped merges live+disk+registry into one
 * tagged, deduped catalog. showAll=true so cold/idle projects are NOT filtered
 * out (finding old work is the whole point); archived filtering already handled
 * by getProjects().
 */
function buildFeedFrom(
  allSessions: ScannedSession[],
  projects: RegisteredProject[],
  liveSessions: Awaited<ReturnType<typeof fetchLiveSessions>>,
  allProjects: RegisteredProject[]
): FeedLine[] {
  const deduped = buildDeduped(liveSessions, allSessions, projects, true);

  // Directory-resolution maps span ALL projects (archived included). A live
  // session's only source of a cwd is the registry — an archived project like
  // "Chenarlier" still has a real directory, so we must not filter it out here.
  const slugRoot = new Map<string, string>();
  const nameRoot = new Map<string, string>();
  for (const p of allProjects) {
    slugRoot.set(p.slug, p.root_path);
    nameRoot.set(normalizeName(p.display_name ?? p.slug).toLowerCase(), p.root_path);
  }

  const bestResumable = new Map<string, ScannedSession>();
  for (const s of allSessions) {
    if (!s.resumable || !s.encodedDir) continue;
    const prev = bestResumable.get(s.encodedDir);
    if (!prev || s.mtime > prev.mtime) bestResumable.set(s.encodedDir, s);
  }

  const lines: FeedLine[] = [];
  for (const e of deduped) {
    // Skip nameless rows (e.g. a fresh, unnamed live Claude tab whose name
    // normalizes to ""). They're not searchable and just add a blank line.
    if (!e.name.trim()) continue;

    // Resolve directory + resumable uuid
    let dir: string | undefined;
    let uuid: string | undefined;

    if (e.diskSession) {
      dir =
        e.diskSession.clcDirectory ??
        e.diskSession.registryRootPath ??
        e.diskSession.decodedPath;
      uuid = e.diskSession.resumable ? e.diskSession.uuid : undefined;
    } else if (e.status === "project") {
      dir = e.project;
    } else if (e.slug && slugRoot.has(e.slug)) {
      dir = slugRoot.get(e.slug);
    } else {
      // Live-only entry (e.g. a running tab) — recover its directory from the
      // registry by normalized name. This is what makes "go there" work for a
      // live session instead of falling back to a tab switch.
      dir = nameRoot.get(e.name.toLowerCase());
    }

    if (dir && !uuid) {
      const enc = encodeDir(dir);
      uuid = bestResumable.get(enc)?.uuid;
    }

    let record: PickRecord;
    if (dir) {
      // Carry the live id too (when present) so 'g' can switch to the running tab.
      record = { t: "D", name: e.name, dir, uuid, live: e.liveSessionId, slug: e.slug };
    } else if (e.liveSessionId) {
      record = { t: "L", name: e.name, live: e.liveSessionId, slug: e.slug };
    } else {
      continue; // not actionable
    }

    // Keywords for filtering (only when we have a real dir to scan)
    const kw = dir ? noteKeywords(dir) : "";

    const tag = tagFor(e.status);
    const name = chalk.white(pad(e.name, 22));
    const where = dir ? dim(shorten(dir, 40)) : chalk.green("(running in another tab)");
    const age =
      e.status === "live"
        ? chalk.green("now")
        : e.lastActivity > 0
          ? dim(fmtAge(e.lastActivity))
          : dim("—");
    const kwDisp = kw ? dim("  " + kw) : "";
    const display = `${tag}  ${name} ${pad(age, 5)} ${where}${kwDisp}`;
    const search = `${e.name} ${dir ?? ""} ${kw}`.toLowerCase();

    lines.push({ record, display, search });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Modal selector — our own TUI (no fzf). Two modes:
//   command mode (default): ↑↓/j/k move · g go-to-tab · n new · c cd · s search · q quit
//   search mode  (after s or /): type to filter · Enter/esc back to command
// Action keys fire IMMEDIATELY on the highlighted row — no Enter dance, because
// in command mode letters are commands, not filter input. Search is a distinct,
// visible mode so plain letters can be both filter text and actions without
// colliding.
// ---------------------------------------------------------------------------

type PickAction = "new" | "cd" | "switch";

interface SelectorResult {
  record: PickRecord;
  action: PickAction;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Open a path in the OS file manager (Finder / Explorer / xdg-open). */
function openInFileManager(dir: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [dir], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Truncate to `max` visible columns, preserving ANSI color codes (which have
 * zero width) and appending an ellipsis when content is cut. This is what keeps
 * rows from wrapping on a narrow window — wrapping would desync the one-row-per-
 * line layout and make the cursor appear to jump.
 */
function truncVisible(s: string, max: number): string {
  if (max <= 1) return "";
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= max - 1) return out + "…\x1b[0m";
    out += s[i];
    vis++;
    i++;
  }
  return out + "\x1b[0m";
}

function filterLines(lines: FeedLine[], query: string): FeedLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  const tokens = q.split(/\s+/);
  return lines.filter((l) => tokens.every((t) => l.search.includes(t)));
}

/** Cached per-directory context (recent notes) for the detail panel. */
const ctxCache = new Map<string, string[]>();
function contextFor(rec: PickRecord): string[] {
  if (!rec.dir) {
    return rec.live ? [chalk.green("live — running in another tab")] : [dim("no directory on record")];
  }
  const cached = ctxCache.get(rec.dir);
  if (cached) return cached;
  const lines: string[] = [];
  const notes = recentMarkdown(rec.dir, 4);
  if (notes.length) {
    lines.push(dim("recent notes:"));
    for (const n of notes) lines.push("  " + dim(n.rel.slice(0, 60)) + "  " + dim(fmtAge(n.mtime)));
  } else {
    lines.push(dim("(no notes here yet)"));
  }
  ctxCache.set(rec.dir, lines);
  return lines;
}

async function runSelector(
  lines: FeedLine[],
  onRemove?: (rec: PickRecord) => boolean
): Promise<SelectorResult | null> {
  const stdin = process.stdin;
  const out = process.stdout;

  return new Promise<SelectorResult | null>((resolve) => {
    let pool = lines; // mutable: 'd' removes rows from here
    let query = "";
    let mode: "command" | "search" = "command";
    let filtered = pool;
    let cursor = 0;
    let confirm: FeedLine | null = null; // pending 'd' delete confirmation
    let flash = ""; // transient status line

    const wasRaw = stdin.isRaw ?? false;
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* not a tty */
    }
    stdin.resume();
    out.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor

    const teardown = () => {
      out.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        /* ignore */
      }
      stdin.pause();
    };
    const finish = (val: SelectorResult | null) => {
      teardown();
      resolve(val);
    };

    const recompute = () => {
      filtered = filterLines(pool, query);
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    };

    const render = () => {
      const rows = out.rows && out.rows > 8 ? out.rows : 24;
      const cols = out.columns && out.columns > 20 ? out.columns : 100;
      const frame: string[] = [];

      // Header
      const title = chalk.bold("  pai") + dim("  —  find a project or session");
      frame.push(title);
      if (mode === "search") {
        frame.push("  " + chalk.cyan("search > ") + query + chalk.inverse(" "));
      } else {
        frame.push(
          "  " + dim(`${filtered.length}/${lines.length}`) +
          (query ? dim(`  filter: ${query}`) : "")
        );
      }
      frame.push(dim("  " + "─".repeat(Math.min(cols - 4, 80))));

      // List window
      const ctxHeight = 6;
      const listHeight = Math.max(3, rows - 4 - ctxHeight - 2);
      let start = 0;
      if (cursor >= listHeight) start = cursor - listHeight + 1;
      const end = Math.min(filtered.length, start + listHeight);
      if (filtered.length === 0) {
        frame.push("  " + dim("no matches — press s to change the search, esc to quit"));
      }
      for (let i = start; i < end; i++) {
        const row = filtered[i];
        if (i === cursor) {
          frame.push(chalk.inverse(" " + stripAnsi(row.display).slice(0, cols - 2).padEnd(cols - 2)));
        } else {
          frame.push("  " + row.display);
        }
      }

      // Detail panel for the highlighted row
      frame.push(dim("  " + "─".repeat(Math.min(cols - 4, 80))));
      const cur = filtered[cursor];
      if (cur) {
        frame.push("  " + chalk.bold.white(cur.record.name) + (cur.record.dir ? dim("   " + shorten(cur.record.dir, cols - 30)) : ""));
        for (const l of contextFor(cur.record).slice(0, ctxHeight - 2)) frame.push(l);
      }

      // Footer (keys / confirm / flash)
      frame.push(dim("  " + "─".repeat(Math.min(cols - 4, 80))));
      if (confirm) {
        frame.push(
          "  " + chalk.yellow(`Remove "${confirm.record.name}" from PAI's list?`) +
          dim(" files stay on disk  ") + chalk.cyan("y") + dim("/") + chalk.cyan("N")
        );
      } else if (mode === "search") {
        frame.push("  " + dim("type to filter · ") + chalk.cyan("Enter") + dim(" done · ") + chalk.cyan("esc") + dim(" cancel"));
      } else {
        const parts: string[] = [];
        if (cur?.record.live) parts.push(chalk.cyan("g") + dim(" go to tab"));
        if (cur?.record.dir) parts.push(chalk.cyan("n") + dim(" new"));
        if (cur?.record.dir) parts.push(chalk.cyan("c") + dim(" cd"));
        if (cur?.record.dir) parts.push(chalk.cyan("f") + dim(" finder"));
        if (cur?.record.slug) parts.push(chalk.cyan("d") + dim(" remove"));
        parts.push(chalk.cyan("s") + dim(" search"));
        parts.push(chalk.cyan("↑↓") + dim(" move"));
        parts.push(chalk.cyan("q") + dim(" quit"));
        frame.push("  " + parts.join(dim("  ·  ")));
        if (flash) frame.push("  " + dim(flash));
      }

      // Paint: home, each line truncated to width (no wrapping) + cleared to
      // EOL, then clear everything below.
      const painted = frame.map((l) => truncVisible(l, cols)).join("\x1b[K\n");
      out.write("\x1b[H" + painted + "\x1b[K\x1b[J");
    };

    const move = (delta: number) => {
      if (filtered.length === 0) return;
      cursor = (cursor + delta + filtered.length) % filtered.length;
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      const cur = filtered[cursor];

      // Universal: Ctrl-C quits.
      if (s === "\x03") return finish(null);

      // Pending delete confirmation captures the next key.
      if (confirm) {
        const target = confirm;
        confirm = null;
        if (s === "y" || s === "Y") {
          const okRemoved = onRemove ? onRemove(target.record) : false;
          if (okRemoved) {
            pool = pool.filter((l) => l !== target);
            ctxCache.delete(target.record.dir ?? "");
            recompute();
            flash = `Removed "${target.record.name}" from PAI's list (files untouched).`;
          } else {
            flash = `Could not remove "${target.record.name}".`;
          }
        } else {
          flash = "";
        }
        return render();
      }

      // Arrows (work in both modes).
      if (s === "\x1b[A") { move(-1); return render(); }
      if (s === "\x1b[B") { move(1); return render(); }
      if (s === "\x1b[5~") { move(-5); return render(); }
      if (s === "\x1b[6~") { move(5); return render(); }

      if (mode === "search") {
        if (s === "\r" || s === "\n") { mode = "command"; return render(); }
        if (s === "\x1b") { mode = "command"; return render(); } // esc → back to command, keep filter
        if (s === "\x7f" || s === "\b") { query = query.slice(0, -1); recompute(); return render(); }
        // Printable → append to query.
        if (s.length === 1 && s >= " ") { query += s; cursor = 0; recompute(); return render(); }
        return; // ignore other escapes
      }

      // command mode
      if (s === "q" || s === "\x1b") return finish(null);
      if (s === "s" || s === "/") { flash = ""; mode = "search"; return render(); }
      if (s === "j") { move(1); return render(); }
      if (s === "k") { move(-1); return render(); }
      if (!cur) return;
      if (s === "g" && cur.record.live) return finish({ record: cur.record, action: "switch" });
      if (s === "n" && cur.record.dir) return finish({ record: cur.record, action: "new" });
      if (s === "c" && cur.record.dir) return finish({ record: cur.record, action: "cd" });
      // f → open in the file manager, but stay in the picker.
      if (s === "f" && cur.record.dir) { openInFileManager(cur.record.dir); return; }
      // d → ask to remove this row from PAI's list (only registered projects).
      if (s === "d") {
        if (cur.record.slug) { confirm = cur; flash = ""; }
        else flash = "Only registered projects can be removed from the list.";
        return render();
      }
      if (s === "\r" || s === "\n") {
        // Enter = smart default: live → go to tab, else → new session.
        if (cur.record.live) return finish({ record: cur.record, action: "switch" });
        if (cur.record.dir) return finish({ record: cur.record, action: "new" });
      }
    };

    stdin.on("data", onData);
    render();
  });
}

// ---------------------------------------------------------------------------
// Note discovery — recent markdown for the selector's detail panel.
// ---------------------------------------------------------------------------

interface NoteRef {
  rel: string;
  full: string;
  mtime: number;
}

function recentMarkdown(root: string, limit: number): NoteRef[] {
  const found: NoteRef[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || found.length >= 200) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || KW_SKIP.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.toLowerCase().endsWith(".md")) {
        found.push({ rel: full.slice(root.length + 1), full, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Main command (`pai` with no args, interactive)
// ---------------------------------------------------------------------------

export interface PickOpts {
  all?: boolean;
  dryRun?: boolean;
}

export async function cmdPick(db: Database, opts: PickOpts = {}): Promise<void> {
  const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY;

  // Fallback to the static listing when we're not on an interactive terminal
  // (e.g. piped output). The modal selector needs a real tty.
  if (!interactive) {
    const allSessions = scanSessions(db, { limit: 500, filter: "named" });
    const projects = getProjects(db, opts.all ?? false);
    let live: Awaited<ReturnType<typeof fetchLiveSessions>> = [];
    try {
      live = await fetchLiveSessions();
    } catch {
      /* AIBroker not running */
    }
    const deduped = buildDeduped(live, allSessions, projects, opts.all ?? false);
    renderDedupedSessions(deduped, opts.all ? undefined : 20);
    return;
  }

  // Build the feed (with live sessions merged in)
  const allSessions = scanSessions(db, { limit: 500, filter: "named" });
  const projects = getProjects(db, opts.all ?? false);
  let live: Awaited<ReturnType<typeof fetchLiveSessions>> = [];
  try {
    live = await fetchLiveSessions();
  } catch {
    /* AIBroker not running — disk + registry still populate the picker */
  }

  const allProjects = getProjects(db, true);
  const lines = buildFeedFrom(allSessions, projects, live, allProjects);
  if (lines.length === 0) {
    process.stderr.write(dim("  No projects or sessions found.\n"));
    return;
  }

  // 'd' removes a row from PAI's list: archive the project (reversible, FK-safe,
  // files stay on disk). Returns false if the row isn't a registered project.
  const onRemove = (rec: PickRecord): boolean => {
    if (!rec.slug) return false;
    try {
      const ts = now();
      const res = db
        .prepare(
          "UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE slug = ? AND status = 'active'"
        )
        .run(ts, ts, rec.slug);
      return res.changes > 0;
    } catch {
      return false;
    }
  };

  // Modal selector — navigate, then g/n/c act immediately on the highlighted row.
  const sel = await runSelector(lines, onRemove);
  if (!sel) return; // cancelled
  const { record, action } = sel;

  // switch → reveal the running iTerm tab (the screenshot mechanism).
  if (action === "switch") {
    if (record.live) {
      const r = revealItermSession(record.live);
      if (!r.ok) {
        process.stderr.write(chalk.yellow(`  Could not switch: ${r.error ?? "unknown error"}\n`));
      }
    }
    return;
  }

  if (!record.dir) {
    process.stderr.write(dim(`  No directory on record for "${record.name}".\n`));
    return;
  }

  // cd → hand the directory to the `pai()` shell wrapper via PAI_PICK_OUT; a
  // child process can't change the parent shell's cwd itself. Without the
  // wrapper, just print the path so the user can cd manually.
  if (action === "cd") {
    const sink = process.env.PAI_PICK_OUT;
    if (sink) {
      try {
        writeFileSync(sink, record.dir, "utf8");
        return;
      } catch {
        /* fall through to printing */
      }
    }
    printExitDir(record.dir);
    return;
  }

  // new → start a fresh session here, in the current terminal.
  launchInDir(record.dir, record.name, { forceFresh: true, dryRun: opts.dryRun });
}
