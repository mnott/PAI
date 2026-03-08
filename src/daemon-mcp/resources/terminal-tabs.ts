export const terminalTabs = {
  name: "terminal-tabs",
  uri: "pai://terminal-tabs",
  description: "Terminal tab title system — automatic 4-word task summaries",
  content: `# Terminal Tab Title System

## Overview

PAI automatically updates your terminal tab title with a 4-word summary of what was done after each task completion.

## How It Works

The stop-hook.ts hook runs after every task completion and:
1. Extracts the task summary from the COMPLETED line
2. Generates a 4-word title summarizing what was accomplished
3. Updates your terminal tab using ANSI escape sequences

## Escape Sequences

\`\`\`bash
# OSC 0 — Sets icon and window title
printf '\\033]0;Title Here\\007'

# OSC 30 — Kitty-specific tab title
printf '\\033]30;Title Here\\007'
\`\`\`

## Terminal Compatibility

Kitty, iTerm2, Terminal.app, Alacritty, VS Code Terminal — all supported.

## Implementation

Location: \${PAI_DIR}/Hooks/stop-hook.ts

Key functions:
- generateTabTitle(prompt, completedLine) — Creates the 4-word summary
- setKittyTabTitle(title) — Sends escape sequences to update the tab
`,
};
