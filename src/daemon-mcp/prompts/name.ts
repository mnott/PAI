export const name = {
  description: "Name or rename the current session",
  content: `## Name Skill

USE WHEN user says '/name', 'name this session', 'rename session', OR wants to label what they're working on.

Call \`aibroker_rename\` with the provided name. Updates: AIBroker session registry, iTerm2 tab title, statusline display.

Usage: \`/name <new name>\` — immediately call \`aibroker_rename\`, no confirmation needed.`,
};
