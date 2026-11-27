import { renderInstructions } from "../harness/instructions.js";

/** The MCP server's instructions (Claude Code); other harnesses render their own from the same source. */
export const PAI_INSTRUCTIONS = renderInstructions("claude-code");
