/**
 * Response index and idempotency keys, both plain JSON files under
 * <PAI_HOME>/uhp/ so they survive a server restart (the workers do too).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import type { OutputItem, AssemblerUsage } from "./events.js";

export type UhpStatus = "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
export const TERMINAL: ReadonlySet<UhpStatus> = new Set(["completed", "failed", "incomplete", "cancelled"]);

/** The frozen result of a finished response; stored so it outlives the worker's log. */
export interface FinalState {
  status: UhpStatus;
  output: OutputItem[];
  usage: AssemblerUsage | null;
  model: string;
  error: { type: "harness_error"; code: string; message: string; param: null; detail: null } | null;
  incompleteDetails: { reason: string } | null;
  completedAt: number;
}

export interface ResponseRecord {
  id: string;
  tokenId: string;
  sessionId: string;
  harnessId: string;
  provider: string;
  className: string;
  /** Model asked for, and the one the harness defaults to. */
  requestedModel: string | null;
  model: string;
  /** Detached `pai worker run` pid, and the worker id once its status exists. */
  pid: number;
  workerId: string | null;
  previousResponseId: string | null;
  /** Worker id of the session's first response, the lineage root. */
  rootWorkerId: string | null;
  input: unknown;
  prompt: string;
  store: boolean;
  ignoredFields: string[];
  metadata: Record<string, unknown>;
  requestHash: string;
  cancelRequested: boolean;
  createdAt: number;
  final: FinalState | null;
}

const dir = (...p: string[]): string => paiHomePath("uhp", ...p);

export const newResponseId = (): string => "resp_" + randomBytes(12).toString("hex");
export const newSessionId = (): string => "hsess" + randomBytes(8).toString("hex");

function writeAtomic(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

const recordPath = (id: string): string => dir("responses", `${id}.json`);

export function saveRecord(r: ResponseRecord): void {
  writeAtomic(recordPath(r.id), r);
}

export function loadRecord(id: string): ResponseRecord | null {
  if (!/^resp_[0-9a-f]+$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(recordPath(id), "utf8")) as ResponseRecord;
  } catch {
    return null;
  }
}

export function deleteRecord(id: string): void {
  rmSync(recordPath(id), { force: true });
}

export function listRecords(): ResponseRecord[] {
  const d = dir("responses");
  if (!existsSync(d)) return [];
  const out: ResponseRecord[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    const r = loadRecord(f.slice(0, -5));
    if (r) out.push(r);
  }
  return out;
}

/** Write a prompt for `--spec`. */
export function writePrompt(id: string, text: string): string {
  const p = dir("prompts", `${id}.txt`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text, { mode: 0o600 });
  return p;
}

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

interface KeyEntry {
  hash: string;
  responseId: string;
  at: number;
}

const keyPath = (tokenId: string, key: string): string =>
  dir("idempotency", createHash("sha256").update(`${tokenId}\n${key}`).digest("hex") + ".json");

/** The entry for (token, key) if it is younger than 24 h; an expired one is dropped. */
export function lookupKey(tokenId: string, key: string, now = Date.now()): KeyEntry | null {
  const p = keyPath(tokenId, key);
  try {
    const e = JSON.parse(readFileSync(p, "utf8")) as KeyEntry;
    if (now - e.at <= IDEMPOTENCY_TTL_MS) return e;
    rmSync(p, { force: true });
  } catch {
    // none yet
  }
  return null;
}

export function rememberKey(tokenId: string, key: string, hash: string, responseId: string, now = Date.now()): void {
  writeAtomic(keyPath(tokenId, key), { hash, responseId, at: now } satisfies KeyEntry);
}

/** Drop expired idempotency files (called at server start). */
export function sweepKeys(now = Date.now()): void {
  const d = dir("idempotency");
  if (!existsSync(d)) return;
  for (const f of readdirSync(d)) {
    try {
      if (now - statSync(join(d, f)).mtimeMs > IDEMPOTENCY_TTL_MS) rmSync(join(d, f), { force: true });
    } catch {
      // raced with another sweep
    }
  }
}
