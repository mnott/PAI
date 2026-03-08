/**
 * Push notification helpers — WhatsApp-aware with ntfy.sh fallback.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Check if a messaging MCP server (AIBroker, Whazaa, or Telex) is configured.
 * When any messaging server is active, the AI handles notifications via MCP
 * and ntfy is skipped to avoid duplicates.
 */
export function isWhatsAppEnabled(): boolean {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return false;

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const enabled: string[] = settings.enabledMcpjsonServers || [];
    return enabled.includes('aibroker') || enabled.includes('whazaa') || enabled.includes('telex');
  } catch {
    return false;
  }
}

/**
 * Send push notification — WhatsApp-aware with ntfy fallback.
 *
 * When WhatsApp (Whazaa) is enabled in MCP config, ntfy is SKIPPED
 * because the AI sends WhatsApp messages directly via MCP.
 * When WhatsApp is NOT configured, ntfy fires as the fallback channel.
 */
export async function sendNtfyNotification(message: string, retries = 2): Promise<boolean> {
  if (isWhatsAppEnabled()) {
    console.error(`WhatsApp (Whazaa) enabled in MCP config — skipping ntfy`);
    return true;
  }

  const topic = process.env.NTFY_TOPIC;

  if (!topic) {
    console.error('NTFY_TOPIC not set and WhatsApp not active — notifications disabled');
    return false;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: message,
        headers: {
          'Title': 'Claude Code',
          'Priority': 'default',
        },
      });

      if (response.ok) {
        console.error(`ntfy.sh notification sent (WhatsApp inactive): "${message}"`);
        return true;
      } else {
        console.error(`ntfy.sh attempt ${attempt + 1} failed: ${response.status}`);
      }
    } catch (error) {
      console.error(`ntfy.sh attempt ${attempt + 1} error: ${error}`);
    }

    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.error('ntfy.sh notification failed after all retries');
  return false;
}
