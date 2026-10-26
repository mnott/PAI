/**
 * audit-export.ts — a tenant's audit trail as one file plus a manifest.
 *
 * The record is firings.jsonl (every decision a rule acted on or recorded: note, deny, stop, continue, monitor) and
 * outcomes.jsonl (how the run ended after each firing). Export selects one tenant's lines in a time window, keeps
 * them in time order and writes them as JSONL or CSV. The manifest names the rule versions that fired in the window,
 * the rule set as of the export, PAI's version and the sha256 of the export body. Read-only: nothing is modified or
 * deleted. Lines written before tenants existed carry no tenant and belong to "local".
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveFromModule } from "../module-paths.js";
import { readFirings, readOutcomes, type Firing, type OutcomeLine } from "../hooks/ts/lib/antipattern-log.js";
import { tenantRuleVersions } from "./rules.js";
import { LOCAL_TENANT, tenantExists } from "./tenants.js";

export interface ExportOptions {
  tenant: string;
  since?: string;
  until?: string;
  format?: "jsonl" | "csv";
}

export interface ExportManifest {
  tenant: string;
  since: string | null;
  until: string | null;
  exportedAt: string;
  paiVersion: string;
  format: "jsonl" | "csv";
  lines: { firings: number; outcomes: number };
  /** Rule ids with the content versions that fired in the window. */
  rulesFired: { id: string; versions: string[] }[];
  /** The tenant's whole rule set as of the export time: id -> content version. */
  ruleSet: Record<string, string>;
  sha256: string;
}

export type AuditLine = ({ type: "firing" } & Firing) | ({ type: "outcome" } & OutcomeLine);

const COLUMNS = ["type", "ts", "tenant", "ruleId", "ruleVersion", "principal", "source", "action", "mode", "category", "provider", "model", "workerId", "sessionId", "project", "inputHash", "excerpt", "disposition", "firingTs", "outcome", "final"] as const;

function paiVersion(): string {
  try {
    return (JSON.parse(readFileSync(resolveFromModule(import.meta.url, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseBound(name: string, v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`${name} is not an ISO timestamp: ${v}`);
  return t;
}

/** The tenant's lines in the window (oldest first): its firings, and the outcomes of those firings. */
export function selectAuditLines(o: ExportOptions): AuditLine[] {
  const since = parseBound("since", o.since);
  const until = parseBound("until", o.until);
  const inWindow = (ts: string): boolean => {
    const t = Date.parse(ts);
    return (since === null || t >= since) && (until === null || t <= until);
  };
  const firings = readFirings().filter((f) => (f.tenant ?? LOCAL_TENANT) === o.tenant && inWindow(f.ts));
  const keys = new Set(firings.map((f) => `${f.ts}\t${f.id}`));
  const outcomes = readOutcomes().filter((x) => keys.has(`${x.firingTs}\t${x.id}`));
  const lines: AuditLine[] = [
    ...firings.map((f) => ({ type: "firing" as const, ...f, ruleId: f.ruleId ?? f.id, tenant: f.tenant ?? LOCAL_TENANT })),
    ...outcomes.map((x) => ({ type: "outcome" as const, ...x, ruleId: x.ruleId ?? x.id, tenant: o.tenant })),
  ];
  return lines.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** The export body and its manifest. Throws on an unknown tenant or a bad timestamp. */
export function exportAudit(o: ExportOptions): { body: string; manifest: ExportManifest } {
  if (!tenantExists(o.tenant)) throw new Error(`unknown tenant ${o.tenant}`);
  const format = o.format ?? "jsonl";
  if (format !== "jsonl" && format !== "csv") throw new Error(`format must be jsonl or csv, not ${String(format)}`);
  const lines = selectAuditLines(o);
  const body =
    format === "jsonl"
      ? lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "")
      : [COLUMNS.join(","), ...lines.map((l) => COLUMNS.map((c) => csvCell((l as unknown as Record<string, unknown>)[c])).join(","))].join("\n") + "\n";
  const versions = new Map<string, Set<string>>();
  for (const l of lines) {
    if (l.type !== "firing") continue;
    const id = l.ruleId ?? l.id;
    if (!versions.has(id)) versions.set(id, new Set());
    if (l.ruleVersion) versions.get(id)!.add(l.ruleVersion);
  }
  const manifest: ExportManifest = {
    tenant: o.tenant,
    since: o.since ?? null,
    until: o.until ?? null,
    exportedAt: new Date().toISOString(),
    paiVersion: paiVersion(),
    format,
    lines: { firings: lines.filter((l) => l.type === "firing").length, outcomes: lines.filter((l) => l.type === "outcome").length },
    rulesFired: [...versions].map(([id, v]) => ({ id, versions: [...v].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    ruleSet: tenantRuleVersions(o.tenant),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  return { body, manifest };
}
