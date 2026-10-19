/**
 * session_profile_get / session_profile_set — the MCP side of the per-session
 * model profile (src/workers/session-profile.ts). The store and the resolver
 * live there; this module only reads and changes them and says, in one line,
 * what a worker spawn would do now. Workers changes apply to the next spawn
 * at once (every spawn path reads the profile when it spawns); a chat change
 * applies on the session's next start unless apply_now sends `/model <m>`
 * into the session's own terminal through AIBroker.
 */

import {
  getProfile,
  liveResolveCtx,
  profilesPath,
  resolveWorkers,
  updateProfile,
  type ProfilePatch,
  type ProfileTarget,
  type ResolveCtx,
  type SessionProfile,
} from "../../workers/session-profile.js";

import { detectSessionName } from "../../workers/session-name.js";
export type { WorkerToolResult } from "./worker-model.js";
import type { WorkerToolResult } from "./worker-model.js";

export interface SessionProfileDeps {
  path: string;
  env: NodeJS.ProcessEnv;
  ctx(): Promise<ResolveCtx>;
  /** Type text into a live session's terminal (AIBroker); undefined when unavailable. */
  send?(session: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

export async function realSessionProfileDeps(): Promise<SessionProfileDeps> {
  const { sendToSession } = await import("../../cli/lib/aibroker-client.js");
  return { path: profilesPath(), env: process.env, ctx: () => liveResolveCtx(process.env), send: (s, t) => sendToSession(s, t) };
}

export interface SessionProfileArgs {
  /** Session name; default: this session. */
  name?: string;
  chat?: ProfileTarget | null;
  workers?: ProfileTarget | null;
  fallback?: ProfileTarget[] | null;
  /** Skip fallback targets with a concurrency cap below this in batch spawns; 0 clears. */
  parallel_min?: number | null;
  /** With a chat change: send `/model <m>` into the running session now. */
  apply_now?: boolean;
}

const text = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }], isError: true });

const tgt = (t: ProfileTarget | undefined): string => (t ? `${t.provider}${t.model ? ` ${t.model}` : ""}` : "not set");

/** The profile and what a spawn resolves to now, in plain lines. */
export async function describeProfile(name: string, profile: SessionProfile | null, deps: SessionProfileDeps): Promise<string> {
  const p = profile ?? {};
  const ctx = { ...(await deps.ctx()), profile };
  const single = resolveWorkers({}, ctx);
  const batch = resolveWorkers({ batch: true }, ctx);
  const lines = [
    `session "${name}"`,
    `chat: ${tgt(p.chat)}`,
    `workers: ${tgt(p.workers)}`,
    `fallback: ${p.fallback?.length ? p.fallback.map(tgt).join(", ") : "none (global order)"}`,
    `parallel_min: ${p.parallel_min ?? "not set"}`,
    `next worker spawn: ${single.description}`,
  ];
  if (p.parallel_min && batch.description !== single.description) lines.push(`next batch spawn: ${batch.description}`);
  return lines.join("\n");
}

async function nameOf(args: SessionProfileArgs, deps: SessionProfileDeps): Promise<string | undefined> {
  return args.name?.trim() || (await detectSessionName(deps.env));
}

export async function sessionProfileGet(args: Pick<SessionProfileArgs, "name">, deps: SessionProfileDeps): Promise<WorkerToolResult> {
  try {
    const name = await nameOf(args, deps);
    if (!name) return fail("this session has no name; pass name (the session's persistent name)");
    return text(await describeProfile(name, getProfile(name, deps.path), deps));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function sessionProfileSet(args: SessionProfileArgs, deps: SessionProfileDeps): Promise<WorkerToolResult> {
  try {
    const name = await nameOf(args, deps);
    if (!name) return fail("this session has no name; pass name (the session's persistent name)");
    const patch: ProfilePatch = {};
    if ("chat" in args) patch.chat = args.chat ?? null;
    if ("workers" in args) patch.workers = args.workers ?? null;
    if ("fallback" in args) patch.fallback = args.fallback?.length ? args.fallback : null;
    if ("parallel_min" in args) patch.parallel_min = args.parallel_min ? args.parallel_min : null;
    if (!Object.keys(patch).length) return fail("nothing to set: pass chat, workers, fallback and/or parallel_min");
    const profile = updateProfile(name, patch, deps.path);
    const out = [await describeProfile(name, profile, deps)];
    if (args.chat) {
      const running = name === (await detectSessionName(deps.env));
      const model = args.chat.model ?? args.chat.provider;
      if (args.apply_now && deps.send) {
        const r = await deps.send(name, `/model ${model}`);
        out.push(r.ok ? `chat model: sent /model ${model} into the session now; also the default for its next start` : `chat model stored for the next start; could not send /model now (${r.error ?? "AIBroker unavailable"})`);
      } else {
        out.push(`chat model stored: applies when the session next starts${running ? " (this session keeps its model until then; set apply_now to send /model into it)" : ""}`);
      }
    }
    if (args.workers || args.fallback !== undefined) out.push("workers change applies to the next spawn");
    return text(out.join("\n"));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
