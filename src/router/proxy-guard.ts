/**
 * proxy-guard.ts — monitor-only guard decisions on model replies passing the router.
 *
 * Rules enforced in Claude Code hooks only protect Claude Code. The router sees every /v1/messages reply, so it
 * maps each completed tool_use block and each final assistant text into a GuardEvent (source "proxy") and calls
 * evaluate(). Monitor only: the caller taps a copy of the reply bytes and runs this after the response ended, so
 * the client's bytes are never modified, delayed or blocked; every failure is caught here. Only pure decisions
 * apply (shell rules, unparsed final text): the context has no pane, no loop state, no worker gates.
 */

import { evaluate as realEvaluate, type Decision, type GuardContext, type GuardEvent } from "../guard/evaluate.js";
import { allRuleDirs, loadRules, projectRuleDirs } from "../hooks/ts/lib/rules/load.js";
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
export function monitorReply(raw: string, contentType: string, model: string, deps: ProxyGuardDeps = {}): Decision[] {
  const decisions: Decision[] = [];
  try {
    const reply = parseReply(raw, contentType);
    const ev = deps.evaluate ?? realEvaluate;
    const ctx: GuardContext = { env: process.env, shellRules: (deps.rules ?? defaultRules)() };
    const events: GuardEvent[] = reply.tools.map((t) => ({ kind: "tool_call", tool: t.name, input: t.input, cwd: PROXY_CWD, model, source: "proxy" }));
    if (!reply.tools.length && reply.text) events.push({ kind: "final_text", text: reply.text, cwd: PROXY_CWD, model, source: "proxy" });
    for (const e of events) {
      try {
        decisions.push(ev(e, ctx));
      } catch (err) {
        deps.log?.(`${new Date().toISOString()} proxy-guard: evaluation failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    deps.log?.(`${new Date().toISOString()} proxy-guard: ${(err as Error).message}`);
  }
  return decisions;
}
