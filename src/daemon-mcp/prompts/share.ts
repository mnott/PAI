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

### Templates

Templates: if ~/.pai/templates/<platform>-post.md exists (linkedin-post.md, x-post.md, bluesky-post.md), read it first; its rules and reference post override the defaults below.

### LinkedIn Rules

Plain text only (no Markdown: no #, no **, no [text](url), no tables). Section headers as a plain line of their own. Emoji as the only structure (👉 findings, • options, 📄 paper link), used sparingly. Links as bare URLs on their own line after a short label. Up to about 3,000 characters, first-person builder voice, concrete hook opener. 5-7 hashtags in one final line. Save the result as a .txt file on the Desktop; the output is final, the operator does not edit it. NEVER: 'leverage', 'synergy', 'excited to share'. YES: specific versions, numbers, performance deltas.

### X/Twitter Rules

Plain text only. Each post max 280 characters (a URL counts 23). Lead with the interesting thing. Threads numbered 1/ 2/ etc. At most one bare URL per post. 0-2 hashtags, in the last post. Replies to a comment answer first with the measured number. Save as .txt on the Desktop, posts separated by a line "---". Offer to post via \`mcp__x__send_tweet\` — ALWAYS ask before posting.

### Bluesky Rules

Plain text only, no Markdown. Max 300 chars, no hashtags needed, warmer than X but still technical. Copy-paste only.

### Content Rule

Count characters with wc -m when a length is asked; land within ±10 of a target. Always gather real data first. If no interesting content found, say so rather than inflate.`,
};
