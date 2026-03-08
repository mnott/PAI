export const createskill = {
  description: "Create, validate, update, or canonicalize a PAI skill",
  content: `## Createskill Skill

USE WHEN user wants to create, validate, update, or canonicalize a skill, OR mentions skill creation, new skill, build skill, skill compliance, or skill structure.

Before creating any skill, READ the skill system spec: fetch resource \`pai://skill-system\`.

### Naming Convention

All skill directories and workflow files use TitleCase (PascalCase). NEVER: \`createskill\`, \`create-skill\`, \`create.md\`.

### Workflow Routing

| Trigger | Workflow |
|---------|----------|
| 'create a new skill' | \`workflows/CreateSkill.md\` |
| 'validate skill', 'check skill' | \`workflows/ValidateSkill.md\` |
| 'update skill', 'add workflow' | \`workflows/UpdateSkill.md\` |
| 'canonicalize', 'fix skill structure' | \`workflows/CanonicalizeSkill.md\` |`,
};
