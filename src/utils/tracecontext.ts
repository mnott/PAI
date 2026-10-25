/**
 * tracecontext.ts — W3C Trace Context (traceparent / tracestate), written from
 * the W3C text. Only these two headers are ever forwarded; baggage never is.
 * An invalid caller value is dropped, not refused.
 */

import { randomBytes } from "node:crypto";

export interface Traceparent {
  version: string;
  traceId: string;
  parentId: string;
  flags: string;
}

const HEX = /^[0-9a-f]+$/;
const ZEROS = (n: number): string => "0".repeat(n);

/** `00-<32 hex>-<16 hex>-<2 hex>`; lowercase only, version ff and all-zero ids invalid, version 00 takes no tail. */
export function parseTraceparent(value: unknown): Traceparent | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("-");
  if (parts.length < 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version.length !== 2 || !HEX.test(version) || version === "ff") return null;
  if (traceId.length !== 32 || !HEX.test(traceId) || traceId === ZEROS(32)) return null;
  if (parentId.length !== 16 || !HEX.test(parentId) || parentId === ZEROS(16)) return null;
  if (flags.length !== 2 || !HEX.test(flags)) return null;
  if (version === "00" && parts.length !== 4) return null;
  return { version, traceId, parentId, flags };
}

export function formatTraceparent(t: Pick<Traceparent, "traceId" | "parentId" | "flags">): string {
  return `00-${t.traceId}-${t.parentId}-${t.flags}`;
}

const randomHex = (bytes: number): string => {
  for (;;) {
    const h = randomBytes(bytes).toString("hex");
    if (h !== ZEROS(bytes * 2)) return h;
  }
};

/** A new root trace (sampled). */
export function newTraceparent(): string {
  return formatTraceparent({ traceId: randomHex(16), parentId: randomHex(8), flags: "01" });
}

/** Same trace, fresh span id, parent's flags. A bad parent starts a new root. */
export function childTraceparent(parent: unknown): string {
  const p = parseTraceparent(parent);
  if (!p) return newTraceparent();
  return formatTraceparent({ traceId: p.traceId, parentId: randomHex(8), flags: p.flags });
}

export function traceId(value: unknown): string | null {
  return parseTraceparent(value)?.traceId ?? null;
}

const TS_KEY = /^(?:[a-z][a-z0-9_\-*/]{0,255}|[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13})$/;
const TS_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const TS_MAX_MEMBERS = 32;
const TS_MAX_CHARS = 512;

/** The tracestate when it is valid (<= 32 members, <= 512 chars, unique keys, well-formed pairs), else null. */
export function parseTracestate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > TS_MAX_CHARS) return null;
  const members = v.split(",").map((m) => m.trim()).filter((m) => m !== "");
  if (members.length === 0 || members.length > TS_MAX_MEMBERS) return null;
  const seen = new Set<string>();
  for (const m of members) {
    const eq = m.indexOf("=");
    if (eq < 1) return null;
    const key = m.slice(0, eq);
    if (!TS_KEY.test(key) || !TS_VALUE.test(m.slice(eq + 1)) || seen.has(key)) return null;
    seen.add(key);
  }
  return members.join(",");
}

/**
 * The trace variables for a child process: a child span of the caller's
 * PAI_TRACEPARENT (or TRACEPARENT) when valid, else a new root; the caller's
 * tracestate rides along only with a valid traceparent.
 */
export function traceEnv(source: NodeJS.ProcessEnv = process.env): { TRACEPARENT: string; TRACESTATE?: string } {
  const raw = source.PAI_TRACEPARENT ?? source.TRACEPARENT;
  const valid = parseTraceparent(raw) !== null;
  const state = valid ? parseTracestate(source.PAI_TRACESTATE ?? source.TRACESTATE) : null;
  return { TRACEPARENT: childTraceparent(valid ? raw : null), ...(state ? { TRACESTATE: state } : {}) };
}

/** Set TRACEPARENT/TRACESTATE on `env` (stale values removed); returns the trace id. */
export function applyTraceEnv(env: Record<string, string | undefined>, source: NodeJS.ProcessEnv = process.env): string {
  delete env.TRACESTATE;
  const t = traceEnv(source);
  env.TRACEPARENT = t.TRACEPARENT;
  if (t.TRACESTATE) env.TRACESTATE = t.TRACESTATE;
  delete env.BAGGAGE;
  return traceId(t.TRACEPARENT) as string;
}
