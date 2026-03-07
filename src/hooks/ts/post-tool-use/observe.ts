#!/usr/bin/env node
/**
 * PostToolUse Hook - Observation Capture
 *
 * Classifies each tool call as a structured observation and sends it to the
 * PAI daemon via IPC. Fire-and-forget with a 5-second timeout. Never blocks
 * Claude Code (always exits 0).
 */

import { connect } from 'net';
import { createHash } from 'crypto';
import { basename } from 'path';
import { isProbeSession } from '../lib/project-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookData {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
}

type ObservationType = 'change' | 'discovery' | 'decision' | 'feature';

interface Observation {
  type: ObservationType;
  title: string;
  narrative: string;
  tool_name: string;
  tool_input_summary: string;
  files_read: string[];
  files_modified: string[];
  concepts: string[];
}

// ---------------------------------------------------------------------------
// Tools to skip entirely
// ---------------------------------------------------------------------------

const SKIP_TOOLS = new Set([
  'ToolSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
]);

// ---------------------------------------------------------------------------
// Inline IPC sender — avoids importing src/daemon/ipc-client.ts at build time
// ---------------------------------------------------------------------------

function sendToDaemon(method: string, params: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { resolve(); }, 5000);
    try {
      const socket = connect('/tmp/pai.sock', () => {
        const req = JSON.stringify({ id: Date.now().toString(), method, params }) + '\n';
        socket.write(req);
        socket.on('data', () => { clearTimeout(timeout); socket.destroy(); resolve(); });
        socket.on('error', () => { clearTimeout(timeout); resolve(); });
      });
      socket.on('error', () => { clearTimeout(timeout); resolve(); });
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Concept extraction from file paths
// ---------------------------------------------------------------------------

const SKIP_SEGMENTS = new Set([
  'src', 'dist', 'lib', 'bin', 'test', 'tests', 'spec', 'specs',
  'node_modules', 'Users', 'home', 'usr', 'var', 'tmp', 'etc',
  'hooks', 'scripts', 'config', 'configs', 'assets', 'static',
  'public', 'private', 'build', 'out', 'output', 'generated',
  'ts', 'js', 'mjs', 'cjs',
]);

function extractConcepts(paths: string[]): string[] {
  const concepts = new Set<string>();
  for (const p of paths) {
    const segments = p.split('/').filter(Boolean);
    for (const seg of segments) {
      // Drop extensions
      const clean = seg.replace(/\.[^.]+$/, '');
      if (clean.length > 2 && !SKIP_SEGMENTS.has(clean) && !/^\d+$/.test(clean)) {
        concepts.add(clean);
      }
    }
  }
  return Array.from(concepts).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Inline classifier
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  return '';
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) : s;
}

function classify(toolName: string, toolInput: Record<string, unknown>): Observation | null {
  if (SKIP_TOOLS.has(toolName)) return null;

  let type: ObservationType = 'discovery';
  let title = '';
  let narrative = '';
  let tool_input_summary = '';
  const files_read: string[] = [];
  const files_modified: string[] = [];

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit': {
      const fp = str(toolInput.file_path);
      const name = fp ? basename(fp) : 'file';
      type = 'change';
      title = `Modified ${name}`;
      narrative = fp ? `Edited ${fp}` : 'Edited a file';
      tool_input_summary = fp;
      files_modified.push(...(fp ? [fp] : []));
      break;
    }

    case 'Write':
    case 'NotebookEdit': {
      const fp = str(toolInput.file_path);
      const name = fp ? basename(fp) : 'file';
      type = 'change';
      title = `Created ${name}`;
      narrative = fp ? `Wrote ${fp}` : 'Wrote a file';
      tool_input_summary = fp;
      files_modified.push(...(fp ? [fp] : []));
      break;
    }

    case 'Read': {
      const fp = str(toolInput.file_path);
      const name = fp ? basename(fp) : 'file';
      type = 'discovery';
      title = `Read ${name}`;
      narrative = fp ? `Read ${fp}` : 'Read a file';
      tool_input_summary = fp;
      files_read.push(...(fp ? [fp] : []));
      break;
    }

    case 'Grep': {
      const pattern = str(toolInput.pattern);
      type = 'discovery';
      title = `Searched for '${truncate(pattern, 40)}'`;
      narrative = `Grep search: ${pattern}`;
      tool_input_summary = pattern;
      const gPath = str(toolInput.path || toolInput.file_path);
      if (gPath) files_read.push(gPath);
      break;
    }

    case 'Glob': {
      const pattern = str(toolInput.pattern);
      type = 'discovery';
      title = `Found files: ${truncate(pattern, 40)}`;
      narrative = `Glob pattern: ${pattern}`;
      tool_input_summary = pattern;
      break;
    }

    case 'Bash': {
      const cmd = str(toolInput.command);
      const cmdLower = cmd.toLowerCase();

      if (/git\s+commit/.test(cmdLower)) {
        type = 'decision';
        // Try to extract the commit message after -m "..."
        const mMatch = cmd.match(/-m\s+["']([^"']+)/);
        const msg = mMatch ? mMatch[1] : cmd;
        title = `Committed: ${truncate(msg, 60)}`;
        narrative = `Git commit: ${msg}`;
        tool_input_summary = truncate(cmd, 120);
      } else if (/git\s+push/.test(cmdLower)) {
        type = 'decision';
        title = 'Pushed to remote';
        narrative = `Git push: ${truncate(cmd, 80)}`;
        tool_input_summary = truncate(cmd, 120);
      } else if (/\b(jest|vitest|pytest|bun\s+test|npm\s+test|yarn\s+test|pnpm\s+test|node\s+--test)\b/.test(cmdLower)) {
        type = 'feature';
        title = 'Ran tests';
        narrative = `Test run: ${truncate(cmd, 80)}`;
        tool_input_summary = truncate(cmd, 120);
      } else if (/\b(build|compile|bun\s+run\s+build|tsc|esbuild|webpack|vite\s+build)\b/.test(cmdLower)) {
        type = 'feature';
        title = 'Built project';
        narrative = `Build: ${truncate(cmd, 80)}`;
        tool_input_summary = truncate(cmd, 120);
      } else {
        type = 'discovery';
        title = `Ran: ${truncate(cmd, 60)}`;
        narrative = `Bash: ${truncate(cmd, 120)}`;
        tool_input_summary = truncate(cmd, 120);
      }
      break;
    }

    case 'Task': {
      const prompt = str(toolInput.prompt || toolInput.description);
      type = 'discovery';
      title = `Delegated: ${truncate(prompt, 60)}`;
      narrative = `Spawned agent: ${truncate(prompt, 200)}`;
      tool_input_summary = truncate(prompt, 200);
      break;
    }

    case 'WebFetch': {
      const url = str(toolInput.url);
      type = 'discovery';
      title = `Fetched: ${truncate(url, 60)}`;
      narrative = `Web fetch: ${url}`;
      tool_input_summary = url;
      break;
    }

    case 'WebSearch': {
      const query = str(toolInput.query);
      type = 'discovery';
      title = `Searched web: ${truncate(query, 60)}`;
      narrative = `Web search: ${query}`;
      tool_input_summary = query;
      break;
    }

    default: {
      // mcp__* tools and anything else
      if (toolName.startsWith('mcp__')) {
        type = 'discovery';
        title = `MCP: ${toolName}`;
        narrative = `Called MCP tool ${toolName}`;
        tool_input_summary = toolName;
      } else {
        // Generic fallback — still capture rather than skip
        type = 'discovery';
        title = `Tool: ${toolName}`;
        narrative = `Called ${toolName}`;
        tool_input_summary = JSON.stringify(toolInput).slice(0, 120);
      }
      break;
    }
  }

  const allPaths = [...files_read, ...files_modified];
  const concepts = extractConcepts(allPaths);

  return {
    type,
    title,
    narrative,
    tool_name: toolName,
    tool_input_summary,
    files_read,
    files_modified,
    concepts,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    // Read stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) process.exit(0);

    const hookData: HookData = JSON.parse(raw);

    // Skip probe/health-check sessions
    if (isProbeSession(hookData.cwd)) process.exit(0);

    // Skip uninteresting tools
    if (SKIP_TOOLS.has(hookData.tool_name)) process.exit(0);

    // Classify
    const obs = classify(hookData.tool_name, hookData.tool_input);
    if (!obs) process.exit(0);

    // Content-hash dedup key
    const hash = createHash('sha256')
      .update(hookData.session_id + hookData.tool_name + obs.title)
      .digest('hex')
      .slice(0, 16);

    // Fire-and-forget to daemon
    await sendToDaemon('observation_store', {
      session_id: hookData.session_id,
      type: obs.type,
      title: obs.title,
      narrative: obs.narrative,
      tool_name: obs.tool_name,
      tool_input_summary: obs.tool_input_summary,
      files_read: obs.files_read,
      files_modified: obs.files_modified,
      concepts: obs.concepts,
      content_hash: hash,
      cwd: hookData.cwd ?? '',
    });

    process.exit(0);
  } catch {
    // Never block Claude Code
    process.exit(0);
  }
}

main();
