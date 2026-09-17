/**
 * WebSocket client for the browser bridge.
 *
 * Talks to the native host's hand-rolled WS server (ws://127.0.0.1:8756) with
 * the global WebSocket — node >= 22, no external dependency. Requests carry an
 * id; replies are correlated by it. The socket is connected lazily per call
 * and reconnected on demand, so the server survives Chrome being closed.
 */

export const BRIDGE_PORT = Number(process.env.PAI_BROWSER_BRIDGE_PORT || 8756);
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;

export const NOT_CONNECTED_MESSAGE =
  "Chrome bridge not connected — start Chrome (the PAI browser-bridge extension must be running) and try again.";

/** Minimal shape of the pieces of WebSocket this client uses. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const globalWebSocketFactory: WebSocketFactory = (url) => {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new Error(
      "this node runtime has no global WebSocket — pai-browser-mcp needs node >= 22"
    );
  }
  return new WS(url);
};

export class NotConnectedError extends Error {
  constructor() {
    super(NOT_CONNECTED_MESSAGE);
    this.name = "NotConnectedError";
  }
}

export interface BridgeReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const OPEN = 1;

export class BridgeClient {
  private socket: WebSocketLike | null = null;
  private connecting: Promise<WebSocketLike> | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: BridgeReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly url: string = BRIDGE_URL,
    private readonly socketFactory: WebSocketFactory = globalWebSocketFactory
  ) {}

  /** True when the underlying socket is open. */
  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  private ensureSocket(): Promise<WebSocketLike> {
    if (this.socket && this.socket.readyState === OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting; // concurrent sends share one socket
    this.dropSocket();
    const attempt = new Promise<WebSocketLike>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = this.socketFactory(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        reject(new NotConnectedError());
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(socket);
      };
      socket.onclose = () => {
        clearTimeout(timer);
        this.dropSocket();
        reject(new NotConnectedError());
      };
      socket.onerror = () => {
        clearTimeout(timer);
        this.dropSocket();
        reject(new NotConnectedError());
      };
      socket.onmessage = (ev) => this.onMessage(ev);
    });
    this.connecting = attempt;
    const clear = () => {
      if (this.connecting === attempt) this.connecting = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private dropSocket(): void {
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      try {
        this.socket.close();
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    // Fail everything still waiting — the peer is gone.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new NotConnectedError());
    }
    this.pending.clear();
  }

  private onMessage(ev: { data: string }): void {
    let reply: BridgeReply;
    try {
      reply = JSON.parse(ev.data) as BridgeReply;
    } catch {
      return; // bridge noise (keepalive pings echo nothing back); ignore
    }
    const p = reply?.id !== undefined ? this.pending.get(reply.id) : undefined;
    if (!p) return;
    this.pending.delete(reply.id);
    clearTimeout(p.timer);
    p.resolve(reply);
  }

  /**
   * Sends one command and awaits its correlated reply. Connection problems
   * and timeouts both surface as NotConnectedError with the user-facing text.
   */
  async send(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureSocket();
    const id = this.nextId++;
    const frame = JSON.stringify({ id, command, ...params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NotConnectedError());
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (reply) => (reply.ok ? resolve(reply.result) : reject(new Error(reply.error ?? "bridge error"))),
        reject,
        timer,
      });
      try {
        this.socket!.send(frame);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new NotConnectedError());
      }
    });
  }

  close(): void {
    this.dropSocket();
  }
}
