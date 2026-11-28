import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_URI = "skill://pai/SKILL.md";
export const SKILL_PROMPT = "pai-skill";

/** skills/PAI/SKILL.md, found by walking up from this module (src/daemon-mcp, dist/daemon-mcp or a dist chunk). */
export function skillPath(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "skills", "PAI", "SKILL.md");
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error("skills/PAI/SKILL.md not found next to the pai package");
}

/** The single source: the file itself, read per request. */
export function readSkill(): string {
  return readFileSync(skillPath(), "utf8");
}
