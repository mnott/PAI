#!/usr/bin/env node

/**
 * local-model-hint.ts — UserPromptSubmit (interactive sessions and workers)
 *
 * When the prompt talks about local work, adds one line with the PAI daemon's
 * current answer to "which local model is running" so the session never
 * probes ports or hunts for a server to start (incident 2026-10-19). Reads
 * the daemon's cached answer file; no probing here.
 */

import { readFileSync } from "node:fs";
import { cachedLocalAnswer } from "../lib/local-answer.js";
import { isLocalPrompt, localModelHint } from "../lib/local-model-hint.js";

function main(): void {
  let prompt = "";
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { prompt?: string };
    prompt = typeof input.prompt === "string" ? input.prompt : "";
  } catch {
    return;
  }
  if (!isLocalPrompt(prompt)) return;
  const hint = localModelHint(prompt, cachedLocalAnswer());
  if (hint) process.stdout.write(hint);
}

main();
