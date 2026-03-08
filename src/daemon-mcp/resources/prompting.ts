export const prompting = {
  name: "prompting",
  uri: "pai://prompting",
  description: "Prompt engineering standards — context engineering, signal-to-noise, anti-patterns",
  content: `# Prompt Engineering Standards

Based on Anthropic's context engineering principles and Daniel Miessler's Fabric system.

## Core Philosophy

Context engineering: the set of strategies for curating and maintaining the optimal set of tokens during LLM inference.

Primary goal: Find the smallest possible set of high-signal tokens that maximize the likelihood of desired outcomes.

## Key Principles

### 1. Context is a Finite Resource

- LLMs have a limited attention budget
- Every token depletes attention capacity
- Treat context as precious and finite

### 2. Optimize for Signal-to-Noise Ratio

- Prefer clear, direct language over verbose explanations
- Remove redundant or overlapping information
- Focus on high-value tokens that drive desired outcomes

### 3. Progressive Information Discovery

- Use lightweight identifiers rather than full data dumps
- Load detailed information dynamically when needed
- Allow agents to discover information just-in-time

## Markdown Structure Standards

Organize prompts into distinct semantic sections:

\`\`\`markdown
## Background Information
Essential context about the domain

## Instructions
Clear, actionable directives

## Examples
Concrete examples (1-3 optimal)

## Constraints
Boundaries, limitations, requirements

## Output Format
Explicit specification of desired response structure
\`\`\`

## Writing Style

**Clarity over completeness:**
- Good: "Validate user input before processing"
- Bad: "You should always make sure to validate the user's input..."

**Be direct and specific:**
- Good: "Use the calculate_tax tool with amount and jurisdiction parameters"
- Bad: "You might want to consider using the calculate_tax tool if you need..."

## Anti-Patterns

- Verbose explanations instead of direct instructions
- Historical context dumping (how we got here)
- Overlapping tool definitions
- Premature information loading
- Vague hedging: "might", "could", "should consider"

## Context Management Strategies

1. **Just-in-time loading** — Provide SKU/ID, not full data dumps
2. **Sub-agent architectures** — Delegate subtasks, each agent gets minimal context
3. **Structured note-taking** — Persist important information outside context window
4. **Compaction** — Summarize older conversation segments, preserve critical state

## Evolution

1. Start minimal
2. Measure performance
3. Identify gaps
4. Add strategically
5. Prune regularly
6. Iterate

Source: Anthropic "Effective Context Engineering for AI Agents", Daniel Miessler Fabric (2024)
`,
};
