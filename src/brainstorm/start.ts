/**
 * start.ts — start a brainstorm: one board, one moderator and N participants, all detached cloud
 * workers started by this one call. The prompts carry the whole protocol; the spawn is injectable.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir, brainstormRoot, createBoard, post } from "./board.js";
import type { BrainstormMeta } from "./harvest.js";

export const DEFAULT_LENSES = [
  "pragmatist: the simplest thing that works",
  "risk and failure modes: what breaks, what is irreversible",
  "user and operator experience: who touches this and how it feels",
  "long-term maintainability: what this costs us in a year",
  "cost and effort: time, money and attention against the payoff",
  "contrarian: devil's advocate, attack the consensus",
];

export type SpawnFn = (argv: string[]) => Promise<{ id: string; state?: string }>;

export interface StartOpts {
  goal: string;
  participants?: number;
  lenses?: string[];
  maxMinutes?: number;
  rounds?: number;
  context?: string[];
  local?: boolean;
  caller?: string;
}

export type KillFn = (workerId: string) => Promise<void>;

export interface StartDeps {
  spawn?: SpawnFn;
  kill?: KillFn;
  root?: string;
  now?: Date;
}

export interface StartResult {
  id: string;
  dir: string;
  deadlineMs: number;
  workers: Record<string, string>;
  watch: string;
}

export const callerSession = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.PAI_SESSION_NAME || env.AIBROKER_SESSION_NAME || env.AIBROKER_SESSION || undefined;

const pad = (n: number) => String(n).padStart(2, "0");

export function newBoardId(now = new Date()): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `bs-${d}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
}

export const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const contextBlock = (context: string[]): string =>
  context.length ? `Context files (read them with Read; do not expect their contents here):\n${context.map((c) => `- ${c}`).join("\n")}\n` : "";

export interface ParticipantPromptOpts {
  id: string;
  role: string;
  lens: string;
  goal: string;
  context: string[];
  deadlineMs: number;
}

export function buildParticipantPrompt(o: ParticipantPromptOpts): string {
  const at = clock(o.deadlineMs);
  return `You are participant ${o.role} in a brainstorm round table (board ${o.id}). A moderator and other participants discuss on a shared append-only board; you are one voice.

GOAL: ${o.goal}

YOUR LENS: ${o.lens}
Argue from this lens, but say what you really think; disagree openly when you do.

${contextBlock(o.context)}
DEADLINE: ${at} local time (today). When that time has passed, stop.

HOW YOU TALK. The board is written ONLY with \`pai brainstorm post\`. Each Bash call is a single \`pai brainstorm ...\` command with the text in double quotes (no heredocs, no redirects, no files, never Edit/Write). Posts are short: at most 150 words.

1. Post your opening position:
   pai brainstorm post ${o.id} "<your opening position, <=150 words>" --as ${o.role}
   It prints "posted #<n>".
2. LOOP (until the moderator closes or the deadline passes):
   a. pai brainstorm wait ${o.id} --since <last> --max 600
      This is a BLOCKING call: never sleep, never poll, never ls. Start with --since 0. The output lists the new posts; its last line "-- board ${o.id} last=<n> state=..." gives the number to use as <last> next time.
   b. Read the new posts. Reply with
      pai brainstorm post ${o.id} "<reply>" --as ${o.role}
      React to specific posts by number (e.g. "re #4"), bring new arguments only, <=150 words. Do not repeat yourself; when you have nothing new, do not post.
   c. Repeat from a.
   Exit code 3 means nothing new yet: call wait again at once with the same --since. Exit code 4 or "state=closed" means the moderator closed the board: stop (a closed board refuses posts).
3. When the moderator asks for final positions, post once:
   pai brainstorm post ${o.id} "FINAL: <your position in one sentence and your top recommendation>" --as ${o.role}

You must NEVER end your turn before the moderator's CLOSED or the deadline (${at}): "nothing new" is not finished. Only the moderator's CLOSED or the deadline ends this job. After CLOSED or the deadline, stop with one line saying so.
`;
}

export interface ModeratorPromptOpts {
  id: string;
  goal: string;
  participants: number;
  lenses: string[];
  rounds: number;
  context: string[];
  deadlineMs: number;
  maxMinutes: number;
}

export function buildModeratorPrompt(o: ModeratorPromptOpts): string {
  const at = clock(o.deadlineMs);
  const closeBy = clock(o.deadlineMs - 2 * 60000);
  const roles = Array.from({ length: o.participants }, (_, i) => `p${i + 1}`);
  const roundMin = Math.max(1, Math.floor((o.maxMinutes * 0.7) / o.rounds));
  return `You are the moderator of a brainstorm round table (board ${o.id}) with ${o.participants} participants (${roles.join(", ")}), who are started alongside you and discuss on a shared append-only board. Your role name is moderator.

GOAL: ${o.goal}

LENSES:
${o.lenses.map((l, i) => `- ${roles[i]}: ${l}`).join("\n")}

${contextBlock(o.context)}
TIME: participants' deadline is ${at} local time (today). You must post CLOSED by ${closeBy} (deadline minus 2 minutes) even when some participants are silent. Plan about ${roundMin} minutes per round.

HOW YOU TALK. The board is written ONLY with \`pai brainstorm post <id> "<text>" --as moderator\`; each Bash call is a single \`pai brainstorm ...\` command with the text in double quotes (no heredocs, no redirects, never Edit/Write; you cannot write files). Reading: \`pai brainstorm wait ${o.id} --since <last> --max 120\` is a BLOCKING call; never sleep, never poll, never ls. Its last line "-- board ${o.id} last=<n> state=..." gives <last>. Exit code 3 = nothing new yet: call it again with the same --since.

PROCEDURE
1. Post #1, the framing: the goal in your words, what a good outcome looks like, and each participant's lens:
   pai brainstorm post ${o.id} "<framing and lenses>" --as moderator
2. Run ${o.rounds} round(s). For round k = 1..${o.rounds}:
   a. Post "ROUND k: <the question or tension to address>" --as moderator and remember its number.
   b. Wait (--since the last number you saw, --max 120, repeated) until ALL ${o.participants} participants have posted since the round's post (count distinct roles among p1..p${o.participants}). Move on at the latest when 3/4 of the round time has passed.
   c. Post a short summary of the tensions and what is still open.
3. Before the last round, in that round's post, ask for final positions: each participant posts "FINAL: <one sentence position and top recommendation>". Wait until all ${o.participants} posted FINAL or your time share is used up (never past ${closeBy}).
4. Post ONE closing post, passed as the quoted argument:
   pai brainstorm post ${o.id} "CLOSED
   ## Now
   1. <recommendation> -- first step: <...> -- owner: <...> -- risks: <...>
   ## Next
   1. ...
   ## Park
   1. ...
   ## Disagreements
   <who held what, why unresolved>
   ## Participants' positions
   - p1: <one line from their FINAL>
   ..." --as moderator
   The text starts with CLOSED on its first line; then exactly the sections Now / Next / Park (each a numbered list; every item has the recommendation, "first step:", "owner:", "risks:"), Disagreements, Participants' positions (one line per participant, from their FINAL posts). Posting CLOSED closes the board and writes the result.

You must close before ${closeBy}, and you must NEVER end your turn before CLOSED has been posted (a post that prints "posted #<n>" after CLOSED, or an error that the board is closed, means you are done). Then stop with one line.
`;
}

export function resolveLenses(participants: number, lenses?: string[]): string[] {
  const src = lenses && lenses.length ? lenses : DEFAULT_LENSES;
  return Array.from({ length: participants }, (_, i) => src[i % src.length]);
}

export const defaultSpawn: SpawnFn = (argv) =>
  new Promise((resolve, reject) => {
    execFile(process.env.PAI_BIN || "pai", argv, { timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`pai ${argv.slice(0, 3).join(" ")} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      const line = stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      try {
        const j = JSON.parse(line ?? "") as { id?: string; state?: string };
        if (!j.id) throw new Error("no id");
        resolve({ id: j.id, state: j.state });
      } catch {
        reject(new Error(`pai worker run printed no {id,state}: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });

export const defaultKill: KillFn = (workerId) =>
  new Promise((resolve) => {
    execFile(process.env.PAI_BIN || "pai", ["worker", "kill", workerId, "--reason", "brainstorm start failed"], { timeout: 60000 }, () => resolve());
  });

export function workerArgv(role: string, id: string, specFile: string, minutes: number, local: boolean): string[] {
  return [
    "worker", "run", "--detach", "--class", "research", "--where", local ? "local" : "cloud",
    "--deliverable", "findings", "--max-minutes", String(minutes),
    "--label", `brainstorm ${id} ${role}`, "--allowedTools", "Bash,Read,Grep,Glob", "--spec", specFile,
  ];
}

export async function startBrainstorm(o: StartOpts, deps: StartDeps = {}): Promise<StartResult> {
  const root = deps.root ?? brainstormRoot();
  const now = deps.now ?? new Date();
  const n = o.participants ?? 3;
  const minutes = o.maxMinutes ?? 20;
  const rounds = o.rounds ?? 3;
  if (!o.goal.trim()) throw new Error("brainstorm needs a goal");
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error("--participants must be 1..12");
  if (!(minutes > 0)) throw new Error("--max-minutes must be positive");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be >= 1");
  const spawn = deps.spawn ?? defaultSpawn;
  const id = newBoardId(now);
  const deadlineMs = now.getTime() + minutes * 60000;
  const lenses = resolveLenses(n, o.lenses);
  const context = o.context ?? [];
  createBoard(id, o.goal, deadlineMs, root);
  const dir = boardDir(id, root);
  const promptDir = join(dir, "prompts");
  mkdirSync(promptDir, { recursive: true });
  const meta: BrainstormMeta = {
    id, goal: o.goal, participants: n, lenses, rounds, caller: o.caller,
    workers: {}, startedAt: now.toISOString(), maxMinutes: minutes, context,
  };
  const writeMeta = () => writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeMeta();

  const jobs: { role: string; file: string; minutes: number }[] = [];
  const modFile = join(promptDir, "moderator.txt");
  writeFileSync(modFile, buildModeratorPrompt({ id, goal: o.goal, participants: n, lenses, rounds, context, deadlineMs, maxMinutes: minutes }));
  jobs.push({ role: "moderator", file: modFile, minutes: minutes + 3 });
  for (let i = 0; i < n; i++) {
    const role = `p${i + 1}`;
    const file = join(promptDir, `${role}.txt`);
    writeFileSync(file, buildParticipantPrompt({ id, role, lens: lenses[i], goal: o.goal, context, deadlineMs }));
    jobs.push({ role, file, minutes });
  }
  const settled = await Promise.allSettled(jobs.map((j) => spawn(workerArgv(j.role, id, j.file, j.minutes, !!o.local))));
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") meta.workers![jobs[i].role] = r.value.id;
    else failed.push(`${jobs[i].role}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  if (failed.length) {
    const started = { ...meta.workers };
    const ids = Object.values(started);
    const kill = deps.kill ?? defaultKill;
    await Promise.allSettled(ids.map((w) => kill(w)));
    await post(id, "moderator", "CLOSED start failed", root).catch(() => undefined);
    meta.workers = {};
    writeMeta();
    throw new Error(`brainstorm ${id}: ${failed.length} worker(s) did not start (${failed.join("; ")}); started: ${JSON.stringify(started)}; ${ids.length} started worker(s) stopped`);
  }
  writeMeta();
  return { id, dir, deadlineMs, workers: meta.workers!, watch: `pai brainstorm watch ${id}` };
}
