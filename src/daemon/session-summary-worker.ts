/**
 * session-summary-worker.ts — AI-powered session note generation
 *
 * Processes `session-summary` work items by:
 *   1. Finding the current session's JSONL transcript
 *   2. Extracting user messages and assistant context
 *   3. Gathering git commits from the session period
 *   4. Spawning Claude (sonnet for compaction, opus for session end) to generate a structured summary
 *   5. Writing the summary to the project's session note
 *
 * Designed to run inside the daemon's work queue worker. All errors are
 * thrown (not swallowed) so the work queue retry logic handles them.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import {
  findNotesDir,
  getCurrentNotePath,
  createSessionNote,
  addWorkToSessionNote,
  renameSessionNote,
} from "../hooks/ts/lib/project-utils/index.js";

import { buildSessionSummaryPrompt } from "./templates/session-summary-prompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between summaries for the same project (ms). */
const SUMMARY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum JSONL content to feed to the summarizer (characters). */
/** Max JSONL chars per model. Opus/Sonnet can handle much more than Haiku. */
const MAX_JSONL_CHARS: Record<string, number> = {
  haiku: 50_000,
  sonnet: 200_000,
  opus: 500_000,
};

/** Maximum user messages to include in the prompt. */
const MAX_USER_MESSAGES = 30;

/** Timeout for the claude CLI process (ms). */
const CLAUDE_TIMEOUT_MS: Record<string, number> = {
  haiku: 60_000,    // 60 seconds
  sonnet: 120_000,  // 2 minutes
  opus: 300_000,    // 5 minutes — opus is thorough
};

/** File tracking last summary timestamps per project. */
const COOLDOWN_FILE = join(homedir(), ".config", "pai", "summary-cooldowns.json");

/** Claude Code projects directory. */
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummaryPayload {
  cwd: string;
  sessionId?: string;
  projectSlug?: string;
  transcriptPath?: string;
  /** If true, bypass the cooldown check (e.g. triggered by stop-hook at session end). */
  force?: boolean;
  /** Model to use for summarization. Defaults based on trigger:
   *  - "stop" trigger (session end): "opus" for best quality final summary
   *  - "compact" trigger (auto-compaction): "sonnet" for incremental checkpoints
   *  - Manual/reconstruct: "sonnet" for batch processing */
  model?: "haiku" | "sonnet" | "opus";
}

// ---------------------------------------------------------------------------
// Cooldown tracking
// ---------------------------------------------------------------------------

function loadCooldowns(): Record<string, number> {
  try {
    if (existsSync(COOLDOWN_FILE)) {
      return JSON.parse(readFileSync(COOLDOWN_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveCooldowns(cooldowns: Record<string, number>): void {
  try {
    writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2), "utf-8");
  } catch { /* ignore */ }
}

function isOnCooldown(cwd: string): boolean {
  const cooldowns = loadCooldowns();
  const lastRun = cooldowns[cwd];
  if (!lastRun) return false;
  return Date.now() - lastRun < SUMMARY_COOLDOWN_MS;
}

function markCooldown(cwd: string): void {
  const cooldowns = loadCooldowns();
  cooldowns[cwd] = Date.now();
  // Prune entries older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const key of Object.keys(cooldowns)) {
    if (cooldowns[key] < cutoff) delete cooldowns[key];
  }
  saveCooldowns(cooldowns);
}

// ---------------------------------------------------------------------------
// JSONL discovery
// ---------------------------------------------------------------------------

/**
 * Encode a cwd path the same way Claude Code does for its project directories.
 * Replaces /, space, dot, and hyphen with -.
 */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[\/\s.\-]/g, "-");
}

/**
 * Find the most recently modified JSONL file for the given project.
 *
 * Claude Code stores transcripts in:
 *   ~/.claude/projects/<encoded-path>/sessions/*.jsonl
 *   ~/.claude/projects/<encoded-path>/<uuid>.jsonl (legacy)
 */
function findLatestJsonl(cwd: string): string | null {
  const encoded = encodeProjectPath(cwd);
  const projectDir = join(CLAUDE_PROJECTS_DIR, encoded);

  if (!existsSync(projectDir)) {
    process.stderr.write(
      `[session-summary] No Claude project dir found: ${projectDir}\n`
    );
    return null;
  }

  // Collect all JSONL candidates
  const candidates: Array<{ path: string; mtime: number }> = [];

  // Check sessions/ subdirectory first (current layout)
  const sessionsDir = join(projectDir, "sessions");
  if (existsSync(sessionsDir)) {
    try {
      for (const f of readdirSync(sessionsDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fullPath = join(sessionsDir, f);
        try {
          const st = statSync(fullPath);
          candidates.push({ path: fullPath, mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Also check top-level for legacy .jsonl files
  try {
    for (const f of readdirSync(projectDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const fullPath = join(projectDir, f);
      try {
        const st = statSync(fullPath);
        candidates.push({ path: fullPath, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (candidates.length === 0) {
    process.stderr.write(
      `[session-summary] No JSONL files found in ${projectDir}\n`
    );
    return null;
  }

  // Sort by modification time descending — pick the most recent
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

// ---------------------------------------------------------------------------
// JSONL content extraction
// ---------------------------------------------------------------------------

interface ExtractedContent {
  userMessages: string[];
  filesModified: string[];
  sessionStartTime: string;
}

/**
 * Parse a JSONL transcript and extract relevant content.
 * Filters noise, truncates to model-appropriate size from the end of the file.
 */
function extractFromJsonl(jsonlPath: string, model: string = "sonnet"): ExtractedContent {
  const result: ExtractedContent = {
    userMessages: [],
    filesModified: [],
    sessionStartTime: "",
  };

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch (e) {
    throw new Error(`Could not read JSONL at ${jsonlPath}: ${e}`);
  }

  // Truncate from the start if too large (keep the most recent content)
  const maxChars = MAX_JSONL_CHARS[model] ?? 200_000;
  if (raw.length > maxChars) {
    const truncPoint = raw.indexOf("\n", raw.length - maxChars);
    raw = truncPoint >= 0 ? raw.slice(truncPoint + 1) : raw.slice(-MAX_JSONL_CHARS);
  }

  const lines = raw.trim().split("\n");
  const seenMessages = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Track earliest timestamp
    if (entry.timestamp && !result.sessionStartTime) {
      result.sessionStartTime = String(entry.timestamp);
    }

    // Extract user messages
    if (entry.type === "user") {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg?.content) {
        const text = contentToText(msg.content);
        if (text && !isNoise(text) && !seenMessages.has(text)) {
          seenMessages.add(text);
          result.userMessages.push(text.slice(0, 500));
        }
      }
    }

    // Extract file modifications from assistant tool_use blocks
    if (entry.type === "assistant") {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use") {
            const name = block.name as string;
            const input = block.input as Record<string, unknown> | undefined;
            if ((name === "Edit" || name === "Write") && input?.file_path) {
              const fp = String(input.file_path);
              if (!result.filesModified.includes(fp)) {
                result.filesModified.push(fp);
              }
            }
          }
        }
      }
    }
  }

  // Limit user messages
  if (result.userMessages.length > MAX_USER_MESSAGES) {
    result.userMessages = result.userMessages.slice(-MAX_USER_MESSAGES);
  }

  return result;
}

/** Convert Claude content (string or content block array) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        const block = c as Record<string, unknown>;
        if (block?.text) return String(block.text);
        if (block?.content) return String(block.content);
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

/** Filter out noise entries that shouldn't be included in the summary. */
function isNoise(text: string): boolean {
  if (!text || text.length < 3) return true;
  if (text.includes("<task-notification>")) return true;
  if (text.includes("[object Object]")) return true;
  if (text.startsWith("<system-reminder>")) return true;
  if (/^(yes|ok|sure|go|continue|weiter|thanks|thank you)\.?$/i.test(text.trim())) return true;
  // Skip pure tool result blocks
  if (text.startsWith("Tool Result:") || text.startsWith("tool_result")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Git context
// ---------------------------------------------------------------------------

/**
 * Get git log for the session period.
 * Falls back gracefully if git is not available or the dir is not a repo.
 */
async function getGitContext(cwd: string, sinceTime?: string): Promise<string> {
  let since = "6 hours ago";
  if (sinceTime) {
    // sinceTime may be a Unix epoch (seconds as string) or already ISO 8601
    const asNum = Number(sinceTime);
    if (!isNaN(asNum) && asNum > 1_000_000_000) {
      // Unix epoch seconds → ISO 8601 (git accepts this unambiguously)
      since = new Date(asNum * 1000).toISOString();
    } else {
      since = sinceTime;
    }
  }

  try {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);

    const { stdout } = await execFileAsync(
      "git",
      ["log", "--format=%h %ai %s", `--since=${since}`, "--stat", "--no-color"],
      {
        cwd,
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Claude CLI spawning
// ---------------------------------------------------------------------------

/**
 * Find the `claude` CLI binary.
 * Checks PATH first, then common installation locations.
 */
function findClaudeBinary(): string | null {
  // Check known locations first (launchd PATH is minimal, bare "claude" won't resolve)
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* skip */ }
  }

  // Last resort: try bare "claude" in case PATH has it
  return "claude";
}

/**
 * Spawn a Claude model via the CLI to generate a session summary.
 * Pipes the prompt via stdin. Model selection:
 *   - opus: session end (best quality for final summary, runs once)
 *   - sonnet: auto-compaction (good quality for incremental checkpoints, runs often)
 *   - haiku: fallback / budget mode
 * Returns the generated text, or null if spawning fails.
 */
async function spawnSummarizer(prompt: string, model: string = "sonnet"): Promise<string | null> {
  const claudeBin = findClaudeBinary();
  if (!claudeBin) {
    process.stderr.write(
      "[session-summary] Claude CLI not found in PATH or common locations.\n"
    );
    return null;
  }

  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(claudeBin, ["--model", model, "-p", "--no-session-persistence"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      if (timer) { clearTimeout(timer); timer = null; }
      process.stderr.write(`[session-summary] ${model} spawn error: ${err.message}\n`);
      resolve(null);
    });

    child.on("close", (code: number | null) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (code !== 0) {
        process.stderr.write(
          `[session-summary] ${model} exited with code ${code}: ${stderr.slice(0, 300)}\n`
        );
        resolve(null);
      } else {
        resolve(stdout.trim() || null);
      }
    });

    // Timeout protection
    timer = setTimeout(() => {
      process.stderr.write(`[session-summary] ${model} timed out — killing process.\n`);
      child.kill("SIGTERM");
      resolve(null);
    }, CLAUDE_TIMEOUT_MS[model] ?? 120_000);

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Session note writing
// ---------------------------------------------------------------------------

/**
 * Write (or update) the session note with the AI-generated summary.
 *
 * Strategy:
 *   - Find the current month's latest note
 *   - If it's from today, update it with the new summary
 *   - If it's from a different day, create a new note
 */
function writeSessionNote(
  cwd: string,
  summaryText: string,
  filesModified: string[]
): string | null {
  const notesInfo = findNotesDir(cwd);
  let notePath = getCurrentNotePath(notesInfo.path);

  const today = new Date().toISOString().split("T")[0];

  if (notePath) {
    const noteFilename = basename(notePath);
    // Check if this note is from today
    const dateMatch = noteFilename.match(/(\d{4}-\d{2}-\d{2})/);
    const noteDate = dateMatch ? dateMatch[1] : "";

    if (noteDate === today) {
      // Update existing note — replace the Work Done section with AI summary
      updateNoteWithSummary(notePath, summaryText);
      process.stderr.write(
        `[session-summary] Updated existing note: ${noteFilename}\n`
      );
    } else {
      // Different day — create a new note
      notePath = createNoteFromSummary(notesInfo.path, summaryText);
    }
  } else {
    // No note exists — create one
    notePath = createNoteFromSummary(notesInfo.path, summaryText);
  }

  // Try to rename with a meaningful title from the summary
  if (notePath) {
    const titleMatch = summaryText.match(/^# Session:\s*(.+)$/m);
    if (titleMatch) {
      const title = titleMatch[1].trim();
      if (title.length > 5 && title.length < 80) {
        const newPath = renameSessionNote(notePath, title);
        if (newPath !== notePath) {
          notePath = newPath;
        }
      }
    }
  }

  return notePath;
}

/**
 * Update an existing session note's Work Done section with AI-generated content.
 */
function updateNoteWithSummary(notePath: string, summaryText: string): void {
  if (!existsSync(notePath)) return;

  let content = readFileSync(notePath, "utf-8");

  // Extract the work items from the AI summary
  const workDoneMatch = summaryText.match(
    /## Work Done\n\n([\s\S]*?)(?=\n## Key Decisions|\n## Known Issues|\n\*\*Tags|\n$)/
  );

  if (workDoneMatch) {
    const aiWorkContent = workDoneMatch[1].trim();
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];

    // Add as a new subsection under Work Done
    const sectionHeader = `\n### AI Summary (${timestamp})\n\n${aiWorkContent}\n`;

    const nextStepsIdx = content.indexOf("## Next Steps");
    const knownIssuesIdx = content.indexOf("## Known Issues");
    const insertBefore = knownIssuesIdx !== -1 ? knownIssuesIdx :
                          nextStepsIdx !== -1 ? nextStepsIdx :
                          content.length;

    content = content.slice(0, insertBefore) + sectionHeader + "\n" + content.slice(insertBefore);
  }

  // Extract and add Key Decisions if present
  const decisionsMatch = summaryText.match(
    /## Key Decisions\n\n([\s\S]*?)(?=\n## Known Issues|\n\*\*Tags|\n$)/
  );
  if (decisionsMatch) {
    const decisions = decisionsMatch[1].trim();
    if (decisions && !content.includes("## Key Decisions")) {
      const nextStepsIdx = content.indexOf("## Next Steps");
      const insertAt = nextStepsIdx !== -1 ? nextStepsIdx : content.length;
      content = content.slice(0, insertAt) + `## Key Decisions\n\n${decisions}\n\n` + content.slice(insertAt);
    }
  }

  // Extract and add Known Issues if present
  const issuesMatch = summaryText.match(
    /## Known Issues\n\n([\s\S]*?)(?=\n\*\*Tags|\n$)/
  );
  if (issuesMatch) {
    const issues = issuesMatch[1].trim();
    if (issues && !content.includes("## Known Issues")) {
      const nextStepsIdx = content.indexOf("## Next Steps");
      const insertAt = nextStepsIdx !== -1 ? nextStepsIdx : content.length;
      content = content.slice(0, insertAt) + `## Known Issues\n\n${issues}\n\n` + content.slice(insertAt);
    }
  }

  writeFileSync(notePath, content, "utf-8");
}

/**
 * Create a brand new session note from the AI summary.
 */
function createNoteFromSummary(notesDir: string, summaryText: string): string | null {
  try {
    // Create the note with a placeholder title
    const notePath = createSessionNote(notesDir, "New Session");

    // We will overwrite the entire content with the AI-generated summary, preserving
    // the note number (derived from the filename) and adding the standard footer.
    const noteFilename = basename(notePath);
    const numberMatch = noteFilename.match(/^(\d+)/);
    const noteNumber = numberMatch ? numberMatch[1] : "0000";

    // Replace the H1 title from the AI summary with the numbered format
    const titleMatch = summaryText.match(/^# Session:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : "New Session";

    const date = new Date().toISOString().split("T")[0];

    // Build the final note content, merging AI output with the PAI note structure
    const aiBody = summaryText
      .replace(/^# Session:.*$/m, "")
      .replace(/^\*\*Date:\*\*.*$/m, "")
      .replace(/^\*\*Status:\*\*.*$/m, "")
      .replace(/^---$/m, "")
      .trim();

    const finalContent = `# Session ${noteNumber}: ${title}

**Date:** ${date}
**Status:** In Progress

---

${aiBody}

---

## Next Steps

<!-- To be filled at session end -->

---

**Tags:** #Session
`;

    writeFileSync(notePath, finalContent, "utf-8");
    process.stderr.write(`[session-summary] Created AI-powered note: ${noteFilename}\n`);
    return notePath;
  } catch (e) {
    process.stderr.write(`[session-summary] Failed to create note: ${e}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a `session-summary` work item.
 *
 * This is the main function called by work-queue-worker.ts.
 * Throws on fatal errors (work queue will retry with backoff).
 */
export async function handleSessionSummary(payload: SessionSummaryPayload): Promise<void> {
  const { cwd, sessionId, projectSlug, transcriptPath, force } = payload;

  if (!cwd) {
    throw new Error("session-summary payload missing cwd");
  }

  process.stderr.write(
    `[session-summary] Starting for ${cwd}` +
    `${sessionId ? ` (session=${sessionId})` : ""}` +
    `${force ? " (force=true)" : ""}\n`
  );

  // -------------------------------------------------------------------------
  // Cooldown check — don't summarize too frequently
  // force=true bypasses the cooldown (used by stop-hook at session end so a
  // final summary is always produced regardless of recent PreCompact runs).
  // -------------------------------------------------------------------------
  if (!force && isOnCooldown(cwd)) {
    process.stderr.write(
      "[session-summary] Skipping — last summary was less than 30 minutes ago.\n"
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Step 1: Find the JSONL transcript
  // -------------------------------------------------------------------------
  let jsonlPath: string | null = transcriptPath || null;

  if (jsonlPath && !existsSync(jsonlPath)) {
    process.stderr.write(
      `[session-summary] Provided transcript path not found: ${jsonlPath}\n`
    );
    jsonlPath = null;
  }

  if (!jsonlPath) {
    jsonlPath = findLatestJsonl(cwd);
  }

  if (!jsonlPath) {
    process.stderr.write(
      "[session-summary] No JSONL transcript found — skipping.\n"
    );
    return;
  }

  process.stderr.write(`[session-summary] Using transcript: ${jsonlPath}\n`);

  // -------------------------------------------------------------------------
  // Step 2: Extract content from the JSONL
  // -------------------------------------------------------------------------
  // Model selection: opus for session end (force=true), sonnet for auto-compact
  const selectedModel = payload.model ?? (force ? "opus" : "sonnet");
  const extracted = extractFromJsonl(jsonlPath, selectedModel);

  if (extracted.userMessages.length === 0) {
    process.stderr.write(
      "[session-summary] No user messages found in transcript — skipping.\n"
    );
    return;
  }

  process.stderr.write(
    `[session-summary] Extracted ${extracted.userMessages.length} user messages, ` +
    `${extracted.filesModified.length} modified files.\n`
  );

  // -------------------------------------------------------------------------
  // Step 3: Get git context
  // -------------------------------------------------------------------------
  const gitLog = await getGitContext(cwd, extracted.sessionStartTime);

  if (gitLog) {
    process.stderr.write(
      `[session-summary] Got git context (${gitLog.split("\n").length} lines).\n`
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Build and send prompt to summarizer
  // -------------------------------------------------------------------------
  const today = new Date().toISOString().split("T")[0];

  // Check for existing note to merge with
  const notesInfo = findNotesDir(cwd);
  const existingNotePath = getCurrentNotePath(notesInfo.path);
  let existingNote: string | undefined;

  if (existingNotePath) {
    const noteFilename = basename(existingNotePath);
    const dateMatch = noteFilename.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && dateMatch[1] === today) {
      try {
        existingNote = readFileSync(existingNotePath, "utf-8");
      } catch { /* ignore */ }
    }
  }

  const prompt = buildSessionSummaryPrompt({
    userMessages: extracted.userMessages,
    gitLog,
    cwd,
    date: today,
    filesModified: extracted.filesModified,
    existingNote,
  });

  process.stderr.write(
    `[session-summary] Sending ${prompt.length} char prompt to ${selectedModel}...\n`
  );

  const summaryText = await spawnSummarizer(prompt, selectedModel);

  if (!summaryText) {
    process.stderr.write(
      `[session-summary] ${selectedModel} did not produce output — falling back to mechanical checkpoint.\n`
    );
    // Don't throw — this is a soft failure. The existing PreCompact checkpoint
    // is sufficient. Just mark the cooldown so we don't retry too soon.
    markCooldown(cwd);
    return;
  }

  process.stderr.write(
    `[session-summary] ${selectedModel} produced ${summaryText.length} char summary.\n`
  );

  // -------------------------------------------------------------------------
  // Step 5: Write the session note
  // -------------------------------------------------------------------------
  const notePath = writeSessionNote(cwd, summaryText, extracted.filesModified);

  if (notePath) {
    process.stderr.write(
      `[session-summary] Session note written: ${basename(notePath)}\n`
    );
  }

  // Mark cooldown
  markCooldown(cwd);

  process.stderr.write("[session-summary] Done.\n");
}
