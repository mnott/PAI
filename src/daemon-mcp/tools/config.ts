/**
 * MCP handlers for config_list/config_get/config_set/config_unset — thin
 * wrappers around src/config/main-config-ops.ts, the same functions
 * src/cli/commands/config.ts calls, so masking and validation cannot drift
 * between the CLI and MCP surfaces.
 */

import {
  listConfigOp,
  getConfigValueOp,
  setConfigValueOp,
  unsetConfigValueOp,
  MainConfigOpsError,
} from "../../config/main-config-ops.js";
import { MainConfigError } from "../../config/main-config.js";

export interface ToolTextResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

function text(s: string): ToolTextResult {
  return { content: [{ type: "text", text: s }] };
}

function errorText(e: unknown): ToolTextResult {
  const msg = e instanceof MainConfigOpsError || e instanceof MainConfigError
    ? e.message
    : e instanceof Error
      ? e.message
      : String(e);
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function configList(args: { all?: boolean; json?: boolean }): ToolTextResult {
  try {
    const r = listConfigOp({ all: args.all });
    return text(args.json ? JSON.stringify(r.data, null, 2) : r.yaml.trimEnd());
  } catch (e) {
    return errorText(e);
  }
}

export function configGet(args: { path: string }): ToolTextResult {
  try {
    const r = getConfigValueOp(args.path);
    if (!r.found) return errorText(new Error(`Not set: ${args.path}`));
    return text(typeof r.value === "object" ? JSON.stringify(r.value, null, 2) : String(r.value));
  } catch (e) {
    return errorText(e);
  }
}

export function configSet(args: { path: string; value: string; force?: boolean }): ToolTextResult {
  try {
    const r = setConfigValueOp(args.path, args.value, { force: args.force });
    const lines: string[] = [];
    if (r.yamlCreated) lines.push(`created ${r.yamlPath}`);
    lines.push(`Set ${args.path} = ${typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value)}`);
    return text(lines.join("\n"));
  } catch (e) {
    return errorText(e);
  }
}

export function configUnset(args: { path: string }): ToolTextResult {
  try {
    const r = unsetConfigValueOp(args.path);
    return text(r.existed ? `Unset ${args.path}` : `${args.path} was not set`);
  } catch (e) {
    return errorText(e);
  }
}
