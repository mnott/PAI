#!/usr/bin/env node

/**
 * load-project-context.ts
 *
 * SessionStart hook that sets up project context:
 * - Checks for CLAUDE.md in various locations (Claude Code handles loading)
 * - Sets up Notes/ directory in ~/.claude/projects/{encoded-path}/
 * - Ensures TODO.md exists
 * - Sends ntfy.sh notification (mandatory)
 * - Displays session continuity info (like session-init.sh)
 *
 * This hook complements Claude Code's native CLAUDE.md loading by:
 * - Setting up the Notes infrastructure
 * - Showing the latest session note for continuity
 * - Sending ntfy.sh notifications
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import {
  PAI_DIR,
  findNotesDir,
  getProjectDir,
  getCurrentNotePath,
  createSessionNote,
  findTodoPath,
  findAllClaudeMdPaths,
  sendNtfyNotification,
  isProbeSession
} from '../lib/project-utils';

/**
 * Find the pai CLI binary path dynamically.
 * Tries `which pai` first, then common fallback locations.
 */
function findPaiBinary(): string {
  try {
    return execSync('which pai', { encoding: 'utf-8' }).trim();
  } catch {
    // Fallback locations in order of preference
    const fallbacks = [
      '/usr/local/bin/pai',
      '/opt/homebrew/bin/pai',
      `${process.env.HOME}/.local/bin/pai`,
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
  }
  return 'pai'; // Last resort: rely on PATH at runtime
}

/**
 * Check session-routing.json for an active route.
 * Returns the routed Notes path if set, or null to use default behavior.
 */
function getRoutedNotesPath(): string | null {
  const routingFile = join(PAI_DIR, 'session-routing.json');
  if (!existsSync(routingFile)) return null;

  try {
    const routing = JSON.parse(readFileSync(routingFile, 'utf-8'));
    const active = routing?.active_session;
    if (active?.notes_path) {
      return active.notes_path;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Project signals that indicate a directory is a real project root.
 */
const PROJECT_SIGNALS = [
  '.git',
  'package.json',
  'pubspec.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'build.gradle',
  'pom.xml',
  'composer.json',
  'Gemfile',
  'Makefile',
  'CMakeLists.txt',
  'tsconfig.json',
  'CLAUDE.md',
  join('Notes', 'PAI.md'),
];

/**
 * Returns true if the given directory looks like a project root.
 * Checks for the presence of well-known project signal files/dirs.
 */
function hasProjectSignals(dir: string): boolean {
  for (const signal of PROJECT_SIGNALS) {
    if (existsSync(join(dir, signal))) return true;
  }
  return false;
}

/**
 * Returns true if the directory should NOT be auto-registered.
 * Guards: home directory, shallow paths, temp directories.
 */
function isGuardedPath(dir: string): boolean {
  const home = homedir();
  const resolved = resolve(dir);

  // Never register the home directory itself
  if (resolved === home) return true;

  // Depth guard: require at least 3 path segments beyond root
  // e.g. /Users/i052341/foo is depth 3 on macOS — reject it
  const parts = resolved.split('/').filter(Boolean);
  if (parts.length < 3) return true;

  // Temp/system directories
  const forbidden = ['/tmp', '/var', '/private/tmp', '/private/var/folders'];
  for (const prefix of forbidden) {
    if (resolved === prefix || resolved.startsWith(prefix + '/')) return true;
  }

  return false;
}

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
}

async function main() {
  console.error('\nload-project-context.ts starting...');

  // Skip probe/health-check sessions (e.g. CodexBar ClaudeProbe)
  if (isProbeSession()) {
    console.error('Probe session detected - skipping project context loading');
    process.exit(0);
  }

  // Read hook input from stdin
  let hookInput: HookInput | null = null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8');
    if (input.trim()) {
      hookInput = JSON.parse(input);
    }
  } catch (error) {
    console.error('Could not parse hook input, using process.cwd()');
  }

  // Get current working directory
  const cwd = hookInput?.cwd || process.cwd();

  // Determine meaningful project name
  // If cwd is a Notes directory, use parent directory name instead
  let projectName = basename(cwd);
  if (projectName.toLowerCase() === 'notes') {
    projectName = basename(dirname(cwd));
  }

  console.error(`Working directory: ${cwd}`);
  console.error(`Project: ${projectName}`);

  // Check if this is a subagent session - skip for subagents
  const isSubagent = process.env.CLAUDE_AGENT_TYPE !== undefined ||
                     (process.env.CLAUDE_PROJECT_DIR || '').includes('/.claude/agents/');

  if (isSubagent) {
    console.error('Subagent session - skipping project context setup');
    process.exit(0);
  }

  // 1. Find and READ all CLAUDE.md files - inject them into context
  // This ensures Claude actually processes the instructions, not just sees them in headers
  const claudeMdPaths = findAllClaudeMdPaths(cwd);
  const claudeMdContents: { path: string; content: string }[] = [];

  if (claudeMdPaths.length > 0) {
    console.error(`Found ${claudeMdPaths.length} CLAUDE.md file(s):`);
    for (const path of claudeMdPaths) {
      console.error(`   - ${path}`);
      try {
        const content = readFileSync(path, 'utf-8');
        claudeMdContents.push({ path, content });
        console.error(`     Read ${content.length} chars`);
      } catch (error) {
        console.error(`     Could not read: ${error}`);
      }
    }
  } else {
    console.error('No CLAUDE.md found in project');
    console.error('   Consider creating one at ./CLAUDE.md or ./.claude/CLAUDE.md');
  }

  // 2. Find or create Notes directory
  // Priority:
  //   1. Active session routing (pai route <project>) → routed Obsidian path
  //   2. Local Notes/ in cwd → use it (git-trackable, e.g. symlink to Obsidian)
  //   3. Central ~/.claude/projects/.../Notes/ → fallback
  const routedPath = getRoutedNotesPath();
  let notesDir: string;

  if (routedPath) {
    // Routing is active - use the configured Obsidian Notes path
    const { mkdirSync } = await import('fs');
    if (!existsSync(routedPath)) {
      mkdirSync(routedPath, { recursive: true });
      console.error(`Created routed Notes: ${routedPath}`);
    } else {
      console.error(`Notes directory: ${routedPath} (routed via pai route)`);
    }
    notesDir = routedPath;
  } else {
    const notesInfo = findNotesDir(cwd);

    if (notesInfo.isLocal) {
      notesDir = notesInfo.path;
      console.error(`Notes directory: ${notesDir} (local)`);
    } else {
      // Create central Notes directory
      if (!existsSync(notesInfo.path)) {
        const { mkdirSync } = await import('fs');
        mkdirSync(notesInfo.path, { recursive: true });
        console.error(`Created central Notes: ${notesInfo.path}`);
      } else {
        console.error(`Notes directory: ${notesInfo.path} (central)`);
      }
      notesDir = notesInfo.path;
    }
  }

  // 3. Cleanup old .jsonl files from project root (move to sessions/)
  // Keep the newest one for potential resume, move older ones to sessions/
  const projectDir = getProjectDir(cwd);
  if (existsSync(projectDir)) {
    try {
      const files = readdirSync(projectDir);
      const jsonlFiles = files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: join(projectDir, f),
          mtime: statSync(join(projectDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      if (jsonlFiles.length > 1) {
        const { mkdirSync, renameSync } = await import('fs');
        const sessionsDir = join(projectDir, 'sessions');
        if (!existsSync(sessionsDir)) {
          mkdirSync(sessionsDir, { recursive: true });
        }

        // Move all except the newest
        for (let i = 1; i < jsonlFiles.length; i++) {
          const file = jsonlFiles[i];
          const destPath = join(sessionsDir, file.name);
          if (!existsSync(destPath)) {
            renameSync(file.path, destPath);
            console.error(`Moved old session: ${file.name} → sessions/`);
          }
        }
      }
    } catch (error) {
      console.error(`Could not cleanup old .jsonl files: ${error}`);
    }
  }

  // 4. Find or create TODO.md
  const todoPath = findTodoPath(cwd);
  const hasTodo = existsSync(todoPath);
  if (hasTodo) {
    console.error(`TODO.md: ${todoPath}`);
  } else {
    // Create TODO.md in the Notes directory
    const newTodoPath = join(notesDir, 'TODO.md');
    const { writeFileSync } = await import('fs');
    writeFileSync(newTodoPath, `# TODO\n\n## Offen\n\n- [ ] \n\n---\n\n*Created: ${new Date().toISOString()}*\n`);
    console.error(`Created TODO.md: ${newTodoPath}`);
  }

  // 5. Check for existing note or create new one
  let activeNotePath: string | null = null;

  if (notesDir) {  // notesDir is always set now (local or central)
    const currentNotePath = getCurrentNotePath(notesDir);

    // Only create a new note if there is truly no note at all.
    // A completed note is still used — it will be updated or continued.
    // This prevents duplicate notes at month boundaries and on every compaction.
    if (!currentNotePath) {
      // Defensive: ensure projectName is a usable string
      const safeProjectName = (typeof projectName === 'string' && projectName.trim().length > 0)
        ? projectName.trim()
        : 'Untitled Session';
      console.error('\nNo previous session notes found - creating new one');
      activeNotePath = createSessionNote(notesDir, String(safeProjectName));
      console.error(`Created: ${basename(activeNotePath)}`);
    } else {
      activeNotePath = currentNotePath!;
      console.error(`\nUsing existing session note: ${basename(activeNotePath)}`);
      // Show preview of current note
      try {
        const content = readFileSync(activeNotePath, 'utf-8');
        const lines = content.split('\n').slice(0, 12);
        console.error('--- Current Note Preview ---');
        for (const line of lines) {
          console.error(line);
        }
        console.error('--- End Preview ---\n');
      } catch {
        // Ignore read errors
      }
    }
  }

  // 6. Show TODO.md preview
  if (existsSync(todoPath)) {
    try {
      const todoContent = readFileSync(todoPath, 'utf-8');
      const todoLines = todoContent.split('\n').filter(l => l.includes('[ ]')).slice(0, 5);
      if (todoLines.length > 0) {
        console.error('\nOpen TODOs:');
        for (const line of todoLines) {
          console.error(`   ${line.trim()}`);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // 7. Send ntfy.sh notification (MANDATORY)
  await sendNtfyNotification(`Session started in ${projectName}`);

  // 7.5. Run pai project detect to identify the registered PAI project
  const paiBin = findPaiBinary();
  let paiProjectBlock = '';
  try {
    const { execFileSync } = await import('child_process');
    const raw = execFileSync(paiBin, ['project', 'detect', '--json', cwd], {
      encoding: 'utf-8',
      env: process.env,
    }).trim();

    if (raw) {
      const detected = JSON.parse(raw) as {
        slug?: string;
        display_name?: string;
        root_path?: string;
        match_type?: string;
        relative_path?: string | null;
        session_count?: number;
        status?: string;
        error?: string;
        cwd?: string;
      };

      if (detected.error === 'no_match') {
        // Attempt auto-registration if the directory looks like a real project
        let autoRegistered = false;

        if (!isGuardedPath(cwd) && hasProjectSignals(cwd)) {
          try {
            execFileSync(paiBin, ['project', 'add', cwd], {
              encoding: 'utf-8',
              env: process.env,
            });
            console.error(`PAI auto-registered project at: ${cwd}`);

            // Re-run detect to get the proper detection result
            try {
              const raw2 = execFileSync(paiBin, ['project', 'detect', '--json', cwd], {
                encoding: 'utf-8',
                env: process.env,
              }).trim();

              if (raw2) {
                const detected2 = JSON.parse(raw2) as typeof detected;
                if (detected2.slug) {
                  const name2 = detected2.display_name || detected2.slug;
                  console.error(`PAI auto-registered: "${detected2.slug}" (${detected2.match_type})`);
                  paiProjectBlock = `PAI Project Registry: ${name2} (slug: ${detected2.slug}) [AUTO-REGISTERED]
Match: ${detected2.match_type ?? 'exact'} | Sessions: 0`;
                  autoRegistered = true;
                }
              }
            } catch (detectErr) {
              console.error('PAI auto-registration: project added but re-detect failed:', detectErr);
              autoRegistered = true; // project IS registered, just can't load context
            }
          } catch (addErr) {
            console.error('PAI auto-registration failed (project add):', addErr);
          }
        }

        if (!autoRegistered) {
          paiProjectBlock = `PAI Project Registry: No registered project matches this directory.
Run "pai project add ." to register this project, or use /route to tag the session.`;
          console.error('PAI detect: no match for', cwd);
        }
      } else if (detected.slug) {
        const name = detected.display_name || detected.slug;
        const nameSlug = ` (slug: ${detected.slug})`;
        const matchDesc = detected.match_type === 'exact'
          ? 'exact'
          : `parent (+${detected.relative_path ?? ''})`;
        const statusFlag = detected.status && detected.status !== 'active'
          ? ` [${detected.status.toUpperCase()}]`
          : '';
        paiProjectBlock = `PAI Project Registry: ${name}${statusFlag}${nameSlug}
Match: ${matchDesc} | Sessions: ${detected.session_count ?? 0}${detected.status && detected.status !== 'active' ? `\nWARNING: Project status is "${detected.status}". Run: pai project health --fix` : ''}`;
        console.error(`PAI detect: matched "${detected.slug}" (${detected.match_type})`);
      }
    }
  } catch (e) {
    // Non-fatal — don't break session start if pai is unavailable
    console.error('pai project detect failed:', e);
  }

  // 8. Output system reminder with session info
  const reminder = `
<system-reminder>
PROJECT CONTEXT LOADED

Project: ${projectName}
Working Directory: ${cwd}
${notesDir ? `Notes Directory: ${notesDir}${routedPath ? ' (routed via pai route)' : ''}` : 'Notes: disabled (no local Notes/ directory)'}
${hasTodo ? `TODO: ${todoPath}` : 'TODO: not found'}
${claudeMdPaths.length > 0 ? `CLAUDE.md: ${claudeMdPaths.join(', ')}` : 'No CLAUDE.md found'}
${activeNotePath ? `Active Note: ${basename(activeNotePath)}` : ''}
${routedPath ? `\nNote Routing: ACTIVE (pai route is set - notes go to Obsidian vault)` : ''}
${paiProjectBlock ? `\n${paiProjectBlock}` : ''}
Session Commands:
- "pause session" → Save checkpoint, update TODO, exit (no compact)
- "end session" → Finalize note, commit if needed, start fresh next time
- "pai route clear" → Clear note routing (in a new session)
</system-reminder>
`;

  // Output to stdout for Claude to receive
  console.log(reminder);

  // 9. INJECT CLAUDE.md contents as system-reminders
  // This ensures Claude actually reads and processes the instructions
  for (const { path, content } of claudeMdContents) {
    const claudeMdReminder = `
<system-reminder>
LOCAL CLAUDE.md LOADED (MANDATORY - READ AND FOLLOW)

Source: ${path}

${content}

---
THE ABOVE INSTRUCTIONS ARE MANDATORY. Follow them exactly.
</system-reminder>
`;
    console.log(claudeMdReminder);
    console.error(`Injected CLAUDE.md content from: ${path}`);
  }

  console.error('\nProject context setup complete\n');
  process.exit(0);
}

main().catch(error => {
  console.error('load-project-context.ts error:', error);
  process.exit(0); // Don't block session start
});
