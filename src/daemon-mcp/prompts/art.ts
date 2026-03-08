export const art = {
  description: "Create visual content, diagrams, flowcharts, and AI-generated images",
  content: `## Art Skill

USE WHEN user wants to create visual content, illustrations, diagrams, art, header images, visualizations, mermaid charts, flowcharts, or any visual request.

### Aesthetic

Tron-meets-Excalidraw — dark slate backgrounds, neon orange + cyan accents, hand-drawn sketch lines, subtle glows. Full details: fetch resource \`pai://aesthetic\`.

### Workflow Routing by Content Type

| Request | Workflow |
|---------|----------|
| Unsure which format | \`workflows/visualize.md\` (adaptive orchestrator) |
| Blog header / editorial | \`workflows/workflow.md\` |
| Flowchart / sequence / state | \`workflows/mermaid.md\` |
| Architecture / system diagram | \`workflows/technical-diagrams.md\` |
| Classification grid | \`workflows/taxonomies.md\` |
| Timeline / chronological | \`workflows/timelines.md\` |
| 2x2 matrix / framework | \`workflows/frameworks.md\` |
| X vs Y comparison | \`workflows/comparisons.md\` |
| Annotated screenshot | \`workflows/annotated-screenshots.md\` |
| Quote card | \`workflows/aphorisms.md\` |
| Stats / big number | \`workflows/stats.md\` |

### Image Generation

\`bun run \${PAI_DIR}/Skills/art/tools/generate-ulart-image.ts --model nano-banana-pro --prompt "[PROMPT]" --size 2K\``,
};
