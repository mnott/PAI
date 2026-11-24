/**
 * smoke-start.ts — the merge gate and `pai release` start ONE worker for real.
 *
 * The gate (tsc + tests + build + daemon restart + restart health) let a change
 * through that made every worker start crash ("Cannot access 'toolFold' before
 * initialization", 2026-11-19 03:33–03:58, merge 2d9a628d): no gate step ever
 * started a worker. This is that step: the freshly built CLI runs one headless
 * worker on a scripted offline model — a loopback provider whose upstream is a
 * stub server answering every Chat Completions call with "ok" (never a real
 * model, never the cloud) — prompt "reply ok", tools Read only. It must end rc 0
 * with a valid result; anything else fails the gate, which reverts the merge
 * like a failed test (`smoke start failed: <first error line>`).
 *
 * The provider rides a TEMP workers.yaml copy (PAI_WORKERS_YAML points the CLI
 * and its detached child at it); keys still resolve from the live file through
 * `~`, so the real config is never written and no home-git commit happens. Its
 * `router: false` keeps the run off the live router; the stub answers loopback
 * only. The smoke holds the test slot while it runs, like every other gate step.
 * Its start carries PAI_NO_WORKTREE_GC=1 so no at-start housekeeping (worktree
 * gc / salvage / archive) runs before the worker announces: the 30 s window
 * measures only the start (2026-11-19 14:31 merge gate false failure).
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOPBACK_HOST } from "../utils/loopback.js";
import { readWorkersSection } from "./config.js";
import { defaultWorkersYamlPath } from "./workers-config.js";
import { acquireTestSlot, holdsTestSlot } from "./test-slot.js";
import { spawnSession, startDetachedWorker } from "./reroute.js";
import { eventsPath, workersLogDir } from "./paths.js";
import { loadStatus, newWorkerId } from "./status.js";
import { parseLastResultEvent } from "./keepalive.js";

/** The provider the smoke run names; it exists only in the temp copy. */
export const SMOKE_PROVIDER_NAME = "merge-smoke";
const SMOKE_PROMPT = "Reply with exactly one word: ok";
const SMOKE_MODEL = "smoke-stub";
/** Hard cap on the detached start + its wait; the whole smoke stays under ~20 s. */
export const SMOKE_TIMEOUT_MS = 60_000;

/** Spawn seam of the smoke (tests inject a runner; no real CLI is started). */
export interface SmokeStartDeps {
  /** Runs the built CLI's `worker run …` and waits for its end; returns rc + the worker id. */
  start?: (opts: SmokeRunOpts) => Promise<{ rc: number; id: string }>;
  /** The offline stub model server: a loopback provider pointing here speaks OpenAI through the PAI proxy. */
  serve?: () => Promise<{ url: string; close: () => Promise<void> }>;
  /** Points the config at the smoke provider (tests inject; default edits a temp workers.yaml copy). */
  addProvider?: (url: string) => void;
  removeProvider?: () => void;
  /** The env the detached smoke child runs with (defaultStart); tests inspect it instead of spawning a CLI. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the process spawner the production start helper (startDetachedWorker) uses. */
  spawn?: typeof spawnSession;
}

export interface SmokeRunOpts {
  id: string;
  cwd: string;
  timeoutMs: number;
  /** Test seam: the env prep defaultStart would do (default process.env); the runner receives it in `env`. */
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSession;
}

export interface SmokeStartResult {
  ok: boolean;
  ms: number;
  /** On failure: the first error line, for `smoke start failed: <line>`. */
  error?: string;
  id?: string;
}

/** The OpenAI Chat Completions answer Claude Code reads as "ok". */
function stubCompletion(body: unknown): string {
  const model = (body as { model?: string })?.model ?? SMOKE_MODEL;
  return JSON.stringify({
    id: "chatcmpl-smoke",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** A loopback HTTP server answering /v1/chat/completions with the scripted reply. */
async function startStubServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        // the run gate's liveness probe of a named loopback provider
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: SMOKE_MODEL, object: "model" }] }));
        return;
      }
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(stubCompletion(Buffer.concat(chunks).toString("utf8")));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, LOOPBACK_HOST, () => {
      const a = srv.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  return {
    url: `http://${LOOPBACK_HOST}:${port}/v1`,
    close: async () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      }),
  };
}

/** The smoke provider's workers.yaml block (on-disk snake_case shape; parseProvider validates it). */
function smokeProviderYaml(url: string): string {
  return [
    `  ${SMOKE_PROVIDER_NAME}:`,
    `    enabled: true`,
    `    protocol: "openai"`,
    `    url: ${JSON.stringify(url)}`, // loopback: the local-only window must not read the smoke as a cloud start
    `    key_file: null`,
    `    upstream_url: ${JSON.stringify(url)}`,
    `    router: false`,
    `    max_concurrent: 1`,
    `    models:`,
    `      default: ${JSON.stringify(SMOKE_MODEL)}`,
    `    note: "merge-gate smoke start: scripted offline stub model, exists only in a temp workers.yaml copy"`,
  ].join("\n");
}

/** The live provider ops: a temp copy of workers.yaml carrying the smoke entry. */
class TempCopyProviderOps {
  private dir: string | null = null;
  add(url: string): void {
    this.dir = mkdtempSync(join(tmpdir(), "pai-smoke-"));
    const copy = join(this.dir, "workers.yaml");
    try {
      copyFileSync(defaultWorkersYamlPath(), copy);
    } catch {
      writeFileSync(copy, "", "utf8"); // no live file yet: the shipped defaults stand under an empty copy
    }
    const text = readFileSync(copy, "utf8");
    writeFileSync(copy, insertProviderBlock(text, smokeProviderYaml(url)), "utf8");
    process.env.PAI_WORKERS_YAML = copy;
  }
  remove(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    delete process.env.PAI_WORKERS_YAML;
  }
}

/** Insert the smoke provider under an existing `providers:` block, keeping its indent. */
function insertProviderBlock(text: string, block: string): string {
  const m = /^providers:\n/m.exec(text);
  if (!m) return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}providers:\n${block}\n`;
  const after = text.slice(m.index + m[0].length);
  const first = /^[ ]*/.exec(after)?.[0] ?? "  ";
  const indent = first.length >= 2 ? first : "  ";
  const reindented = block
    .split("\n")
    .map((l) => (l.startsWith("  ") ? indent + l.slice(2) : l))
    .join("\n");
  return `${text.slice(0, m.index + m[0].length)}${reindented}\n${after}`;
}

/**
 * One real worker start on the built code. `opts.cwd` is the repo whose CLI
 * just got rebuilt (the smoke runs through it); ok only when the run ended rc 0
 * with a non-error result event. Never throws: every failure shape (start
 * crash, bad result, timeout) reads as { ok: false, error }.
 */
export async function smokeStart(opts: { cwd: string; timeoutMs?: number }, deps: SmokeStartDeps = {}): Promise<SmokeStartResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const serve = deps.serve ?? startStubServer;
  // an injected runner still runs through the real env prep (deps.env), so a test can prove the smoke start
  // carries PAI_NO_WORKTREE_GC=1 without spawning a CLI
  const start = deps.start ?? defaultStart;
  // the env prep defaultStart does before spawning: drop the worker identity and terminal keys, add the smoke's own
  const childEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...base };
    // the smoke must not inherit a worker identity or an orchestrator mode
    delete env.PAI_WORKER;
    delete env.PAI_WORKER_ID;
    delete env.PAI_WORKER_ORCHESTRATOR;
    // infrastructure like the keepalive beat: no spawning session, no terminal identity, so supervision has no owner to notify
    for (const k of ["CLAUDE_CODE_SESSION_ID", "ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE"]) delete env[k];
    // the smoke is harness infrastructure, not a session's task: origin "harness" keeps it out of L0 notices,
    // the digest and `pai worker pending` even if a session map or a reroute would otherwise claim it
    env.PAI_HARNESS_RUN = "1";
    // the smoke's 30 s start window measures only the start: the at-start worktree gc (salvage/archive of finished
    // workers' trees) is skipped for this run — a big pass blew the window and read as "worker did not start"
    // (merge 2026-11-19 14:31). The daemon's hourly gc owns the archiving; the normal start path is unchanged.
    env.PAI_NO_WORKTREE_GC = "1";
    return env;
  };
  const runOpts = (o: SmokeRunOpts): SmokeRunOpts => ({ ...o, env: childEnv(deps.env ?? process.env), ...(deps.spawn ? { spawn: deps.spawn } : {}) });
  // the worker's own test runs must not fight the gate's slot; held here while the smoke runs
  const lease = holdsTestSlot() ? null : await acquireTestSlot();
  let runId: string | null = null;
  let stub: { url: string; close: () => Promise<void> } | null = null;
  const ops = deps.addProvider || deps.removeProvider ? null : new TempCopyProviderOps();
  try {
    stub = await serve();
    if (ops) ops.add(stub.url);
    else deps.addProvider?.(stub.url);
    const id = newWorkerId();
    const r = await start(runOpts({ id, cwd: opts.cwd, timeoutMs }));
    runId = r.id;
    if (r.rc !== 0) return { ok: false, ms: Date.now() - t0, error: `worker run exited ${r.rc}`, id: r.id };
    const ev = parseLastResultEvent(eventsPath(workersLogDir(readWorkersSection().workers), r.id));
    if (!ev || typeof ev.result !== "string" || !ev.result.trim()) return { ok: false, ms: Date.now() - t0, error: "no result event from the smoke worker", id: r.id };
    if (ev.is_error) return { ok: false, ms: Date.now() - t0, error: `worker result is an error: ${ev.result.trim().split("\n")[0].slice(0, 200)}`, id: r.id };
    return { ok: true, ms: Date.now() - t0, id: r.id };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300) };
  } finally {
    try {
      if (ops) ops.remove();
      else deps.removeProvider?.();
    } catch {
      /* the temp copy goes with its dir; nothing else to undo */
    }
    try {
      await stub?.close();
    } catch {
      /* best effort */
    }
    if (runId) forgetRun(runId);
    lease?.release();
  }
}

/** The smoke's run files go once the verdict is read: it is not a session's worker, so it leaves no stats, notice or history. */
function forgetRun(id: string): void {
  const logDir = workersLogDir(readWorkersSection().workers);
  for (const ext of ["status", "jsonl", "prompt", "log", "out"]) rmSync(join(logDir, `${id}.${ext}`), { force: true });
}

/** The live start: the built CLI detaches one worker on the smoke provider and this waits for its end. */
async function defaultStart(o: SmokeRunOpts): Promise<{ rc: number; id: string }> {
  const logDir = workersLogDir(readWorkersSection().workers);
  // smokeStart's childEnv already dropped the worker identity and terminal keys and set PAI_NO_WORKTREE_GC=1
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), PAI_BIN: join(o.cwd, "dist", "cli", "index.mjs") };
  const announced = await startDetachedWorker(
    logDir,
    [
      "run",
      "--provider",
      SMOKE_PROVIDER_NAME,
      "--no-worktree",
      "--max-minutes",
      "1",
      "--label",
      "merge gate smoke start",
      "-p",
      SMOKE_PROMPT,
      "--allowedTools",
      "Read",
    ],
    { cwd: logDir, env, timeoutMs: Math.min(30_000, o.timeoutMs), ...(o.spawn ? { start: o.spawn } : {}) }
  );
  // the id file holds the run's status JSON ({id,state}); older builds wrote the bare id
  let id = announced;
  try {
    id = (JSON.parse(announced) as { id?: string }).id ?? announced;
  } catch {
    /* bare id */
  }
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const st = loadStatus(logDir, id);
    if (st && (st.state === "done" || st.state === "failed" || st.state === "killed" || st.state === "lost")) {
      return { rc: st.rc ?? 1, id };
    }
    if (Date.now() > deadline) return { rc: 124, id };
    await new Promise((r) => setTimeout(r, 500));
  }
}
