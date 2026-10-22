#!/usr/bin/env node

/**
 * handoff-link.ts — UserPromptSubmit
 *
 * Records a handoff link: when a prompt carries the `[pai-handoff from=<id>]`
 * marker `pai handoff export` tells the user to paste, appends
 * {ts, from, to} to <PAI_HOME>/handoffs/links.jsonl, so the chain of sessions
 * that continued from one brief is reconstructable. Silent on any failure —
 * never blocks a prompt.
 */

import { appendHandoffLink } from "../../../session/handoff.js";

const MARKER = /\[pai-handoff from=([^\]\s]+)\]/;

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      prompt?: string;
      session_id?: string;
    };
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const m = MARKER.exec(prompt);
    if (!m || !input.session_id) return;
    appendHandoffLink(m[1], input.session_id);
  } catch {
    // silent failure — don't block user prompts
  }
}

void main();
