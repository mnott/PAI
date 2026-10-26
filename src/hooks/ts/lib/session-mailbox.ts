/**
 * session-mailbox.ts — SessionStart side of the AIBroker mailbox.
 *
 * Machine ingress goes mailbox-only to a session that keeps an `aibroker mailbox wait` running, so
 * the session is told at start to keep exactly one, and mail that is already waiting is delivered
 * right away (same wording and two-phase peek/ack as AIBroker's UserPromptSubmit drain hook).
 * Silent on every error: no daemon, no terminal identity, nothing waiting.
 */

import { connect } from "node:net";

export const WAITER_NOTICE =
  `Keep exactly one \`aibroker mailbox wait\` running in the background (Bash run_in_background) so machine ingress wakes this session; never two at once.\n` +
  `When it exits, read the mailbox (aibroker_receive or the delivered text), act on it, then start a new waiter.`;

interface MailboxMessage { from?: string; content?: string; timestamp?: number }

const TIMEOUT_MS = 1500;
const socketPath = (): string => process.env.AIBROKER_HOOK_SOCKET ?? process.env.AIBROKER_SOCKET ?? "/tmp/aibroker.sock";

function call(method: string, params: Record<string, unknown>): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const finish = (v: Record<string, any> | null) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const sock = connect(socketPath(), () => sock.write(JSON.stringify({ id: "session-start", method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      try { finish(JSON.parse(buf.trim())); } catch { finish(null); }
    });
    sock.on("error", () => finish(null));
  });
}

function terminalId(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.TMUX_PANE ?? env.ITERM_SESSION_ID;
  if (!raw) return undefined;
  return raw.includes(":") ? raw.split(":").pop() : raw;
}

/** The delivery text for waiting messages, or null when there are none. */
export function formatDelivery(messages: MailboxMessage[], now = Date.now()): string | null {
  if (messages.length === 0) return null;
  const lines = messages.map((m) => {
    const when = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("en-GB", { hour12: false }) : "";
    const waited = m.timestamp ? Math.round((now - m.timestamp) / 60000) : null;
    const age = waited !== null && waited >= 1 ? ` (waited ${waited} min)` : "";
    return `[Session:${m.from}] ${when}${age}\n${m.content}`;
  });
  return (
    `<system-reminder>\n` +
    `${messages.length} message(s) were waiting in this session's mailbox and have been delivered now.\n` +
    `Treat each as if it had just been sent: reply to the sender with aibroker_send_to_session, not in the terminal.\n\n` +
    lines.join("\n\n") +
    `\n</system-reminder>`
  );
}

/** Peek, print, then ack what was printed; a failure before the print leaves the mail queued. */
export async function deliverWaitingMail(
  claudeSessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  write: (s: string) => void = (s) => process.stdout.write(s)
): Promise<void> {
  const id = terminalId(env);
  if (!id && !claudeSessionId) return;
  const res = await call("session_mailbox_peek", { sessionId: id, claudeSessionId });
  const messages: MailboxMessage[] = res?.ok ? (res.result?.messages ?? []) : [];
  const out = formatDelivery(messages);
  if (!out) return;
  write(out + "\n");
  await call("session_mailbox_ack", { sessionId: id, claudeSessionId, count: messages.length });
}

