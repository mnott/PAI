/**
 * Entry point for the project-utils/ sub-module directory.
 * Re-exports the full public API.
 */

export {
  PAI_DIR,
  PROJECTS_DIR,
  isProbeSession,
  encodePath,
  getProjectDir,
  getNotesDir,
  findNotesDir,
  getSessionsDir,
  getSessionsDirFromProjectDir,
  ensureNotesDir,
  ensureNotesDirSmart,
  ensureSessionsDir,
  ensureSessionsDirFromProjectDir,
  moveSessionFilesToSessionsDir,
  findTodoPath,
  findClaudeMdPath,
  findAllClaudeMdPaths,
} from "./paths.js";

export { isWhatsAppEnabled, sendNtfyNotification } from "./notify.js";

export {
  getNextNoteNumber,
  getCurrentNotePath,
  createSessionNote,
  appendCheckpoint,
  addWorkToSessionNote,
  sanitizeForFilename,
  extractMeaningfulName,
  renameSessionNote,
  updateSessionNoteTitle,
  finalizeSessionNote,
} from "./session-notes.js";
export type { WorkItem } from "./session-notes.js";

export { calculateSessionTokens } from "./tokens.js";

export {
  ensureTodoMd,
  updateTodoMd,
  addTodoCheckpoint,
  updateTodoContinue,
} from "./todo.js";
export type { TodoItem } from "./todo.js";
