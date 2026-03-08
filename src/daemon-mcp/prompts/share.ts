export const share = {
  description: "Generate LinkedIn, X/Twitter, or Bluesky posts about completed work",
  content: `## Share Skill

USE WHEN user says 'share on linkedin', 'post about', 'write a tweet about', '/share', 'linkedin post', 'tweet this', 'publish to X', 'bluesky post', 'post to bluesky', OR wants to create social media content about their work.

### Commands

| Subcommand | Platform | Period |
|------------|----------|--------|
| /share linkedin week | LinkedIn | Current week |
| /share linkedin today | LinkedIn | Today |
| /share linkedin "topic" | LinkedIn | Topic-filtered |
| /share x | X/Twitter | Today |
| /share x "topic" | X/Twitter | Topic-filtered |
| /share bluesky | Bluesky | Today |

### LinkedIn Rules

1000-2000 chars, first-person builder voice, concrete hook opener, 3-5 hashtags at end. NEVER: 'leverage', 'synergy', 'excited to share'. YES: specific versions, numbers, performance deltas.

### X/Twitter Rules

Max 280 chars, 0-2 hashtags, lead with the interesting thing. Thread format: 3-5 tweets numbered '1/' '2/' etc. Offer to post via \`mcp__x__send_tweet\` — ALWAYS ask before posting.

### Bluesky Rules

Max 300 chars, no hashtags needed, warmer than X but still technical. Copy-paste only.

### Content Rule

Always gather real data first. If no interesting content found, say so rather than inflate.`,
};
