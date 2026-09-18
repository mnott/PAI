#!/usr/bin/env node

/**
 * mcp-deferred-gate.ts — PreToolUse hook on mcp__* tools.
 *
 * Claude Code defers MCP tool schemas: calling a deferred mcp__server__tool
 * without surfacing it via ToolSearch fails input validation, and sessions
 * misread that as "MCP server disconnected" — as they do the stale handles a
 * mid-session server re-registration leaves behind ("deferred tools are no
 * longer available"). PreToolUse is the only event on
 * the attempt path — when the schema gate rejects the call the tool never
 * runs, so no PostToolUse fires to correct it. A deny here lands the remedy
 * in the same channel the model already reads (same mechanism as
 * route-agents-to-worker), and the transcript evidence check in
 * ../lib/mcp-deferred-gate.ts keeps already-loaded tools passing through
 * untouched.
 *
 * Every correction is appended to the observation store via daemon IPC (same
 * fire-and-forget path as observe.ts), so false-outage reports are countable.
 * Never blocks Claude Code: always exits 0, tolerant of missing transcript.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { connect } from "node:net";
import { decideMcpGate, PASS_OUTPUT, type GateHookInput } from "../lib/mcp-deferred-gate.js";
import { isProbeSession } from "../lib/project-utils.js";

/** Enough transcript to see the whole recent tool history; transcripts can be huge. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Transcript tail — bounded read, never loads the whole file
// ---------------------------------------------------------------------------

function readTranscriptTail(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Inline IPC sender — avoids importing src/daemon/ipc-client.ts at build time
// ---------------------------------------------------------------------------

function sendToDaemon(method: string, params: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve();
    }, 5000);
    try {
      const socket = connect("/tmp/pai.sock", () => {
        const req = JSON.stringify({ id: Date.now().toString(), method, params }) + "\n";
        socket.write(req);
        socket.on("data", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });
        socket.on("error", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      socket.on("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    process.stdout.write(PASS_OUTPUT);
    return;
  }
  if (!text.trim()) {
    process.stdout.write(PASS_OUTPUT);
    return;
  }

  let input: GateHookInput;
  try {
    input = JSON.parse(text) as GateHookInput;
  } catch {
    process.stdout.write(PASS_OUTPUT);
    return;
  }

  const transcript =
    typeof input.transcript_path === "string" ? readTranscriptTail(input.transcript_path) : "";
  const decision = decideMcpGate(input, transcript);
  process.stdout.write(decision.output);

  if (decision.observation && !isProbeSession(input.cwd)) {
    await sendToDaemon("observation_store", {
      session_id: input.session_id ?? "",
      ...decision.observation,
      content_hash: "",
      cwd: input.cwd ?? "",
    });
  }
}

main().catch(() => process.stdout.write(PASS_OUTPUT));
