/**
 * credential-guard.ts — worker write-time check for literal credentials in
 * test files. The merge gate (utils/no-token-literals.test.ts) rejects them
 * after the fact; this denies the Write/Edit/MultiEdit up front with a pointer
 * to the fake-secret builders. Same scanner as the gate (utils/token-literals).
 * Worker-only (PAI_WORKER=1); only *.test.ts files are scanned, matching the gate.
 */

import { scanText } from "../../../utils/token-literals.js";
import type { EditRepairInput } from "./edit-repair.js";

const BUILDER_HINT =
  "build it at runtime with the helpers in src/utils/fake-secret.ts (fakeUrl, fakeSlack, fakeAnthropic, fakeGithub, fakeGithubPat, fakeGitlab, fakeAwsKey, fakeGoogle, pemBegin/pemEnd, fake) as other tests do";

/** Content a call adds to the file: Write content, Edit new_string, MultiEdit new_strings. */
function addedText(input: EditRepairInput): string[] {
  const ti = input.tool_input ?? {};
  if (input.tool_name === "Write") return typeof ti.content === "string" ? [ti.content] : [];
  const edits: Array<Record<string, unknown>> = input.tool_name === "MultiEdit" ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
  return edits.map((e) => e?.new_string).filter((s): s is string => typeof s === "string");
}

/** Deny reason when a worker's test-file write carries a literal credential, else null. */
export function checkCredentialLiteral(input: EditRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1") return null;
  if (!["Write", "Edit", "MultiEdit"].includes(input.tool_name ?? "")) return null;
  const path = input.tool_input?.file_path;
  if (typeof path !== "string" || !path.endsWith(".test.ts")) return null;
  for (const text of addedText(input)) {
    const hit = scanText(text)[0];
    if (hit) return `this content contains a literal credential (${hit.kind}, line ${hit.line}); ${BUILDER_HINT}`;
  }
  return null;
}
