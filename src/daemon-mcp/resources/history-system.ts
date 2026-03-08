export const historySystem = {
  name: "history-system",
  uri: "pai://history-system",
  description: "UOCS history system — automated documentation and capture patterns",
  content: `# Universal Output Capture System (UOCS) — History System

Automated documentation of ALL work performed by PAI and specialized agents.

## Directory Structure

\`\`\`
\${PAI_DIR}/History/
├── Sessions/YYYY-MM/          # Session summaries
├── Learnings/YYYY-MM/         # Problem-solving narratives
├── Research/YYYY-MM/          # Investigation reports
├── Decisions/YYYY-MM/         # Architectural decisions
├── Execution/
│   ├── Features/YYYY-MM/      # Feature implementations
│   ├── Bugs/YYYY-MM/          # Bug fixes
│   └── Refactors/YYYY-MM/     # Code improvements
└── Raw-Outputs/YYYY-MM/       # JSONL logs
\`\`\`

## File Naming Convention

\`\`\`
YYYY-MM-DD-HHMMSS_[PROJECT]_[TYPE]_[HIERARCHY]_[DESCRIPTION].md
\`\`\`

## Hook Integration

- PostToolUse → raw JSONL logs in Raw-Outputs/
- Stop → Learnings/ or Sessions/ based on content analysis
- SubagentStop → categorized by agent type
- SessionEnd → session summary in Sessions/

## Search Commands

\`\`\`bash
# Quick keyword search
rg -i "keyword" \${PAI_DIR}/History/

# Search sessions
rg -i "keyword" \${PAI_DIR}/History/sessions/

# Recent files
ls -lt \${PAI_DIR}/History/sessions/\$(date +%Y-%m)/ | head -20
\`\`\`
`,
};
