/**
 * proxy-guard.ts — monitor-only guard decisions on model replies passing the router.
 *
 * Rules enforced in Claude Code hooks only protect Claude Code. The router sees every /v1/messages reply, so it
 * maps each completed tool_use block and each final assistant text into a GuardEvent (source "proxy") and calls
 * evaluate(). Monitor only: the caller taps a copy of the reply bytes and runs this after the response ended, so
 * the client's bytes are never modified, delayed or blocked; every failure is caught here. When the request is
 * given, a per-conversation loop state (proxy-loop.ts, in memory) joins the shell rules; there is no pane and no
 * worker gate.
 */

import { evaluate as realEvaluate, type Decision, type GuardContext, type GuardEvent } from "../guard/evaluate.js";
import { allRuleDirs, loadRules, projectRuleDirs } from "../hooks/ts/lib/rules/load.js";
import { recordLoopTelemetry } from "../hooks/ts/lib/loop-guard-telemetry.js";
import { applyToolResults, conversationKey, defaultLoopStore, type LoopStore } from "./proxy-loop.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";

/** Cap on the bytes kept per reply; a longer reply is not evaluated. */
export const GUARD_MAX_BYTES = 4 * 1024 * 1024;

/** The cwd of events from the proxy: the real one is unknown. */
export const PROXY_CWD = "proxy";

export interface Reply {
  tools: { name: string; input: unknown }[];
  text: string;
}

/** Completed tool_use blocks and the text of a buffered /v1/messages reply (JSON or SSE). */
export function parseReply(raw: string, contentType: string): Reply {
  const out: Reply = { tools: [], text: "" };
  if (/text\/event-stream/i.test(contentType)) {
    const open = new Map<number, { name: string; json: string }>();
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let ev: any;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const i = typeof ev.index === "number" ? ev.index : -1;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") open.set(i, { name: String(ev.content_block.name ?? ""), json: "" });
      else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        const b = open.get(i);
        if (b) b.json += ev.delta.partial_json ?? "";
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out.text += ev.delta.text ?? "";
      else if (ev.type === "content_block_stop" && open.has(i)) {
        const b = open.get(i)!;
        open.delete(i);
        let input: unknown = {};
        try {
          input = b.json ? JSON.parse(b.json) : {};
        } catch {
          continue; // a damaged input is not a decision
        }
        out.tools.push({ name: b.name, input });
      }
    }
    return out;
  }
  try {
    const j = JSON.parse(raw);
    for (const b of Array.isArray(j.content) ? j.content : []) {
      if (b?.type === "text") out.text += b.text ?? "";
      else if (b?.type === "tool_use") out.tools.push({ name: String(b.name ?? ""), input: b.input ?? {} });
    }
  } catch {
    /* not a messages body */
  }
  return out;
}

export interface ProxyGuardDeps {
  evaluate?: (e: GuardEvent, c: GuardContext) => Decision;
  rules?: () => Rule[];
  log?: (line: string) => void;
  /** Per-conversation loop state; defaults to the process-wide store. */
  loops?: LoopStore;
  /** Firing sink (tests); defaults to the antipattern log. */
  record?: GuardContext["record"];
}

let cachedRules: Rule[] | null = null;
function defaultRules(): Rule[] {
  cachedRules ??= loadRules(allRuleDirs(process.cwd()), { projectDirs: projectRuleDirs(process.cwd()) }).rules;
  return cachedRules;
}

/**
 * Evaluate one finished reply: one event per tool_use block, and a final_text event when the reply has text and no
 * tool use. Non-allow decisions are recorded by evaluate() (source "proxy"). Returns the decisions; never throws.
 */
export function monitorReply(raw: string, contentType: string, model: string, deps: ProxyGuardDeps = {}, provider?: string, request?: unknown): Decision[] {
  return monitorParsed(() => parseReply(raw, contentType), model, deps, provider, request);
}

/** monitorReply for an OpenAI Chat Completions reply (JSON or SSE) behind the worker proxy. */
export function monitorOpenAiReply(raw: string, contentType: string, model: string, deps: ProxyGuardDeps = {}, provider?: string, request?: unknown): Decision[] {
  return monitorParsed(() => parseOpenAiReply(raw, contentType), model, deps, provider, request);
}

/** Tool arguments as the model sent them: parsed JSON, or the raw string when it is not valid JSON. */
function parseArgs(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Tool calls and text of a buffered OpenAI chat completion (JSON or SSE chunks). Tool names pass through
 * unchanged, exactly as translate.ts hands them to Claude Code, so they are already the evaluate() names.
 */
export function parseOpenAiReply(raw: string, contentType: string): Reply {
  const out: Reply = { tools: [], text: "" };
  const isSse = /text\/event-stream/i.test(contentType);
  if (isSse) {
    const open = new Map<string, { name: string; args: string }>();
    const flush = () => {
      for (const b of open.values()) if (b.name) out.tools.push({ name: b.name, input: parseArgs(b.args) });
      open.clear();
    };
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let ev: any;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      for (const ch of Array.isArray(ev?.choices) ? ev.choices : []) {
        const d = ch?.delta;
        if (typeof d?.content === "string") out.text += d.content;
        for (const tc of Array.isArray(d?.tool_calls) ? d.tool_calls : []) {
          const key = `${ch.index ?? 0}:${typeof tc.index === "number" ? tc.index : 0}`;
          const b = open.get(key) ?? { name: "", args: "" };
          open.set(key, b);
          if (tc.function?.name) b.name += tc.function.name;
          if (tc.function?.arguments) b.args += tc.function.arguments;
        }
        if (ch?.finish_reason) flush();
      }
    }
    flush(); // a stream cut before finish_reason still carries what it accumulated
    return out;
  }
  try {
    const j = JSON.parse(raw);
    for (const ch of Array.isArray(j.choices) ? j.choices : []) {
      const m = ch?.message;
      if (typeof m?.content === "string") out.text += m.content;
      for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        out.tools.push({ name: String(tc?.function?.name ?? ""), input: parseArgs(String(tc?.function?.arguments ?? "")) });
      }
    }
  } catch {
    /* not a chat completion body */
  }
  return out;
}

function monitorParsed(parse: () => Reply, model: string, deps: ProxyGuardDeps, provider?: string, request?: unknown): Decision[] {
  const decisions: Decision[] = [];
  try {
    const reply = parse();
    const ev = deps.evaluate ?? realEvaluate;
    const ctx: GuardContext = { env: process.env, shellRules: (deps.rules ?? defaultRules)(), record: deps.record };
    const events: GuardEvent[] = reply.tools.map((t) => ({ kind: "tool_call", tool: t.name, input: t.input, cwd: PROXY_CWD, model, provider, source: "proxy" }));
    if (!reply.tools.length && reply.text) events.push({ kind: "final_text", text: reply.text, cwd: PROXY_CWD, model, provider, source: "proxy" });
    const store = deps.loops ?? defaultLoopStore;
    const key = request ? conversationKey(request) : null;
    let state = key ? applyToolResults(store.get(key), request) : null;
    for (const e of events) {
      try {
        if (state) ctx.loop = { state };
        const d = ev(e, ctx);
        if (state && d.loop) {
          state = d.loop.state;
          if (e.kind === "tool_call") recordLoopTelemetry(d.loop, { cwd: e.cwd, fallbackText: e.tool, source: "proxy", model, provider, record: ctx.record });
        }
        decisions.push(d);
      } catch (err) {
        deps.log?.(`${new Date().toISOString()} proxy-guard: evaluation failed: ${(err as Error).message}`);
      }
    }
    if (key && state) store.set(key, state);
  } catch (err) {
    deps.log?.(`${new Date().toISOString()} proxy-guard: ${(err as Error).message}`);
  }
  return decisions;
}
