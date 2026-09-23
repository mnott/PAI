/**
 * IPC protocol types for the PAI daemon.
 */

/** Inbound request from an MCP shim over the Unix Domain Socket. */
export interface IpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Outbound response from the daemon. */
export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
