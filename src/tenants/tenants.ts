/**
 * tenants.ts — customer tenants: a rules directory per customer and the principal -> tenant mapping.
 *
 * Config (main config, `tenants:`):
 *   tenants.<name>.rulesDir     absolute path of a customer-owned directory in the antipatterns/ layout
 *                               (<category>/<id>.yaml, shell rules in shell/<id>.yaml)
 *   tenants.<name>.description  free text
 *   tenants.<name>.projects     absolute paths; a hook session whose cwd is at or below one belongs to the tenant
 *
 * "local" is the built-in default tenant: shipped rules plus the user's PAI_HOME overrides, i.e. today's behaviour.
 * A tenant's rule set is the "local" set overlaid by its rulesDir (same id: the tenant wins).
 *
 * Hook-safe: reads the config through the parse cache (mtime-keyed) and nothing else.
 */

import { isAbsolute, resolve, sep } from "node:path";
import { readDualFormatConfigRaw } from "../config/main-config.js";
import { paiHomePath } from "../config/pai-home.js";

export const LOCAL_TENANT = "local";

export interface TenantConfig {
  name: string;
  rulesDir?: string;
  description?: string;
  projects: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function configPath(): string {
  return process.env.PAI_CONFIG_FILE || paiHomePath("config.json");
}

/** All configured tenants (never "local" unless configured to carry a description). Config errors read as none. */
export function readTenants(): TenantConfig[] {
  let raw: Record<string, unknown>;
  try {
    raw = readDualFormatConfigRaw(configPath());
  } catch {
    return [];
  }
  const t = raw.tenants;
  if (!isObj(t)) return [];
  const out: TenantConfig[] = [];
  for (const [name, v] of Object.entries(t)) {
    if (!isObj(v)) continue;
    out.push({
      name,
      rulesDir: typeof v.rulesDir === "string" && isAbsolute(v.rulesDir) ? v.rulesDir : undefined,
      description: typeof v.description === "string" ? v.description : undefined,
      projects: Array.isArray(v.projects) ? v.projects.filter((p): p is string => typeof p === "string" && isAbsolute(p)) : [],
    });
  }
  return out;
}

export const getTenant = (name: string): TenantConfig | undefined => readTenants().find((t) => t.name === name);

/** True for "local" and any configured tenant. */
export const tenantExists = (name: string): boolean => name === LOCAL_TENANT || !!getTenant(name);

/** The rules directory of a tenant; undefined for "local" or a tenant without one. */
export function tenantRulesDir(name: string): string | undefined {
  return name === LOCAL_TENANT ? undefined : getTenant(name)?.rulesDir;
}

/** The tenant a hook session's project belongs to (longest matching project path wins), else "local". */
export function tenantForProject(cwd: string): string {
  const dir = resolve(cwd);
  let best: { name: string; len: number } | null = null;
  for (const t of readTenants()) {
    for (const p of t.projects) {
      const root = resolve(p);
      if ((dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep)) && (!best || root.length > best.len)) best = { name: t.name, len: root.length };
    }
  }
  return best?.name ?? LOCAL_TENANT;
}
