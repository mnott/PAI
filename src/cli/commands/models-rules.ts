/** `pai models rules list|test|probe|reload`: the tool-call repair rules (src/router/tool-call-rules.ts). */

import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readHits } from "../../router/tool-call-hits.js";
import { loadRules, reloadMarker, rulesPathFor, shippedRulesPath, type ToolCallRulesConfig } from "../../router/tool-call-rules.js";
import { candidatesText, DEFAULT_STALE_DAYS, listRules, probeRules, testRules, type ProbeAnswer } from "../../router/tool-call-rules-ops.js";

export interface RulesDeps {
  home: string;
  cfg: ToolCallRulesConfig | undefined;
  staleDays: number;
  hitsFile?: string;
  now?: Date;
  /** One Messages API call to the named provider (probe only). */
  send?: (provider: string) => (body: Record<string, unknown>) => Promise<ProbeAnswer>;
}

export interface RulesOpts {
  from?: string;
  provider?: string;
  model?: string;
  rounds?: number;
  out?: string;
  json?: boolean;
}

const pad = (rows: string[][]): string => {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd()).join("\n");
};

function sourcePath(o: RulesOpts, d: RulesDeps): string {
  return o.from ? resolve(o.from) : rulesPathFor(d.cfg, d.home, o.provider ?? "", o.model ?? "");
}

export async function runRules(sub: string | undefined, o: RulesOpts, d: RulesDeps): Promise<{ text: string; ok: boolean }> {
  const now = d.now ?? new Date();
  if (sub === "list") {
    const path = sourcePath(o, d);
    const rows = listRules(loadRules(path), readHits(d.hitsFile), d.staleDays, now);
    if (o.json) return { text: JSON.stringify({ file: path, staleDays: d.staleDays, rules: rows }, null, 2), ok: true };
    const table = pad([["RULE", "KIND", "STATE", "HITS", "LAST HIT", "STALE"], ...rows.map((r) => [r.id, r.kind, r.state, String(r.hits), r.last_hit, r.stale ? `stale (>${d.staleDays}d)` : ""])]);
    return { text: `${path}\n${table}`, ok: true };
  }
  if (sub === "test") {
    const path = sourcePath(o, d);
    const rows = testRules(loadRules(path), undefined, now);
    const bad = rows.filter((r) => r.status === "fail" || r.status === "redundant");
    const text = pad(rows.map((r) => [r.id, r.status, r.detail ?? ""]));
    return { text: `${path}\n${text}\n${bad.length ? `${bad.length} of ${rows.length} rules need attention` : `${rows.length} rules ok`}`, ok: !bad.length };
  }
  if (sub === "reload") {
    const dir = join(d.home, d.cfg?.dir ?? "tool-call-rules");
    const files = [shippedRulesPath(), ...(existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(dir, f)) : [])];
    const lines: string[] = [];
    let ok = true;
    for (const f of files) {
      try {
        lines.push(`ok    ${f} (${loadRules(f).rules.length} rules)`);
      } catch (e) {
        ok = false;
        lines.push(`BAD   ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const marker = reloadMarker(d.cfg, d.home);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString() + "\n");
    utimesSync(marker, now, now);
    lines.push(ok ? "reload requested: the router re-reads within 5 s" : "reload requested, but a bad file keeps its previous rules in the router until fixed");
    return { text: lines.join("\n"), ok };
  }
  if (sub === "probe") {
    if (!o.provider) throw new Error("usage: pai models rules probe --provider P [--from FILE] [--rounds N] [--out FILE]");
    if (!d.send) throw new Error("probe needs a provider connection");
    const rounds = Number.isFinite(o.rounds) && (o.rounds as number) > 0 ? Math.floor(o.rounds as number) : 3;
    const path = sourcePath(o, d);
    const r = await probeRules(loadRules(path), rounds, d.send(o.provider), now);
    const out = resolve(o.out ?? join(d.home, d.cfg?.dir ?? "tool-call-rules", `probe-${o.provider}.yaml`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.adapted);
    const cands = candidatesText(r.candidates);
    writeFileSync(`${out}.CANDIDATES`, cands);
    const table = pad([["RULE", "PROBE", "FIRED"], ...r.rows.map((x) => [x.id, x.state, x.probed ? `${x.fired}/${x.rounds}` : "-"])]);
    return { text: `${table}\nadapted rules: ${out}\ncandidates: ${r.candidates.length} (${out}.CANDIDATES)`, ok: true };
  }
  throw new Error("usage: pai models rules list|test|probe|reload [--from FILE] [--provider P] [--model M] [--rounds N] [--out FILE] [--json]");
}

export { DEFAULT_STALE_DAYS };
