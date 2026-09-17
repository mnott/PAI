/** Type surface of ws-server.mjs for the TypeScript tests (the host itself is plain ESM, no build step). */

export declare const PAI_BROWSER_BRIDGE_PORT: number;

export declare function acceptKey(key: string): string;

export declare function encodeTextFrame(text: string): Buffer;

export declare function parseFrames(buffer: Buffer): {
  frames: Array<{ opcode: number; payload: Buffer }>;
  rest: Buffer;
};

export interface BridgeServer {
  server: import("node:net").Server;
  port: number;
  broadcast(text: string): void;
  close(): Promise<void>;
}

export declare function startBridgeServer(opts: {
  port?: number;
  onClientMessage?: (text: string) => void;
  onClientState?: (connected: boolean, count: number) => void;
}): Promise<BridgeServer>;
