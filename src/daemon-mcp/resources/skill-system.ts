export const skillSystem = {
  name: "skill-system",
  uri: "pai://skill-system",
  description: "Custom skill system specification — TitleCase naming, SKILL.md structure",
  content: `# Custom Skill System

The MANDATORY configuration system for ALL PAI skills.

## TitleCase Naming Convention (MANDATORY)

| Component | Wrong | Correct |
|-----------|-------|---------|
| Skill directory | createskill, create-skill | Createskill |
| Workflow files | create.md, update-info.md | Create.md, UpdateInfo.md |
| Reference docs | prosody-guide.md | ProsodyGuide.md |
| YAML name | name: create-skill | name: Createskill |

Exception: SKILL.md is always uppercase.

## Required Structure

Every SKILL.md has two parts:

### 1. YAML Frontmatter

\`\`\`yaml
---
name: SkillName
description: [What it does]. USE WHEN [intent triggers using OR]. [Capabilities].
---
\`\`\`

Rules:
- name uses TitleCase
- description is a single line (not multi-line with |)
- USE WHEN keyword is MANDATORY (Claude Code parses this for skill activation)
- Use intent-based triggers with OR for multiple conditions
- Max 1024 characters (Anthropic hard limit)

### 2. Markdown Body

\`\`\`markdown
# SkillName

[Brief description]

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **WorkflowOne** | "trigger phrase" | workflows/WorkflowOne.md |

## Examples

**Example 1: [Common use case]**
User: "[Typical user request]"
→ Invokes WorkflowOne workflow
→ [What skill does]
\`\`\`

## Complete Checklist

- [ ] Skill directory uses TitleCase
- [ ] All workflow files use TitleCase
- [ ] YAML name: uses TitleCase
- [ ] Single-line description with embedded USE WHEN clause
- [ ] Description under 1024 characters
- [ ] Workflow Routing section with table format
- [ ] Examples section with 2-3 concrete patterns
- [ ] tools/ directory exists (even if empty)
- [ ] No backups/ directory inside skill
`,
};
