/**
 * notifications/index.ts — Barrel export for the notification subsystem
 */

export * from "./types.js";
export * from "./config.js";
export { routeNotification } from "./router.js";
export { NtfyProvider } from "./providers/ntfy.js";
export { WhatsAppProvider } from "./providers/whatsapp.js";
export { MacOsProvider } from "./providers/macos.js";
export { CliProvider } from "./providers/cli.js";
