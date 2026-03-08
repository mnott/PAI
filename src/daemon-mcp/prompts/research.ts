export const research = {
  description: "Web research, content extraction, and wisdom analysis via parallel agents",
  content: `## Research Skill

USE WHEN user says 'do research', 'extract wisdom', 'analyze content', 'find information about', or requests web/content research.

### Research Modes

- Quick: 1 agent per type, 2 min timeout
- Standard (default): 3 agents per type, 3 min timeout
- Extensive: 8 agents per type, 10 min timeout

### Available Agents

\`claude-researcher\` (free, WebSearch), \`perplexity-researcher\` (PERPLEXITY_API_KEY), \`gemini-researcher\` (GOOGLE_API_KEY).

### Workflow Routing

- Parallel research → read \`\${PAI_DIR}/Skills/research/workflows/conduct.md\`
- Claude research (free) → \`workflows/claude-research.md\`
- Blocked content / CAPTCHA → escalate: WebFetch → BrightData → Apify
- YouTube URL → \`fabric -y <URL>\` then pattern
- Fabric patterns → 242+ patterns including: \`extract_wisdom\`, \`summarize\`, \`create_threat_model\`, \`analyze_claims\`, \`improve_writing\`

### Fabric Usage

\`fabric [input] -p [pattern]\` or \`fabric -u "URL" -p [pattern]\` or \`fabric -y "YOUTUBE_URL" -p [pattern]\``,
};
