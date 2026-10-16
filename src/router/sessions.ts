/**
 * sessions.ts — Claude Code session id → display name, from PAI data only:
 * worker status files (claudeSession → label) and the agent-session registry
 * (session id → project). Unknown ids map to null.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionInfo {
  /** display name */
  name: string;
  /** worker id when the session is a worker run */
  worker?: string;
  state?: string;
  /** worker outcome: ok, failed, or the raw state while running */
  verdict?: string;
  provider?: string;
}

export interface SessionSources {
  workerDirs: string[];
  agentSessionsFile: string;
  /** Claude Code transcript root: <dir>/<encoded cwd>/<session id>.jsonl */
  projectsDir?: string;
}

export function defaultSources(): SessionSources {
  const home = homedir();
  return {
    workerDirs: [join(home, ".claude", "pai", "logs", "workers"), join(home, ".claude", "logs", "workers")],
    agentSessionsFile: join(home, ".claude", "pai", "agent-sessions.json"),
    projectsDir: join(home, ".claude", "projects"),
  };
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function workerVerdict(s: Record<string, unknown>): string {
  if (s.state !== "done" && s.state !== "failed" && s.state !== "error") return String(s.state ?? "?");
  if (s.state !== "done" || (typeof s.rc === "number" && s.rc !== 0) || s.reportValid === false) return "failed";
  return "ok";
}

/** Full map session id → info. Reads every status file once; callers cache it. */
export function loadSessionMap(src: SessionSources = defaultSources()): Map<string, SessionInfo> {
  const map = new Map<string, SessionInfo>();
  const agents = existsSync(src.agentSessionsFile) ? readJson(src.agentSessionsFile) : undefined;
  if (agents) for (const [id, name] of Object.entries(agents)) if (typeof name === "string") map.set(id, { name });
  for (const dir of src.workerDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".status")) continue;
      const s = readJson(join(dir, f));
      if (!s || typeof s.claudeSession !== "string") continue;
      map.set(s.claudeSession, {
        name: typeof s.label === "string" && s.label ? s.label : String(s.id ?? f),
        worker: typeof s.id === "string" ? s.id : undefined,
        state: typeof s.state === "string" ? s.state : undefined,
        verdict: workerVerdict(s),
        provider: typeof s.provider === "string" ? s.provider : undefined,
      });
    }
  }
  // Last resort for interactive sessions the registry does not list: the project directory of the transcript.
  if (src.projectsDir && existsSync(src.projectsDir)) {
    for (const d of readdirSync(src.projectsDir)) {
      const name = d.split("-").filter(Boolean).pop();
      if (!name) continue;
      let files: string[] = [];
      try {
        files = readdirSync(join(src.projectsDir, d));
      } catch {
        continue;
      }
      for (const f of files) {
        const id = f.endsWith(".jsonl") ? f.slice(0, -6) : "";
        if (id && !map.has(id)) map.set(id, { name });
      }
    }
  }
  return map;
}

/** Display name of a session id, null when PAI does not know it. */
export function sessionDisplayName(id: string | undefined, map: Map<string, SessionInfo> = loadSessionMap()): string | null {
  return (id && map.get(id)?.name) || null;
}
