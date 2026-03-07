#!/usr/bin/env node

/**
 * inject-observations.ts
 *
 * SessionStart hook that injects recent project observation context into Claude's
 * session as a <system-reminder>. Provides progressive disclosure of recent activity
 * so Claude has immediate awareness of what has been happening in this project.
 *
 * Flow:
 * 1. Read session data (session_id, cwd) from stdin
 * 2. Call daemon via IPC: observation_recent with { cwd, limit: 25 }
 *    (daemon resolves project_id from cwd internally via registry lookup)
 * 3. Format as progressive disclosure context block
 * 4. Output to stdout as <system-reminder> (injected into session by Claude Code)
 *
 * Silent on any failure — never blocks session start.
 */

import { connect } from 'net';
import { randomUUID } from 'crypto';
import { isProbeSession } from '../lib/project-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookData {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface ObservationRow {
  id: number;
  session_id: string;
  project_id: number | null;
  project_slug: string | null;
  type: string;
  title: string;
  narrative: string | null;
  created_at: string; // ISO string after JSON serialization
}

interface ObservationRecentResult {
  rows: ObservationRow[];
  project_slug?: string;
}

// ---------------------------------------------------------------------------
// Inline IPC client — mirrors the pattern in observe.ts
// Hooks can't import from src/daemon/ at runtime, so we inline this.
// ---------------------------------------------------------------------------

async function callDaemon(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
    let buffer = '';

    try {
      const socket = connect('/tmp/pai.sock', () => {
        socket.write(JSON.stringify({ id: randomUUID(), method, params }) + '\n');
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timeout);
          try {
            const response = JSON.parse(buffer.slice(0, nl));
            socket.destroy();
            if (response.ok) resolve(response.result);
            else reject(new Error(response.error ?? 'daemon error'));
          } catch (e) {
            socket.destroy();
            reject(e);
          }
        }
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('daemon unavailable'));
      });
    } catch {
      clearTimeout(timeout);
      reject(new Error('daemon unavailable'));
    }
  });
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  // Older than a week: show date string
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Type label
// ---------------------------------------------------------------------------

function typeLabel(type: string): string {
  switch (type) {
    case 'change':    return '[change]';
    case 'discovery': return '[discovery]';
    case 'decision':  return '[decision]';
    case 'bugfix':    return '[bugfix]';
    case 'feature':   return '[feature]';
    case 'refactor':  return '[refactor]';
    default:          return `[${type}]`;
  }
}

// ---------------------------------------------------------------------------
// Truncate
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '\u2026' : s;
}

// ---------------------------------------------------------------------------
// Format observations as progressive disclosure context
// ---------------------------------------------------------------------------

function formatContext(
  projectSlug: string,
  observations: ObservationRow[]
): string {
  if (observations.length === 0) return '';

  // Count distinct sessions
  const sessionSet = new Set(observations.map(o => o.session_id));
  const sessionCount = sessionSet.size;

  // Most recent observation
  const newest = new Date(observations[0].created_at);
  const lastActivity = timeAgo(newest);

  // Timeline: show most recent 15, keep titles to 80 chars
  const timelineObs = observations.slice(0, 15);
  const timeline = timelineObs
    .map(o => {
      const t = timeAgo(new Date(o.created_at));
      const label = typeLabel(o.type);
      const title = truncate(o.title, 80);
      return `- [${t}] ${label} ${title}`;
    })
    .join('\n');

  const showingNote = observations.length > 15
    ? `(showing most recent 15 of ${observations.length}, use observation_search for more)`
    : `(showing ${observations.length} observation${observations.length !== 1 ? 's' : ''})`;

  const lines: string[] = [
    `<system-reminder>`,
    `OBSERVATION CONTEXT (auto-injected)`,
    ``,
    `## Recent Activity (${projectSlug})`,
    `${observations.length} observations across ${sessionCount} session${sessionCount !== 1 ? 's' : ''} | Last activity: ${lastActivity}`,
    ``,
    `### Recent Timeline`,
    timeline,
    showingNote,
    `</system-reminder>`,
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    // Skip probe/health-check sessions
    if (isProbeSession()) {
      process.exit(0);
    }

    // Skip subagent sessions — they don't need observation context
    const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const isSubagent = claudeProjectDir.includes('/.claude/agents/') ||
                       process.env.CLAUDE_AGENT_TYPE !== undefined;
    if (isSubagent) {
      process.exit(0);
    }

    // Read hook data from stdin
    let hookData: HookData = {};
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw) {
        hookData = JSON.parse(raw);
      }
    } catch {
      // Non-fatal — fall back to process.cwd()
    }

    const cwd = hookData.cwd || process.cwd();

    // Fetch recent observations for this cwd — daemon resolves the project internally
    let observations: ObservationRow[];
    let projectSlug: string;

    try {
      const result = await callDaemon('observation_recent', { cwd, limit: 25 }) as ObservationRecentResult;
      observations = result?.rows ?? [];
      projectSlug = result?.project_slug ?? '';
    } catch {
      // Daemon unavailable or Postgres not configured — silent exit
      process.exit(0);
    }

    if (!observations || observations.length === 0 || !projectSlug) {
      // No data or no matching project — nothing to inject
      process.exit(0);
    }

    // Format and output
    const context = formatContext(projectSlug, observations);
    if (context) {
      // Output to stdout — Claude Code captures this and injects into session context
      console.log(context);
    }

    process.exit(0);
  } catch {
    // Never block session start
    process.exit(0);
  }
}

main();
