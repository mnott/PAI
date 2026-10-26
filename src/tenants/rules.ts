/**
 * rules.ts — the rule set of a tenant, and the version (content hash) of one rule.
 *
 * Anti-pattern rules (loop, final-text, paths) are overlaid inside antipatterns.ts (setActiveTenant). Shell rules
 * use the rule schema and their own loader (rules/load.ts); this adds the tenant's `<rulesDir>/shell` to that one
 * loader as a trusted, id-named directory, so a tenant may add, re-mode, raise, lower or retire a shipped rule.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAntipattern, loadAntipatterns, setActiveTenant } from "../hooks/ts/lib/antipatterns.js";
import { SHIPPED_ANTIPATTERNS } from "../hooks/ts/lib/antipatterns.generated.js";
import { allRuleDirs, listRules, loadRules, projectRuleDirs } from "../hooks/ts/lib/rules/load.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";
import { LOCAL_TENANT, tenantRulesDir } from "./tenants.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Cache key of a directory: its files and mtimes. */
function dirSig(dir: string): string {
  try {
    return readdirSync(dir).sort().map((n) => { try { return `${n}:${statSync(join(dir, n)).mtimeMs}`; } catch { return n; } }).join("|");
  } catch {
    return "";
  }
}

const shellCache = new Map<string, { sig: string; rules: Rule[] }>();

function shellDirs(tenant: string, cwd: string): { dirs: string[]; idNamed: string[] } {
  const base = tenant === LOCAL_TENANT ? undefined : tenantRulesDir(tenant);
  const tdir = base ? join(base, "shell") : undefined;
  return { dirs: [...allRuleDirs(cwd), ...(tdir ? [tdir] : [])], idNamed: tdir ? [tdir] : [] };
}

/**
 * The shell rules a tenant is evaluated against: the local set (shipped + PAI_HOME + project dirs) overlaid by the
 * tenant's `<rulesDir>/shell`. Re-read when a file in the tenant directory changes.
 */
export function tenantShellRules(tenant: string, cwd: string = process.cwd()): Rule[] {
  const { dirs, idNamed } = shellDirs(tenant, cwd);
  const sig = idNamed.map(dirSig).join("");
  const key = `${tenant}\0${cwd}`;
  const hit = shellCache.get(key);
  if (hit && hit.sig === sig) return hit.rules;
  const rules = loadRules(dirs, { projectDirs: projectRuleDirs(cwd), idNamedDirs: idNamed }).rules;
  shellCache.set(key, { sig, rules });
  return rules;
}

/** Drop cached tenant rule sets (tests). */
export function resetTenantRuleCache(): void {
  shellCache.clear();
}

/**
 * The version of a rule as the tenant sees it: a sha256 prefix of the rule file's content, or of the embedded
 * definition for a shipped rule. A change to the file changes the version; the integer `version` field is the
 * author's label, this is the content. Empty string when no rule has the id.
 */
export function ruleVersionOf(id: string, tenant: string = LOCAL_TENANT, cwd: string = process.cwd()): string {
  const prev = setActiveTenant(tenant);
  try {
    const ap = getAntipattern(id);
    if (ap) {
      if (ap.source !== "shipped") return sha(readFileSync(ap.source, "utf8"));
      const raw = SHIPPED_ANTIPATTERNS.find((r) => r.id === id);
      if (raw) return sha(JSON.stringify(raw));
    }
    const { dirs, idNamed } = shellDirs(tenant, cwd);
    const rule = listRules(dirs, { projectDirs: projectRuleDirs(cwd), idNamedDirs: idNamed }).rules.find((r) => r.id === id);
    if (rule) {
      const src = (rule as { source?: string }).source;
      return src && src.startsWith("/") ? sha(readFileSync(src, "utf8")) : sha(JSON.stringify(rule));
    }
  } catch {
    /* an unreadable rule file has no version */
  } finally {
    setActiveTenant(prev);
  }
  return "";
}

/** Every rule id with its version for a tenant (shell and other categories), for the audit manifest. */
export function tenantRuleVersions(tenant: string, cwd: string = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {};
  const { dirs, idNamed } = shellDirs(tenant, cwd);
  for (const r of listRules(dirs, { projectDirs: projectRuleDirs(cwd), idNamedDirs: idNamed }).rules) out[r.id] = ruleVersionOf(r.id, tenant, cwd);
  const prev = setActiveTenant(tenant);
  try {
    for (const a of loadAntipatterns()) out[a.id] = ruleVersionOf(a.id, tenant, cwd);
  } finally {
    setActiveTenant(prev);
  }
  return out;
}
