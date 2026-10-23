/**
 * session-detail.ts — one session's drill-down for the cockpit: turns, files
 * changed, skills, MCP calls and hook denials, read from the Claude Code
 * transcript (<projects dir>/<encoded cwd>/<session id>.jsonl) by streaming it
 * line by line. Prompt text is secret-masked.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { claudeProjectsDir } from "../config/pai-home.js";
import { extractUserPromptText, isRealUserPrompt, type AssistantLine } from "../audit/session-usage.js";
import { maskSecrets } from "../hooks/ts/lib/loop-guard.js";
import { parseDenialText } from "../workers/denials.js";
import { cockpitLayout } from "./cockpit-layout.js";

/** Session ids the endpoint accepts: no path separators, no dots. */
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PROMPT_CHARS = 300;

export interface SessionTurn {
  idx: number;
  ts: string;
  prompt: string;
  tools: { name: string; count: number }[];
  edits: string[];
  commands: number;
}

export interface SessionDetail {
  id: string;
  cwd: string;
  models: string[];
  /** the last `sessionDetailTurns` turns; `turnCount` is the true total */
  turns: SessionTurn[];
  turnCount: number;
  filesChanged: { path: string; edits: number; approxLinesChanged: number }[];
  skills: { name: string; ts: string }[];
  mcp: { server: string; calls: number; failures: number }[];
  denials: { ts: string; tool: string; reason: string }[];
}

/** The transcript file of a session id, or null. */
export function findTranscript(id: string, projectsDir: string = claudeProjectsDir()): string | null {
  if (!SESSION_ID_RE.test(id) || !existsSync(projectsDir)) return null;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = join(projectsDir, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
type Line = AssistantLine & { cwd?: string };

const lineCount = (s: unknown): number => (typeof s === "string" && s ? s.split("\n").length : 0);

/** Text of a tool_result's content: a string or the text blocks joined. */
function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && typeof (b as Block).text === "string" ? (b as Block).text : "")).join("\n");
  return "";
}

/** Lines written by one Edit / Write / MultiEdit input. */
function changedLines(name: string, input: Record<string, unknown>): number {
  if (name === "Write") return lineCount(input.content);
  if (name === "Edit") return lineCount(input.new_string);
  if (name === "MultiEdit" && Array.isArray(input.edits)) return input.edits.reduce((a: number, e: { new_string?: unknown }) => a + lineCount(e?.new_string), 0);
  return 0;
}

/**
 * Prompt text as the user typed it: a slash command encoded as
 * `<command-message>/<command-name>/<command-args>` tags renders as
 * `/Name args` (the original text when the tags are absent or malformed);
 * `<system-reminder>` and `<local-command-stdout>` blocks are stripped.
 */
function cleanPromptText(text: string): string {
  const cmd = text.match(/<command-message>[^<]*<\/command-message>\s*<command-name>\/([^<\s]+)<\/command-name>(?:\s*<command-args>([^<]*)<\/command-args>)?/);
  if (cmd) return `/${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ""}`;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .trim();
}

/** Skill name a user line announces ("/name" command tag or "Launching skill: name"), or null. */
function loadedSkill(text: string): string | null {
  const cmd = text.match(/<command-name>\/([^<\s]+)<\/command-name>/);
  if (cmd) return cmd[1];
  const l = text.match(/^Launching skill: (\S+)/);
  return l ? l[1] : null;
}

/** Streams the session's transcript into a SessionDetail; null when the id has no transcript. */
export async function sessionDetail(
  id: string,
  opts: { projectsDir?: string; maxTurns?: number } = {}
): Promise<SessionDetail | null> {
  const file = findTranscript(id, opts.projectsDir);
  if (!file) return null;
  const maxTurns = Math.max(1, opts.maxTurns ?? cockpitLayout().sessionDetailTurns);
  const out: SessionDetail = { id, cwd: "", models: [], turns: [], turnCount: 0, filesChanged: [], skills: [], mcp: [], denials: [] };
  const models = new Set<string>();
  const files = new Map<string, { edits: number; approxLinesChanged: number }>();
  const mcp = new Map<string, { calls: number; failures: number }>();
  const toolOf = new Map<string, string>(); // tool_use id -> tool name
  const mcpOf = new Map<string, string>(); // tool_use id -> mcp server
  let cur: { turn: SessionTurn; tools: Map<string, number>; edits: Set<string> } | null = null;
  const close = () => {
    if (!cur) return;
    cur.turn.tools = [...cur.tools].map(([name, count]) => ({ name, count }));
    cur.turn.edits = [...cur.edits];
    out.turns.push(cur.turn);
    if (out.turns.length > maxTurns) out.turns.shift();
    cur = null;
  };

  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    let obj: Line;
    try {
      obj = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const ts = obj.timestamp ?? "";
    if (!out.cwd && typeof obj.cwd === "string") out.cwd = obj.cwd;
    const content = obj.message?.content as string | Block[] | undefined;
    if (obj.type === "user") {
      if (isRealUserPrompt(obj)) {
        close();
        const text = cleanPromptText(extractUserPromptText(obj));
        const skill = loadedSkill(text);
        if (skill) out.skills.push({ name: skill, ts });
        cur = { turn: { idx: out.turnCount++, ts, prompt: maskSecrets(text).slice(0, PROMPT_CHARS), tools: [], edits: [], commands: 0 }, tools: new Map(), edits: new Set() };
        continue;
      }
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string" && obj.isMeta) {
          const skill = loadedSkill(b.text);
          if (skill) out.skills.push({ name: skill, ts });
        }
        if (b.type !== "tool_result") continue;
        const text = resultText(b.content);
        const server = b.tool_use_id ? mcpOf.get(b.tool_use_id) : undefined;
        if (server && b.is_error) mcp.get(server)!.failures++;
        const d = parseDenialText(text, (b.tool_use_id && toolOf.get(b.tool_use_id)) || "?");
        if (d) out.denials.push({ ts, tool: d.tool, reason: maskSecrets(d.reason).slice(0, 200) });
      }
      continue;
    }
    if (obj.type !== "assistant") continue;
    if (obj.message?.model) models.add(obj.message.model);
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== "tool_use" || !b.name) continue;
      const input = b.input ?? {};
      if (b.id) toolOf.set(b.id, b.name);
      if (cur) cur.tools.set(b.name, (cur.tools.get(b.name) ?? 0) + 1);
      if (b.name === "Bash" && cur) cur.turn.commands++;
      if (b.name === "Skill" && typeof input.skill === "string") out.skills.push({ name: input.skill, ts });
      if (b.name.startsWith("mcp__")) {
        const server = b.name.split("__")[1];
        if (server) {
          const m = mcp.get(server) ?? { calls: 0, failures: 0 };
          m.calls++;
          mcp.set(server, m);
          if (b.id) mcpOf.set(b.id, server);
        }
      }
      if ((b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit") && typeof input.file_path === "string") {
        const f = files.get(input.file_path) ?? { edits: 0, approxLinesChanged: 0 };
        f.edits++;
        f.approxLinesChanged += changedLines(b.name, input);
        files.set(input.file_path, f);
        cur?.edits.add(input.file_path);
      }
    }
  }
  close();
  out.models = [...models];
  out.filesChanged = [...files].map(([path, f]) => ({ path, ...f })).sort((a, b) => b.approxLinesChanged - a.approxLinesChanged);
  out.mcp = [...mcp].map(([server, m]) => ({ server, ...m })).sort((a, b) => b.calls - a.calls);
  return out;
}

export interface SessionHit {
  id: string;
  cwd: string;
  /** turn index as in SessionDetail.turns[].idx */
  turn: number;
  ts: string;
  snippet: string;
  mtime: number;
}

const SNIPPET_CHARS = 160;
/** Most sessions one search returns. */
export const SESSION_SEARCH_MAX = 50;

/** Real user prompts on the lines before `lineNo` (1-based): the turn index of the prompt on that line, as sessionDetail numbers turns. */
async function promptsBefore(file: string, lineNo: number): Promise<number> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  let at = 0;
  for await (const raw of rl) {
    if (++at >= lineNo) break;
    if (!raw.includes('"type":"user"')) continue;
    try {
      const obj = JSON.parse(raw) as Line;
      if (obj.type === "user" && isRealUserPrompt(obj)) n++;
    } catch {
      /* skipped like sessionDetail does */
    }
  }
  rl.close();
  return n;
}

export interface SessionSearch {
  hits: SessionHit[];
  /** true when the time budget (or the caller) stopped the scan before every transcript was read */
  partial: boolean;
}

/**
 * Sessions whose user prompts contain `q` (case-insensitive), newest transcript first, at most `limit`:
 * one hit per session (its first matching prompt) with the turn index the detail endpoint uses and a masked snippet.
 * The scan stops after `budgetMs` (the transcripts can add up to many GB) and reports `partial`.
 */
export async function searchSessions(
  q: string,
  opts: { projectsDir?: string; limit?: number; budgetMs?: number; cancelled?: () => boolean } = {}
): Promise<SessionSearch> {
  const projectsDir = opts.projectsDir ?? claudeProjectsDir();
  const needle = q.trim().toLowerCase();
  const limit = Math.max(1, opts.limit ?? 50);
  if (!needle || !existsSync(projectsDir)) return { hits: [], partial: false };
  // a plain needle must appear verbatim in the raw line of a matching prompt: skip JSON.parse for lines without it
  const plain = /^[\x20-\x7e]+$/.test(needle) && !/["\\]/.test(needle) ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  const deadline = Date.now() + (opts.budgetMs ?? 8000);
  let partial = false;
  const files: { id: string; file: string; mtime: number }[] = [];
  for (const d of readdirSync(projectsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(join(projectsDir, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl") || !SESSION_ID_RE.test(n.slice(0, -6))) continue;
      const file = join(projectsDir, d, n);
      try {
        files.push({ id: n.slice(0, -6), file, mtime: statSync(file).mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const hits: SessionHit[] = [];
  for (const f of files) {
    if (hits.length >= limit) break;
    if (Date.now() > deadline || opts.cancelled?.()) {
      partial = true;
      break;
    }
    const rl = createInterface({ input: createReadStream(f.file, { encoding: "utf8" }), crlfDelay: Infinity });
    let cwd = "";
    let lineNo = 0;
    for await (const raw of rl) {
      lineNo++;
      if (!raw) continue;
      const user = raw.includes('"type":"user"');
      if (!cwd && !user) {
        const c = raw.match(/"cwd":"([^"\\]*)"/);
        if (c) cwd = c[1]!;
      }
      if (!user || (plain && !plain.test(raw) && !raw.includes("<command-name>"))) continue;
      let obj: Line;
      try {
        obj = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (!cwd && typeof obj.cwd === "string") cwd = obj.cwd;
      if (obj.type !== "user" || !isRealUserPrompt(obj)) continue;
      const text = maskSecrets(cleanPromptText(extractUserPromptText(obj)));
      const at = text.toLowerCase().indexOf(needle);
      if (at >= 0) {
        const from = Math.max(0, at - 40);
        const turn = await promptsBefore(f.file, lineNo);
        hits.push({ id: f.id, cwd, turn, ts: obj.timestamp ?? "", snippet: text.slice(from, from + SNIPPET_CHARS), mtime: f.mtime });
        rl.close();
        break;
      }
    }
  }
  return { hits, partial };
}
