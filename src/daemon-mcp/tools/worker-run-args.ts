/**
 * worker_run's input schema and prompt resolution, extracted so both can be
 * imported and tested without starting the shim's stdio transport.
 */

import { z } from "zod";
import { readSpecPrompt, resolveSpecPath } from "../../workers/specfile.js";

export const workerRunShape = {
  prompt: z.string().min(1).optional().describe("The task (the -p value). Mutually exclusive with specPath."),
  specPath: z
    .string()
    .min(1)
    .optional()
    .describe('Path to a file (or "-" for stdin) whose contents become the prompt. Mutually exclusive with prompt.'),
  chain: z.string().optional().describe("Comma-separated stages, e.g. draft,implement or draft,implement,review."),
  class: z.string().optional().describe("Task class (draft, implement, review, research, spotcheck, simple, complex, image)."),
  label: z.string().min(1).describe("Short task label shown in worker_ps / the status line and worker pane."),
  cwd: z.string().optional().describe("Working directory (default: here)."),
  allowed_tools: z.string().optional().describe("Comma-separated tool allowlist passed to the worker."),
  mcp: z.string().optional().describe("MCP servers/sets the worker may use (comma-separated)."),
};

export type WorkerRunArgs = z.infer<z.ZodObject<typeof workerRunShape>>;

/**
 * The prompt text and resolved --spec path (for status recording) a
 * worker_run call resolves to. Throws when prompt/specPath are both given or
 * both missing (mutually exclusive, exactly one required) — the same rule
 * `pai worker run` enforces between -p and --spec.
 */
export function resolveWorkerRunPrompt(
  args: Pick<WorkerRunArgs, "prompt" | "specPath">,
  cwd: string
): { promptText: string; specPath?: string } {
  if (Boolean(args.prompt) === Boolean(args.specPath)) {
    throw new Error("exactly one of prompt or specPath is required (they are mutually exclusive)");
  }
  if (args.specPath) {
    return { promptText: readSpecPrompt(args.specPath, cwd), specPath: resolveSpecPath(args.specPath, cwd) };
  }
  return { promptText: args.prompt as string };
}
