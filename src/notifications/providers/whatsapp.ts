/**
 * whatsapp.ts — WhatsApp notification provider (via Whazaa MCP)
 *
 * Sends notifications via the Whazaa Unix Domain Socket IPC protocol.
 * Falls back gracefully if Whazaa is not running.
 *
 * Whazaa IPC socket: /tmp/whazaa.sock (standard Whazaa path)
 *
 * We use the same connect-per-call pattern as PaiClient to avoid
 * requiring any persistent connection state.
 */

import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  NotificationProvider,
  NotificationPayload,
  NotificationConfig,
} from "../types.js";

const WHAZAA_SOCKET = "/tmp/whazaa.sock";
const WHAZAA_TIMEOUT_MS = 10_000;

/**
 * Send a single IPC call to the Whazaa socket.
 * Returns true on success, false if Whazaa is not available or errors.
 */
function callWhazaa(
  method: string,
  params: Record<string, unknown>
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(ok: boolean): void {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { socket?.destroy(); } catch { /* ignore */ }
      resolve(ok);
    }

    const socket = connect(WHAZAA_SOCKET, () => {
      const request = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      };
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        const resp = JSON.parse(buffer.slice(0, nl)) as { error?: unknown };
        finish(!resp.error);
      } catch {
        finish(false);
      }
    });

    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));

    timer = setTimeout(() => finish(false), WHAZAA_TIMEOUT_MS);
  });
}

export class WhatsAppProvider implements NotificationProvider {
  readonly channelId = "whatsapp" as const;

  async send(
    payload: NotificationPayload,
    config: NotificationConfig
  ): Promise<boolean> {
    const cfg = config.channels.whatsapp;
    if (!cfg.enabled) return false;

    const isVoiceMode = config.mode === "voice" || config.channels.voice.enabled;

    const params: Record<string, unknown> = {
      message: payload.message,
    };

    if (cfg.recipient) {
      params.recipient = cfg.recipient;
    }

    if (isVoiceMode && config.mode === "voice") {
      const voiceName = config.channels.voice.voiceName ?? "bm_george";
      params.voice = voiceName;
    }

    return callWhazaa("whatsapp_send", params);
  }
}
