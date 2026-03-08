export const mcpDevGuide = {
  name: "mcp-dev-guide",
  uri: "pai://mcp-dev-guide",
  description: "MCP skill delivery guide — three-tier architecture best practices",
  content: `# MCP Skill Delivery Guide

How to structure MCP server instructions, prompts, and resources for optimal context efficiency.

## The Three-Tier Architecture

MCP provides three mechanisms for delivering content to Claude. Use each for its intended purpose.

### Tier 1: instructions (Always Loaded)

The instructions field is loaded into EVERY message's context for the lifetime of the MCP connection. Keep it thin.

**What belongs here:**
- Brief description of the MCP server (1-2 sentences)
- Routing table: "When user says X → fetch prompt Y"
- Core behavioral rules that apply to every interaction
- Resource directory: "Fetch pai://name for full guide on X"

**What does NOT belong here:**
- Full skill descriptions and workflow steps
- Reference documentation (aesthetic guides, API docs)
- Examples and tutorials
- Anything that changes rarely and is only needed sometimes

**Target size:** Under 2KB. If it exceeds this, you are doing it wrong.

### Tier 2: prompts (On-Demand Workflows)

Prompts are fetched by Claude when a specific skill is triggered. The user does not see these directly — they are instructions for Claude.

**What belongs here:**
- Complete skill workflow instructions
- USE WHEN trigger conditions
- Step-by-step workflow routing tables
- Platform-specific rules (LinkedIn vs X vs Bluesky)
- Command tables and data source lists

**Registration:**

\`\`\`typescript
server.prompt(
  "review",
  "Weekly/daily/monthly review of work accomplished",
  () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: reviewSkillContent,
      },
    }],
  })
);
\`\`\`

**Naming:** lowercase-kebab. Examples: "review", "share", "vault-context".

### Tier 3: resources (Reference Documentation)

Resources are reference documents that Claude reads when it needs detailed information. Unlike prompts, they are not workflow instructions — they are reference material.

**What belongs here:**
- Style guides (aesthetic, voice, prosody)
- Constitutional documents (philosophy, architecture)
- API reference documentation
- Configuration schemas
- Technical specifications

**Registration:**

\`\`\`typescript
server.resource(
  "aesthetic",
  "pai://aesthetic",
  { mimeType: "text/markdown" },
  async () => ({
    contents: [{
      uri: "pai://aesthetic",
      mimeType: "text/markdown",
      text: aestheticGuideContent,
    }],
  })
);
\`\`\`

**URI convention:** Use a consistent scheme like \`pai://name\` or \`mcp://server-name/resource\`.

## Decision Matrix

| Content Type | Tier | Reasoning |
|--------------|------|-----------|
| "When user says X, fetch prompt Y" | instructions | Routes to the right skill |
| Full skill workflow (20+ lines) | prompt | Only needed when skill triggers |
| Aesthetic style guide | resource | Reference, not workflow |
| Core operating rules | instructions | Applies to every interaction |
| Platform-specific post formatting | prompt | Part of share skill workflow |
| Voice prosody guide | resource | Reference, rarely needed |
| Session lifecycle commands | instructions | Always applicable |

## Anti-Patterns

### Anti-Pattern 1: Stuffing everything into instructions

\`\`\`
// WRONG — 20 full skill descriptions in instructions
const PAI_INSTRUCTIONS = \`
## Review Skill
USE WHEN user says 'review'...
[200 lines of workflow details]

## Journal Skill
USE WHEN user says 'journal'...
[150 lines of workflow details]

[18 more skills...]
\`;
\`\`\`

**Problem:** Consumes 8-15KB of context on every message. Most of this content is irrelevant 95% of the time.

**Fix:** One-line routing table in instructions. Full content in prompts.

### Anti-Pattern 2: File path references in instructions

\`\`\`
// WRONG — hardcoded personal paths
"Read ~/.claude/Skills/Share/SKILL.md for social media instructions"
\`\`\`

**Problem:** Paths are personal, not portable. The file may not exist. Reading a file wastes a tool call.

**Fix:** Embed content directly in prompts/resources. No file paths needed.

### Anti-Pattern 3: Personal data in instructions

\`\`\`
// WRONG — names and personal identifiers
"You are assisting John Smith at Acme Corp..."
\`\`\`

**Problem:** Instructions ship with the MCP server. If the server is shared or open-source, personal data leaks.

**Fix:** Use placeholders (\${USER_NAME}) or keep personal data out of instructions entirely.

### Anti-Pattern 4: Duplicating content across tiers

\`\`\`
// WRONG — routing table in instructions AND full skill in instructions
instructions: "When user says 'share', use Share skill. Share skill rules: 1000-2000 chars..."
\`\`\`

**Fix:** Routing table in instructions, full skill in prompt. Never both.

## How to Add a New Skill

1. Write the full skill content (workflow steps, trigger conditions, examples)
2. Add a one-line entry to the routing table in instructions
3. Register as a prompt with server.prompt()
4. Test that the routing table correctly identifies trigger phrases

\`\`\`typescript
// Step 2: Add to routing table in instructions
"| When user says 'deploy' or 'push to production' | Fetch prompt: deploy |"

// Step 3: Register the prompt
server.prompt(
  "deploy",
  "Deploy to staging or production environments",
  () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: deploySkillContent,  // Full workflow here
      },
    }],
  })
);
\`\`\`

## How to Add a New Resource

1. Write the reference content (guide, spec, configuration schema)
2. Add an entry to the resource directory in instructions
3. Register with server.resource()

\`\`\`typescript
// Step 2: Add to resource directory in instructions
"| API reference | pai://api-reference |"

// Step 3: Register the resource
server.resource(
  "api-reference",
  "pai://api-reference",
  { mimeType: "text/markdown" },
  async () => ({
    contents: [{
      uri: "pai://api-reference",
      mimeType: "text/markdown",
      text: apiReferenceContent,
    }],
  })
);
\`\`\`

## Testing Checklist

Before shipping a refactored MCP server:

- [ ] instructions field is under 2KB
- [ ] instructions contains ONLY routing table + core rules
- [ ] Each skill has a registered prompt (server.prompt)
- [ ] Each reference doc has a registered resource (server.resource)
- [ ] No full skill descriptions in instructions
- [ ] No hardcoded personal paths in instructions
- [ ] No personal data (names, emails) in instructions
- [ ] Prompts are fetchable: prompts/list returns all expected prompts
- [ ] Resources are readable: resources/list returns all expected resources
- [ ] Tools are unchanged (only instructions/prompts/resources changed)
- [ ] Build succeeds: npm run build

## Context Size Impact

Example: PAI MCP before and after refactor

| Metric | Before | After |
|--------|--------|-------|
| instructions size | ~8KB (20 skills) | ~1.5KB (routing table) |
| Context loaded per message | ~8KB | ~1.5KB |
| Full skill content when needed | ~8KB | ~0.5KB (one skill) |
| Context savings (typical session) | — | ~6.5KB per message |

At 200 message sessions, that is 1.3MB of context saved — equivalent to 5-10 extra tool calls worth of context.
`,
};
