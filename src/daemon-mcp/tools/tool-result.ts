/** The MCP text-result shape and its two constructors, shared by the daemon-mcp tool modules. */

export type WorkerToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export const text = (s: string): WorkerToolResult => ({ content: [{ type: "text", text: s }] });
export const error = (e: unknown): WorkerToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});
