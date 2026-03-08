export const storyExplanation = {
  description: "Create numbered narrative story explanations of any content",
  content: `## StoryExplanation Skill

USE WHEN user explicitly says '/story', 'create story explanation', 'run CSE', 'explain this as a story', 'story with links', 'deep story'. Do NOT activate on vague mentions of 'story'.

### Commands

| Command | Output |
|---------|--------|
| /story [content] | 8 numbered narrative points (default) |
| /story [N] [content] | N numbered points (3-50) |
| /story deep [content] | 20+ points deep dive |
| /story links [content] | N points with inline links |

### Input Sources

URL (WebFetch), YouTube URL (\`fabric -y <URL>\`), file path (Read), pasted text (direct).`,
};
