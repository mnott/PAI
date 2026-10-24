/**
 * One newline-delimited JSON request to a Unix-socket server (PAI daemon, AIBroker),
 * settled exactly once: on the first full reply line, an error, the socket ending,
 * or the timeout. Hooks use it so none of them hand-rolls the connect/buffer/timer dance.
 */

import { connect } from 'net';
import { randomUUID } from 'crypto';

export interface SocketReply {
  ok: boolean;
  result?: any;
  error?: string;
}

export interface SocketHandlers<T> {
  /** The reply line parsed as JSON. A throw here settles with `fallback`. */
  onReply: (reply: SocketReply) => T;
  /** Connect/socket error. */
  onError: (e: NodeJS.ErrnoException) => T;
  /** Timeout elapsed with no reply. */
  onTimeout: () => T;
  /** Unparseable reply, or the socket ended without one. */
  fallback: T;
}

export function socketRequest<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  h: SocketHandlers<T>
): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(value: T): void {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      try { client.destroy(); } catch { /* ignore */ }
      resolve(value);
    }

    const client = connect(socketPath, () => {
      client.write(JSON.stringify({ id: randomUUID(), method, params }) + '\n');
    });

    client.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      let value: T;
      try {
        value = h.onReply(JSON.parse(buffer.slice(0, nl)) as SocketReply);
      } catch {
        value = h.fallback;
      }
      finish(value);
    });
    client.on('error', (e: NodeJS.ErrnoException) => finish(h.onError(e)));
    client.on('end', () => finish(h.fallback));
    timer = setTimeout(() => finish(h.onTimeout()), timeoutMs);
  });
}

/** Enqueue a work-queue item with the daemon; fire-and-forget callers ignore the result. */
export function enqueueWork<T>(
  socketPath: string,
  timeoutMs: number,
  type: string,
  priority: number,
  payload: Record<string, unknown>,
  h: SocketHandlers<T>
): Promise<T> {
  return socketRequest(socketPath, 'work_queue_enqueue', { type, priority, payload }, timeoutMs, h);
}

/** Enqueue a registry-scan item for the current directory. Never throws, never blocks beyond the timeout. */
export function enqueueRegistryScan(socketPath: string, timeoutMs: number): Promise<void> {
  const done = () => undefined;
  return enqueueWork(socketPath, timeoutMs, 'registry-scan', 5, { cwd: process.cwd() }, {
    onReply: done, onError: done, onTimeout: done, fallback: undefined,
  });
}
