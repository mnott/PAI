/**
 * whatsapp.ts — WhatsApp notification provider (via the AIBroker hub)
 *
 * Sends through AIBroker's hub socket, which proxies to the whazaa adapter.
 *
 * It used to dial /tmp/whazaa.sock and call a method named `whatsapp_send`.
 * Both were wrong, and had been since AIBroker became the runtime hub and
 * adapters became thin transports: Whazaa no longer owns an IPC socket of its
 * own (it registers with the hub, currently at /tmp/whazaa-watcher.sock, which
 * is the hub's business and not ours), and `whatsapp_send` is an MCP TOOL name
 * — the adapter itself takes `send` and `tts`.
 *
 * So every WhatsApp notification failed. Silently, because a failed channel
 * writes one line to stderr and the router has no fallback: on 2026-08-04 four
 * task-bus escalations about a job that had not run for nine hours reached
 * /tmp/pai-scheduler.log and nowhere else, while the user had no idea.
 *
 * Routing through the hub rather than at the adapter directly is deliberate:
 * the hub knows where its adapters are, and that is exactly the knowledge whose
 * absence broke this. Connect-per-call, no persistent state.
 */

import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  NotificationProvider,
  NotificationPayload,
  NotificationConfig,
} from "../types.js";

/**
 * AIBroker's hub socket.
 *
 * Hardcoded rather than imported: PAI must not depend on AIBroker. This is a
 * protocol constant between them, like the agent mark in tasks/poller.ts.
 */
const HUB_SOCKET = "/tmp/aibroker.sock";
const HUB_TIMEOUT_MS = 10_000;

/**
 * Send a single IPC call to the hub.
 * Returns true on success, false if the hub is not available or errors.
 */
function callHub(
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

    const socket = connect(HUB_SOCKET, () => {
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
        const resp = JSON.parse(buffer.slice(0, nl)) as { error?: unknown; ok?: boolean };
        // The hub reports failure as {ok:false,error}; JSON-RPC reports {error}.
        // Checking only `error` counted an {ok:false} reply as a delivered
        // notification, which is the one mistake this file must never make.
        finish(!resp.error && resp.ok !== false);
      } catch {
        finish(false);
      }
    });

    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));

    timer = setTimeout(() => finish(false), HUB_TIMEOUT_MS);
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
    const asVoice = isVoiceMode && config.mode === "voice";

    // The adapter's own vocabulary is `send` and `tts`, reached through the
    // hub's `adapter_call`. `whatsapp_send` — what this used to ask for — is the
    // name of the MCP TOOL that wraps it, and the adapter has never answered to
    // it. The two vocabularies are easy to confuse because the MCP tool exists
    // and works; it just is not this interface.
    const inner: Record<string, unknown> = asVoice
      ? { text: payload.message, voice: config.channels.voice.voiceName ?? "bm_george" }
      : { message: payload.message };

    if (cfg.recipient) {
      // `send` addresses by `recipient`, `tts` by `jid` — same destination,
      // different key, per the adapter's interface.
      inner[asVoice ? "jid" : "recipient"] = cfg.recipient;
    }

    return callHub("adapter_call", {
      adapter: "whazaa",
      method: asVoice ? "tts" : "send",
      params: inner,
    });
  }
}
