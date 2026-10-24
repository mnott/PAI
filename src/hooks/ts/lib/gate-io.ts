/** I/O shared by the PreToolUse gate hooks: read the payload, allow silently, deny and exit. */

import { renderDecision } from "./render-decision.js";

/** Parse the hook's JSON stdin; null when unreadable, empty or malformed (the gate then allows). */
export async function readGateInput<T>(): Promise<T | null> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function allow(): void {
  process.exit(0);
}

export function deny(reason: string): void {
  process.stdout.write(renderDecision({ decision: "deny", reason }) + "\n");
  process.exit(0);
}
