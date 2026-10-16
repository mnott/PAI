/**
 * Per-provider worker-contract addendum: lessons learned for a model class,
 * appended to the system prompt right after the generic contract. File is
 * `providers.<name>.contract` from the config, else `<PAI_HOME>/contracts/<name>.md`.
 * Missing or empty: no addendum, behaviour unchanged.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";

export interface ContractAddendum {
  path: string;
  text: string;
  sha: string;
}

export function loadContractAddendum(provider: string, override?: string): ContractAddendum | null {
  const path = override ?? paiHomePath("contracts", `${provider}.md`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;
  return { path, text, sha: createHash("sha256").update(text).digest("hex").slice(0, 8) };
}
