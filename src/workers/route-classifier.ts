/**
 * route-classifier.ts — what goes to a local model at all.
 *
 * Applied when the target is local (explicit `--where local`, a local-first
 * session profile, a plan whose provider is `local`). Deterministic rules on
 * the plan part `kind:`, the worker label / tags and keywords in the task
 * text; infrastructure, install, device and external-service work goes to the
 * cloud, bounded code/test slices stay local. Always overridable (forceLocal).
 * After LOCAL_FAILURE_LIMIT failed local attempts on the same label the next
 * start goes to the cloud whatever the rules say.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseLedger } from "./ledger.js";

export const CLOUD_KINDS = ["infra", "install", "device", "external", "redesign"] as const;
export const LOCAL_KINDS = ["code", "test"] as const;
export const LOCAL_FAILURE_LIMIT = 2;

const KEYWORDS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(install(?:er|ation|ing|s)?|signing|code[- ]?sign\w*|app store|testflight|notariz\w+)\b/i, why: "install/signing task" },
  { re: /\b(devices?|icloud|cloudkit)\b/i, why: "device/iCloud task" },
  { re: /\bbuild[- ]system\b/i, why: "build-system task" },
  { re: /\b(door|ci|release)\b/i, why: "door/CI/release task" },
  { re: /\b(migrat\w+|redesign\w*)\b/i, why: "migration/redesign task" },
  { re: /\brefactor\w*\s+across\s+(?:\w+\s+)?modules\b/i, why: "cross-module refactor" },
];

const KIND_WHY: Record<string, string> = {
  infra: "infra task",
  install: "install/device task",
  device: "install/device task",
  external: "external-service task",
  redesign: "redesign task",
};

export interface RouteInput {
  /** Plan part `kind:`. */
  kind?: string;
  label?: string;
  tags?: string[];
  /** Task text / spec. */
  text?: string;
  /** Local attempts that already failed on this part/label. */
  failures?: number;
  /** --force-local: keep it local whatever the rules say. */
  forceLocal?: boolean;
}

export interface RouteDecision {
  where: "local" | "cloud";
  /** Plain reason, e.g. "install/device task". */
  reason: string;
}

/** "route: cloud (install/device task)" */
export function routeLine(d: RouteDecision): string {
  return `route: ${d.where} (${d.reason})`;
}

export function classifyRoute(i: RouteInput): RouteDecision {
  if (i.forceLocal) return { where: "local", reason: "forced local" };
  if ((i.failures ?? 0) >= LOCAL_FAILURE_LIMIT) {
    return { where: "cloud", reason: `escalated: ${i.failures} failed local attempts` };
  }
  const kind = i.kind?.trim().toLowerCase();
  if (kind && KIND_WHY[kind]) return { where: "cloud", reason: KIND_WHY[kind] };
  if (kind && (LOCAL_KINDS as readonly string[]).includes(kind)) return { where: "local", reason: `${kind} part` };
  const words = [i.label ?? "", ...(i.tags ?? [])].join(" ");
  for (const k of CLOUD_KINDS) {
    if (new RegExp(`(^|[\\s:/#,_-])${k}($|[\\s:/#,_-])`, "i").test(words)) return { where: "cloud", reason: `${KIND_WHY[k]} (label ${k})` };
  }
  for (const text of [words, i.text ?? ""]) {
    for (const { re, why } of KEYWORDS) if (re.test(text)) return { where: "cloud", reason: why };
  }
  return { where: "local", reason: "bounded code task" };
}

/**
 * Failed local attempts of a label since its last success, read from the
 * routing ledger (WORKER-END rc != 0 on a local provider; rc=0 resets).
 */
export function localFailures(ledgerFile: string, label: string | undefined, isLocalName: (provider: string) => boolean): number {
  if (!label || !existsSync(ledgerFile)) return 0;
  let n = 0;
  const want = label.replace(/\s+/g, " ");
  for (const raw of readFileSync(ledgerFile, "utf8").split("\n")) {
    // label is the last field and may hold spaces: read it off the raw line
    const lab = raw.match(/ label=(.*)$/)?.[1];
    if (lab !== want) continue;
    const l = parseLedger(raw)[0];
    if (!l || l.event !== "WORKER-END") continue;
    if (!isLocalName(l.fields.provider ?? "")) continue;
    n = l.fields.rc === "0" ? 0 : n + 1;
  }
  return n;
}
