#!/usr/bin/env node

/**
 * PostToolUse Hook - Captures tool outputs for UOCS
 *
 * Automatically logs all tool executions to daily JSONL files
 * for later processing and analysis.
 */

import { join } from 'path';
import { historyDir } from '../lib/pai-paths.js';
import { appendRawCapture, captureEventId, localCaptureDate, redactDeep } from '../lib/raw-capture.js';

interface ToolUseData {
  tool_name: string;
  tool_input: Record<string, any>;
  tool_response: Record<string, any>;
  session_id: string;
  tool_use_id?: string;
  timestamp: string;
}

// Configuration
const CAPTURE_DIR = join(historyDir(), 'raw-outputs');
const INTERESTING_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Task', 'NotebookEdit'];

async function main() {
  try {
    // Read input from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8');
    if (!input || input.trim() === '') {
      process.exit(0);
    }

    const data: ToolUseData = JSON.parse(input);

    // Only capture interesting tools
    if (!INTERESTING_TOOLS.includes(data.tool_name)) {
      process.exit(0);
    }

    // Get today's date for organization (local date, never toISOString)
    const now = new Date();
    const today = localCaptureDate(now); // YYYY-MM-DD
    const yearMonth = today.substring(0, 7); // YYYY-MM

    const dateDir = join(CAPTURE_DIR, yearMonth);

    // Format output as JSONL (one JSON object per line)
    const captureFile = join(dateDir, `${today}_tool-outputs.jsonl`);
    const timestamp = data.timestamp || now.toISOString();
    const captureEntry = JSON.stringify({
      timestamp,
      tool: data.tool_name,
      input: redactDeep(data.tool_input),
      output: redactDeep(data.tool_response),
      session: data.session_id,
      source: 'hook',
      fidelity: 'observed',
      eventId: captureEventId({
        sessionId: data.session_id,
        toolUseId: data.tool_use_id,
        event: 'PostToolUse',
        ts: timestamp
      })
    }) + '\n';

    // Append to daily log
    appendRawCapture(captureFile, dateDir, captureEntry);

    // Exit successfully (code 0 = continue normally)
    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[UOCS] PostToolUse hook error: ${error}`);
    process.exit(0);
  }
}

main();
