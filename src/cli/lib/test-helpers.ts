/** Test helpers: help-metadata check and an in-process `pai` runner. */

import type { CommandDef } from "../define.js";
import { GROUPS } from "../registry.js";
import { defaultIo, runCli, type Io } from "../run.js";
import { rawSource } from "./legacy.js";

/** Every command (and subcommand) has a one-line summary, 2+ examples and a description. */
export function helpProblems(def: CommandDef, path = def.name): string[] {
  const out: string[] = [];
  if (!def.summary || def.summary.includes("\n")) out.push(`${path}: summary must be one line`);
  if (!def.description) out.push(`${path}: no description`);
  if ((def.examples?.length ?? 0) < 2) out.push(`${path}: needs 2+ examples`);
  for (const s of def.subcommands ?? []) out.push(...helpProblems(s, `${path} ${s.name}`));
  return out;
}

/** Run `pai <argv>` in-process; returns exit code and captured output. */
export async function runPai(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: Io = { ...defaultIo(), out: (s) => (out += s + "\n"), err: (s) => (err += s + "\n") };
  const log = console.log;
  const errLog = console.error;
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
  const prev = rawSource.argv;
  rawSource.argv = () => argv;
  try {
    const code = await runCli(GROUPS, argv, io);
    return { code, out, err };
  } finally {
    console.log = log;
    console.error = errLog;
    rawSource.argv = prev;
  }
}
