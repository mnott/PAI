#!/usr/bin/env node
/**
 * Tab Title Update on Action Tools
 * Updates Kitty tab title when action tools complete (Edit, Write, Bash, Task)
 * Uses the tool's description directly - no AI call needed
 *
 * PAI-safe: No sensitive data, just tool descriptions
 */

import { execSync } from 'child_process';

// Action tools that warrant a tab title update
const ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'Bash',
  'Task',
  'NotebookEdit',
  'MultiEdit'
]);

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    description?: string;
    command?: string;
    file_path?: string;
    prompt?: string;
    subagent_type?: string;
  };
  tool_response?: unknown;
  hook_event_name: string;
}

/**
 * Read stdin with timeout
 */
async function readStdinWithTimeout(timeout: number = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      reject(new Error('Timeout'));
    }, timeout);

    process.stdin.on('data', (chunk) => {
      data += chunk.toString();
    });

    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });

    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Update Kitty tab title using escape codes
 */
function setTabTitle(title: string): void {
  try {
    // Truncate to reasonable length
    const truncated = title.length > 50 ? title.slice(0, 47) + '...' : title;
    const escaped = truncated.replace(/'/g, "'\\''");

    // Multiple escape sequences for compatibility
    execSync(`printf '\\033]0;${escaped}\\007' >&2`, { stdio: ['pipe', 'pipe', 'inherit'] });
    execSync(`printf '\\033]2;${escaped}\\007' >&2`, { stdio: ['pipe', 'pipe', 'inherit'] });
    execSync(`printf '\\033]30;${escaped}\\007' >&2`, { stdio: ['pipe', 'pipe', 'inherit'] });
  } catch {
    // Silently fail - don't interrupt Claude's work
  }
}

/**
 * Generate a human-readable title from tool input
 */
function generateTitle(toolName: string, input: HookInput['tool_input']): string {
  // Use explicit description if provided
  if (input.description) {
    return input.description;
  }

  // Generate based on tool type
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      if (input.file_path) {
        const filename = input.file_path.split('/').pop() || input.file_path;
        return `Editing ${filename}`;
      }
      return `Editing file`;

    case 'Bash':
      if (input.command) {
        // Extract first command word
        const cmd = input.command.split(/\s+/)[0].split('/').pop() || 'command';
        return `Running ${cmd}`;
      }
      return 'Running command';

    case 'Task':
      if (input.subagent_type) {
        return `Agent: ${input.subagent_type}`;
      }
      if (input.prompt) {
        const words = input.prompt.slice(0, 30).split(/\s+/).slice(0, 3).join(' ');
        return `Task: ${words}...`;
      }
      return 'Spawning agent';

    default:
      return `${toolName}...`;
  }
}

async function main() {
  try {
    const input = await readStdinWithTimeout();
    const data: HookInput = JSON.parse(input);

    // Only process action tools
    if (!ACTION_TOOLS.has(data.tool_name)) {
      process.exit(0);
    }

    // Generate and set title
    const title = generateTitle(data.tool_name, data.tool_input);
    setTabTitle(title);

    process.exit(0);
  } catch {
    // Silently exit - don't interrupt Claude's flow
    process.exit(0);
  }
}

main();
