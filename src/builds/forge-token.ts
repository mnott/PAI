/**
 * Forge token lookup shared by `pai build mirror-sync` and the handover forge
 * sink: process env first, then the AIBroker env file ($HOME/.aibroker/env).
 * The file is only read when it is a regular file owned by the current user
 * with no group/other permission bits. The token is never printed or logged.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ForgeTokenOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  envFile?: string;
}

export interface ForgeTokenLookup {
  token?: string;
  /** Env file path the token came from (never the value). */
  from?: string;
  /** The env file exists but was skipped because of its owner or permissions. */
  permissionsIgnored?: boolean;
}

function parseEnvLine(line: string): [string, string] | undefined {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m || line.trimStart().startsWith("#")) return undefined;
  let v = m[2];
  const q = /^(["'])(.*)\1$/.exec(v);
  if (q) v = q[2];
  return [m[1], v];
}

export function lookupForgeToken(envName: string, opts: ForgeTokenOpts = {}): ForgeTokenLookup {
  const env = opts.env ?? process.env;
  const direct = env[envName] || env.FORGE_TOKEN;
  if (direct) return { token: direct };
  const file = opts.envFile ?? env.AIBROKER_ENV_FILE ?? join(opts.home ?? homedir(), ".aibroker", "env");
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return {};
    if ((st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
      return { permissionsIgnored: true };
    }
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const vars = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const kv = parseEnvLine(line);
    if (kv && kv[1]) vars.set(kv[0], kv[1]);
  }
  const token = vars.get(envName) ?? vars.get("AIBROKER_FORGE_TOKEN");
  return token ? { token, from: file } : {};
}

export function resolveForgeToken(envName: string, opts: ForgeTokenOpts = {}): string | undefined {
  return lookupForgeToken(envName, opts).token;
}
