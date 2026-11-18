/**
 * tail-bind.ts — the router's second listener (router.bind other than loopback).
 *
 * The loopback listener never depends on it: when the tailnet address is not
 * up yet (boot before Tailscale) or a configured IPv4 is not assigned, this
 * keeps retrying (10 s, backing off to 60 s) and binds as soon as it can.
 * State goes to router.bind.json so `pai router status` can show it.
 */

import type http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { resolveBindAddress } from "./cockpit-auth.js";

export type TailState = { bind: string; port: number; pid: number; state: "waiting" | "bound"; addr?: string };

export const routerBindStateFile = (): string => paiHomePath("router.bind.json");

export function writeTailState(s: TailState): void {
  try {
    writeFileSync(routerBindStateFile(), JSON.stringify(s));
  } catch {
    /* status is informational */
  }
}

export function readTailState(pid: number): TailState | null {
  try {
    if (!existsSync(routerBindStateFile())) return null;
    const s = JSON.parse(readFileSync(routerBindStateFile(), "utf8")) as TailState;
    return s.pid === pid ? s : null;
  } catch {
    return null;
  }
}

/** A bind name that is valid but may not resolve yet: "tailscale" or a concrete IPv4. */
export function isDeferrableBind(bind: string): boolean {
  const v = bind.trim().toLowerCase();
  if (v === "tailscale") return true;
  return resolveBindAddress(v, () => ({})) !== null && v !== "loopback" && v !== "";
}

export interface TailBindOpts {
  bind: string;
  port: number;
  resolve?: (bind: string) => string | null;
  initialMs?: number;
  maxMs?: number;
  log: (line: string) => void;
  onState?: (s: { state: "waiting" | "bound"; addr?: string }) => void;
  onBound?: (addr: string) => void;
  /** Retry timer; default setTimeout. Tests pass a fake clock so no wall-clock waiting is needed. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  /** Called once the first attempt ran and the bind is deferred (or bound). Lets tests await instead of sleep. */
  onSettled?: () => void;
}

/** Retries until `server` listens on the resolved address. Returns a cancel function. */
export function bindWhenUp(server: http.Server, o: TailBindOpts): () => void {
  const resolve = o.resolve ?? ((b: string) => resolveBindAddress(b));
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
  let delay = o.initialMs ?? 10_000;
  const maxMs = o.maxMs ?? 60_000;
  let timer: { cancel(): void } | undefined;
  let cancelled = false;
  let announced = false;
  const waiting = (why: string): void => {
    if (!announced) {
      announced = true;
      o.log(`pai: router: waiting for router.bind "${o.bind}" (${why}); serving on loopback meanwhile`);
    }
    o.onState?.({ state: "waiting" });
    timer = setTimer(attempt, delay);
    delay = Math.min(maxMs, Math.round(delay * 1.5));
  };
  const attempt = (): void => {
    if (cancelled) return;
    const addr = resolve(o.bind);
    if (!addr) return waiting("address not up");
    const onErr = (e: NodeJS.ErrnoException): void => {
      server.off("listening", onOk);
      if (e.code === "EADDRNOTAVAIL" || e.code === "EADDRINUSE") return waiting(e.code);
      o.log(`pai: router ${addr}: ${e.message}`);
      waiting(e.code ?? "error");
    };
    const onOk = (): void => {
      server.off("error", onErr);
      o.log(`pai: router: bound ${addr}:${o.port}`);
      o.onState?.({ state: "bound", addr });
      o.onBound?.(addr);
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(o.port, addr);
  };
  // the first attempt is synchronous; the listen/error events land on later ticks, so `onSettled` fires after them
  attempt();
  queueMicrotask(() => o.onSettled?.());
  return () => {
    cancelled = true;
    if (timer) timer.cancel();
  };
}
