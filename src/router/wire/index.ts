/**
 * wire/index.ts — the adapters by request path. `messages` wraps the existing
 * Anthropic-format functions so the router asks one interface for all three.
 */

import { convertTextAnswer } from "../tool-args-convert.js";
import { declaredToolSchemas, repairJsonReplyArgs, ToolArgsSse } from "../tool-args.js";
import { chatAdapter } from "./chat.js";
import { responsesAdapter } from "./responses.js";
import type { WireAdapter } from "./types.js";

export const messagesAdapter: WireAdapter = {
  id: "messages",
  keepalive: () => `event: ping\ndata: {"type":"ping"}\n\n`,
  matches: (method, path) => method === "POST" && /^\/v1\/messages(\/count_tokens)?(\?.*)?$/.test(path),
  schemas: declaredToolSchemas,
  rewriteJson: repairJsonReplyArgs,
  rewriteStream: (schemas, rules, onFix) => new ToolArgsSse(schemas, rules, onFix),
  convertMarkup: (raw, ct, schemas, rules) => convertTextAnswer(raw, ct, schemas, rules),
};

export const WIRE_ADAPTERS: readonly WireAdapter[] = [messagesAdapter, chatAdapter, responsesAdapter];

/** `/p/<provider>/v1/...` names the provider in the path (clients whose base URL cannot carry a header). */
export function splitProviderPrefix(path: string): { path: string; provider?: string } {
  const m = /^\/p\/([^/?]+)(\/.*)$/.exec(path);
  return m ? { path: m[2]!, provider: decodeURIComponent(m[1]!) } : { path };
}

export function adapterFor(method: string, path: string): WireAdapter | undefined {
  return WIRE_ADAPTERS.find((a) => a.matches(method, path));
}
