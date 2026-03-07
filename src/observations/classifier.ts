/**
 * classifier.ts — Rule-based classifier for tool call events.
 *
 * Pure functions, no external dependencies, no I/O.
 * Takes a raw tool call event and returns a ClassifiedObservation,
 * or null for tools that should not be recorded.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawToolEvent {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  session_id?: string;
  cwd?: string;
}

export interface ClassifiedObservation {
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title: string;
  narrative?: string;
  tool_name: string;
  tool_input_summary?: string;
  files_read: string[];
  files_modified: string[];
  concepts: string[];
}

// ---------------------------------------------------------------------------
// Tools we deliberately skip
// ---------------------------------------------------------------------------

const SKIP_TOOLS = new Set([
  'AskUserQuestion',
  'ToolSearch',
  'mcp__aibroker__aibroker_speak',
  'mcp__aibroker__aibroker_voice_config',
  'mcp__aibroker__pailot_tts',
  'mcp__aibroker__whatsapp_tts',
  'mcp__aibroker__telegram_tts',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract concepts from a file path by splitting on directory separators
 * and filtering out common noise segments.
 *
 * e.g. src/hooks/ts/post-tool-use/observe.ts → ["hooks", "post-tool-use", "observe"]
 */
function conceptsFromPath(filePath: string): string[] {
  const NOISE = new Set(['src', 'dist', 'lib', 'index', 'ts', 'js', 'mjs', 'cjs', 'mts', 'cts']);
  return filePath
    .replace(/\.[^.]+$/, '') // strip extension
    .split(/[/\\]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !NOISE.has(s));
}

/**
 * Deduplicate an array preserving order.
 */
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Safely extract a string from an unknown value.
 */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Truncate a string to maxLen characters.
 */
function trunc(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

// ---------------------------------------------------------------------------
// Bash command analysis
// ---------------------------------------------------------------------------

interface BashAnalysis {
  type: ClassifiedObservation['type'];
  title: string;
  summary: string;
}

function analyzeBashCommand(cmd: string): BashAnalysis {
  const trimmed = cmd.trim();
  const first = trunc(trimmed, 80);

  // git commit
  const commitMatch = trimmed.match(/git\s+commit\s+(?:-\S+\s+)*(?:-m\s+["']?([^\n"']+))/);
  if (commitMatch) {
    const msg = commitMatch[1]?.trim() ?? 'commit';
    return { type: 'decision', title: `Committed: ${trunc(msg, 60)}`, summary: first };
  }

  // git push
  if (/git\s+push/.test(trimmed)) {
    return { type: 'decision', title: 'Pushed to remote', summary: first };
  }

  // tests
  if (/\b(jest|vitest|bun\s+test|npm\s+test|yarn\s+test|pnpm\s+test|deno\s+test|mocha|ava|tap)\b/.test(trimmed)) {
    return { type: 'feature', title: `Ran tests: ${trunc(trimmed, 60)}`, summary: first };
  }

  // build / compile
  if (/\b(tsc|bun\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+build|webpack|esbuild|rollup|vite\s+build|cargo\s+build|go\s+build|make\b)\b/.test(trimmed)) {
    return { type: 'feature', title: `Built project: ${trunc(trimmed, 60)}`, summary: first };
  }

  return { type: 'discovery', title: `Ran: ${first}`, summary: first };
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classify a raw tool call event into a structured observation.
 * Returns null for tools that should be silently ignored.
 */
export function classifyToolEvent(event: RawToolEvent): ClassifiedObservation | null {
  const { tool_name, tool_input = {} } = event;

  // Skip tools we don't want to record
  if (SKIP_TOOLS.has(tool_name)) return null;

  const filesRead: string[] = [];
  const filesModified: string[] = [];
  let type: ClassifiedObservation['type'] = 'discovery';
  let title = '';
  let summary: string | undefined;

  // -------------------------------------------------------------------------
  // Dispatch by tool name
  // -------------------------------------------------------------------------

  if (tool_name === 'Edit') {
    const filePath = str(tool_input['file_path'] ?? tool_input['path']);
    filesModified.push(filePath);
    type = 'change';
    title = `Modified ${filePath}`;
    summary = filePath;
  } else if (tool_name === 'Write') {
    const filePath = str(tool_input['file_path'] ?? tool_input['path']);
    filesModified.push(filePath);
    type = 'change';
    title = `Created ${filePath}`;
    summary = filePath;
  } else if (tool_name === 'Read') {
    const filePath = str(tool_input['file_path'] ?? tool_input['path']);
    filesRead.push(filePath);
    type = 'discovery';
    title = `Read ${filePath}`;
    summary = filePath;
  } else if (tool_name === 'Grep') {
    const pattern = str(tool_input['pattern'] ?? tool_input['query'] ?? '');
    const filePath = str(tool_input['path'] ?? tool_input['include'] ?? '');
    if (filePath) filesRead.push(filePath);
    type = 'discovery';
    title = `Searched for '${trunc(pattern, 60)}'`;
    summary = pattern;
  } else if (tool_name === 'Glob') {
    const pattern = str(tool_input['pattern'] ?? '');
    type = 'discovery';
    title = `Found files matching '${trunc(pattern, 60)}'`;
    summary = pattern;
  } else if (tool_name === 'Bash') {
    const cmd = str(tool_input['command'] ?? '');
    const analysis = analyzeBashCommand(cmd);
    type = analysis.type;
    title = analysis.title;
    summary = analysis.summary;
  } else if (tool_name === 'Task' || tool_name === 'Agent') {
    const description = str(
      tool_input['description'] ?? tool_input['prompt'] ?? tool_input['task'] ?? ''
    );
    type = 'discovery';
    title = `Delegated: ${trunc(description, 80)}`;
    summary = description;
  } else if (tool_name === 'WebFetch') {
    const url = str(tool_input['url'] ?? '');
    type = 'discovery';
    title = `Fetched: ${trunc(url, 80)}`;
    summary = url;
  } else if (tool_name === 'WebSearch' || tool_name === 'mcp__webfetch__web_search') {
    const query = str(tool_input['query'] ?? tool_input['q'] ?? '');
    type = 'discovery';
    title = `Fetched: ${trunc(query, 80)}`;
    summary = query;
  } else if (tool_name === 'mcp__webfetch__web_fetch') {
    const url = str(tool_input['url'] ?? '');
    type = 'discovery';
    title = `Fetched: ${trunc(url, 80)}`;
    summary = url;
  } else if (tool_name.startsWith('mcp__')) {
    type = 'discovery';
    title = `Used MCP tool: ${tool_name}`;
    summary = tool_name;
  } else {
    // Catch-all
    type = 'discovery';
    title = `Used tool: ${tool_name}`;
    summary = tool_name;
  }

  // -------------------------------------------------------------------------
  // Concepts: derived from all file paths involved
  // -------------------------------------------------------------------------
  const allPaths = [...filesRead, ...filesModified];
  const concepts = dedupe(allPaths.flatMap(conceptsFromPath));

  return {
    type,
    title,
    tool_name,
    tool_input_summary: summary,
    files_read: filesRead.filter(Boolean),
    files_modified: filesModified.filter(Boolean),
    concepts,
  };
}
