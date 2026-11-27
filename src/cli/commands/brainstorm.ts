/**
 * `pai brainstorm`: a round table of one moderator and N participants (cloud workers) on a shared
 * append-only board. Board mechanics live in src/brainstorm/*; this file declares names, flags, help.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { boardDir, brainstormRoot, exitCodeFor, loadIndex, post, readPosts, renderPost, waitPosts, type BoardIndex } from "../../brainstorm/board.js";
import { harvest, readMeta } from "../../brainstorm/harvest.js";
import { callerSession, startBrainstorm } from "../../brainstorm/start.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";

const out = (s: string) => process.stdout.write(s + "\n");
const idArg = [{ name: "ID", summary: "Brainstorm id (bs-...)", required: true }];

function board(id: unknown): BoardIndex {
  const sid = String(id ?? "");
  let idx: BoardIndex | null = null;
  try {
    idx = loadIndex(sid);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), "pai brainstorm ls");
  }
  if (!idx) throw new CliError(`no brainstorm board "${sid}"`, "pai brainstorm ls");
  return idx;
}

export const boardState = (idx: BoardIndex, now = Date.now()): "closed" | "deadline passed" | "open" =>
  idx.closed ? "closed" : idx.deadlineMs !== null && now >= idx.deadlineMs ? "deadline passed" : "open";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const startRun = async (ctx: RunContext): Promise<number> => {
  const goal = String(ctx.args.GOAL ?? "").trim();
  if (!goal) throw new CliError("brainstorm needs a goal", 'pai brainstorm "<goal>" --participants 3');
  const o = ctx.opts;
  const lenses = typeof o.lenses === "string" && o.lenses.trim() ? o.lenses.split(";").map((s) => s.trim()).filter(Boolean) : undefined;
  const context = typeof o.context === "string" && o.context.trim() ? o.context.split(",").map((s) => resolve(s.trim())).filter(Boolean) : [];
  let r;
  try {
    r = await startBrainstorm({
      goal,
      participants: o.participants === undefined ? undefined : Number(o.participants),
      lenses,
      maxMinutes: o["max-minutes"] === undefined ? undefined : Number(o["max-minutes"]),
      rounds: o.rounds === undefined ? undefined : Number(o.rounds),
      context,
      local: o.local === true,
      caller: callerSession(),
    });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  out(`brainstorm ${r.id}`);
  out(`board: ${join(r.dir, "board.md")}`);
  out(`watch: ${r.watch}`);
  if (!o.wait) return 0;
  for (;;) {
    const idx = loadIndex(r.id);
    if (idx?.closed) break;
    if (Date.now() > r.deadlineMs + 4 * 60000) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  const res = join(r.dir, "result.md");
  if (existsSync(res)) out(readFileSync(res, "utf8"));
  else out(`brainstorm ${r.id}: ended without a closing post; posts: pai brainstorm show ${r.id}`);
  return 0;
};

const postCmd: CommandDef = {
  name: "post",
  summary: "Post to a brainstorm board (the only way the board is written)",
  description:
    "Appends one numbered post. The text is the argument, or --file, or stdin when the text is -. The role is --as, else PAI_BRAINSTORM_ROLE, else anon. A moderator post starting with CLOSED closes the board and writes result.md. A closed board refuses posts (exit 1).",
  args: [...idArg, { name: "TEXT", summary: "The post text (or - for stdin)" }],
  options: [
    { name: "as", type: "string", value: "ROLE", summary: "Role to post as: moderator, p1..pN (default: $PAI_BRAINSTORM_ROLE, else anon)" },
    { name: "file", type: "string", value: "PATH", summary: "Read the text from this file" },
  ],
  examples: ['pai brainstorm post bs-20261127-120000-ab12 "I would start small" --as p1'],
  run: async (ctx) => {
    const id = String(ctx.args.ID);
    board(id);
    const role = String(ctx.opts.as || process.env.PAI_BRAINSTORM_ROLE || "anon");
    let text = ctx.args.TEXT === undefined ? "" : String(ctx.args.TEXT);
    if (ctx.opts.file) text = readFileSync(String(ctx.opts.file), "utf8");
    else if (text === "-") text = await readStdin();
    if (!text.trim()) throw new CliError("empty post", 'pai brainstorm post <id> "<text>" --as p1');
    let p;
    try {
      p = await post(id, role, text);
    } catch (e) {
      throw new CliError(e instanceof Error ? e.message : String(e), "pai brainstorm show " + id);
    }
    out(`posted #${p.n}`);
    if (role === "moderator" && loadIndex(id)?.closed) {
      try {
        const h = await harvest(id);
        out(`result: ${h.path}`);
      } catch (e) {
        process.stderr.write(`brainstorm: harvest failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    return 0;
  },
};

const waitCmd: CommandDef = {
  name: "wait",
  summary: "Block until the board has posts after --since, is closed, or the deadline passes",
  description:
    "Prints the new posts, then one line `-- board <id> last=<n> state=<new|deadline|closed>`. Exit 0 = new posts, 3 = deadline (nothing new), 4 = closed. Exit 3 and 4 are normal outcomes. An unknown board is exit 1.",
  args: idArg,
  options: [
    { name: "since", type: "number", value: "N", default: 0, summary: "Last post number you have seen" },
    { name: "max", type: "number", value: "SECONDS", summary: "Give up after this many seconds (default: until the board deadline)" },
  ],
  examples: ["pai brainstorm wait bs-20261127-120000-ab12 --since 3 --max 600"],
  run: async (ctx) => {
    const id = String(ctx.args.ID);
    board(id);
    const since = Number(ctx.opts.since ?? 0);
    const r = await waitPosts(id, since, ctx.opts.max === undefined ? undefined : Number(ctx.opts.max));
    for (const p of r.posts) out(renderPost(p));
    out(`-- board ${id} last=${r.last} state=${r.state}`);
    if (r.state === "closed") out("-- board closed: stop, post your final position only if you have not");
    return exitCodeFor(r.state);
  },
};

const watchCmd: CommandDef = {
  name: "watch",
  summary: "Live view of a board until it closes or the deadline passes",
  description: "Prints every post in time order, then each new one as it arrives. Exit 0 at close or deadline.",
  args: idArg,
  examples: ["pai brainstorm watch bs-20261127-120000-ab12"],
  run: async (ctx) => {
    const id = String(ctx.args.ID);
    const idx = board(id);
    out(`# ${id}: ${idx.goal}`);
    let last = 0;
    for (;;) {
      const r = await waitPosts(id, last);
      for (const p of r.posts) out(renderPost(p));
      last = r.last;
      if (r.state === "closed") return (out(`-- board ${id} closed`), 0);
      if (r.state === "deadline") return (out(`-- board ${id} deadline passed`), 0);
    }
  },
};

const showCmd: CommandDef = {
  name: "show",
  summary: "Goal, state, workers and every post of a board",
  description: "Prints the goal, the state (open, closed, deadline passed), the participants with their worker ids, and every post.",
  args: idArg,
  options: [{ name: "json", type: "boolean", default: false, summary: "Machine-readable JSON output" }],
  examples: ["pai brainstorm show bs-20261127-120000-ab12", "pai brainstorm show bs-20261127-120000-ab12 --json"],
  run: (ctx) => {
    const id = String(ctx.args.ID);
    const idx = board(id);
    const meta = readMeta(id);
    const posts = readPosts(id);
    const state = boardState(idx);
    const resultPath = join(boardDir(id), "result.md");
    if (ctx.opts.json) {
      out(JSON.stringify({ id, goal: idx.goal, state, deadlineMs: idx.deadlineMs, meta, posts, result: existsSync(resultPath) ? resultPath : null }, null, 2));
      return 0;
    }
    out(`${id}: ${idx.goal}`);
    out(`state: ${state}, ${idx.count} posts${idx.deadlineMs ? `, deadline ${new Date(idx.deadlineMs).toISOString()}` : ""}`);
    if (meta) {
      out(`participants: ${meta.participants}, rounds: ${meta.rounds}${meta.caller ? `, caller: ${meta.caller}` : ""}`);
      for (const [role, wid] of Object.entries(meta.workers ?? {})) out(`  ${role}: worker ${wid}`);
    }
    if (existsSync(resultPath)) out(`result: ${resultPath}`);
    out("");
    for (const p of posts) out(renderPost(p));
    return 0;
  },
};

const lsCmd: CommandDef = {
  name: "ls",
  summary: "List brainstorm boards, newest first",
  description: "One line per board: id, state, post count, goal.",
  examples: ["pai brainstorm ls"],
  run: () => {
    const root = brainstormRoot();
    if (!existsSync(root)) return (out("no brainstorm boards"), 0);
    const rows: { idx: BoardIndex }[] = [];
    for (const d of readdirSync(root)) {
      try {
        const idx = loadIndex(d);
        if (idx) rows.push({ idx });
      } catch {
        /* not a board */
      }
    }
    rows.sort((a, b) => b.idx.createdAt.localeCompare(a.idx.createdAt));
    if (!rows.length) out("no brainstorm boards");
    for (const { idx } of rows) out(`${idx.id}  ${boardState(idx).padEnd(15)} ${String(idx.count).padStart(3)}  ${idx.goal.slice(0, 80)}`);
    return 0;
  },
};

export const brainstormCommand: CommandDef = {
  name: "brainstorm",
  summary: "Round table: a moderator and N cloud participants discuss a goal on a shared board",
  description:
    'pai brainstorm "<goal>" starts one moderator and N participants (cloud workers, detached) and returns at once; they post, wait and reply on a shared append-only board until the moderator posts CLOSED or the deadline passes. The result lands in ~/.pai/brainstorm/<id>/result.md and as a message to the calling session. The board is written only through `pai brainstorm post`. Cloud only, unless --local.',
  args: [{ name: "GOAL", summary: "What the round table should think through" }],
  options: [
    { name: "participants", type: "number", value: "N", default: 3, summary: "Number of participants" },
    { name: "lenses", type: "string", value: "A;B;C", summary: "Semicolon-separated lenses, one per participant (cycled; default: six built-in lenses)" },
    { name: "max-minutes", type: "number", value: "M", default: 20, summary: "Time box in minutes (the moderator gets 3 more to close)" },
    { name: "rounds", type: "number", value: "R", default: 3, summary: "Moderated rounds" },
    { name: "context", type: "string", value: "FILES", summary: "Comma-separated files every participant should read" },
    { name: "local", type: "boolean", default: false, summary: "Run the workers on the local provider instead of the cloud" },
    { name: "wait", type: "boolean", default: false, summary: "Block until the board closes, then print result.md" },
  ],
  examples: ['pai brainstorm "should the router cache embeddings?" --participants 3 --max-minutes 15', "pai brainstorm watch bs-20261127-120000-ab12", "pai brainstorm ls"],
  subcommands: [postCmd, waitCmd, watchCmd, showCmd, lsCmd],
  run: startRun,
};


