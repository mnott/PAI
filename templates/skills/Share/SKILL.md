---
name: Share
description: >
  Generate social media posts about completed work. Formats content for LinkedIn, X/Twitter, or Bluesky
  using data from session notes, commits, and completed tasks. USE WHEN user says "share on linkedin",
  "post about", "write a tweet about", "/share", "linkedin post", "tweet this", "publish to X",
  "bluesky post", "post to bluesky", OR wants to create social media content about their work.
---

# Share — Social Media Post Generator

Pull from review data and format it for the target platform. Not a press release — a genuine technical post from a builder sharing what they shipped.

## Workflow Routing

**When executing a workflow, do BOTH of these:**

1. **Call the notification script** (for observability tracking):
   ```bash
   ~/.claude/Tools/SkillWorkflowNotification SHARE Share
   ```

2. **Output the text notification** (for user visibility):
   ```
   Running the **Share** workflow from the **Share** skill...
   ```

## Command Routing

| Subcommand | Trigger | Platform | Period |
|------------|---------|----------|--------|
| `/share linkedin today` | "linkedin today", "share today on linkedin" | LinkedIn | Today |
| `/share linkedin week` | "linkedin week", "week on linkedin" | LinkedIn | Current week |
| `/share linkedin "topic"` | "linkedin about vault migration" | LinkedIn | Topic-filtered |
| `/share x` | "tweet", "post to x", "twitter" | X/Twitter | Today (default) |
| `/share x "topic"` | "tweet about reranker" | X/Twitter | Topic-filtered |
| `/share bluesky` | "bluesky", "post to bluesky" | Bluesky | Today (default) |
| `/share bluesky "topic"` | "bluesky about zettelkasten" | Bluesky | Topic-filtered |

If no period or topic is specified, default to **today**.
If no platform is specified, ask: "Which platform? LinkedIn, X, or Bluesky?"

## Data Gathering

Pull from the same sources as `/review` but filter for relevance:

### 1. Session Notes

```bash
# Find notes for the period
find ~/.claude/projects/*/Notes -name "*.md" 2>/dev/null
# Also check project-local Notes/ directories
```

Look for:
- Completed features, fixes, or refactors
- Architectural decisions made
- Numbers (performance improvements, counts, sizes)
- Technical challenges solved

### 2. Git Commits

```bash
git log --after="YYYY-MM-DD" --oneline
```

Focus on: `feat:` and `fix:` commits. Ignore `chore:`, `docs:`, `test:` unless interesting.

### 3. Completed TODO Items

Check `Notes/TODO.md` and `tasks/todo.md` for `[x]` items in the period.

### 4. Topic Filter

If a topic was specified (e.g., "vault migration", "reranker"), filter all gathered data
to only include content related to that topic. Use keyword matching on commit messages,
session note titles, and task names.

## Platform Rules

### LinkedIn

**Voice:** First-person technical narrative. You're a builder sharing real work, not a LinkedIn influencer.

**Format:**
- 1000–2000 characters total
- Open with a concrete hook: what you built, why it matters
- 1–2 emoji used as section dividers, not decoration
- 3–4 short paragraphs covering: what, why, key technical insight, outcome
- End with 3–5 relevant hashtags on their own line
- One call-to-action or reflection sentence

**Tone rules:**
- Write as "I" not "we"
- Be specific: versions, numbers, file counts, performance deltas
- NO: "leverage", "synergy", "paradigm shift", "game-changer", "excited to share"
- YES: "This week I replaced...", "The problem was...", "The fix was..."
- Technical substance over corporate narrative

**Template structure:**
```
[Hook: one concrete sentence about what you shipped]

[The problem or motivation — 2-3 sentences]

[The technical approach — 2-3 sentences, include specific details]

[Outcome or what's next — 1-2 sentences]

[Optional: reflection or open question for the reader]

#tag1 #tag2 #tag3 #tag4
```

**Output:** Copy-paste text only (no MCP for LinkedIn).

---

### X / Twitter

**Voice:** Punchy, direct, technical. Short words. Real numbers.

**Format (single tweet):**
- Max 280 characters
- Use code snippets, commands, or numbers for impact
- 0–2 hashtags maximum (often 0)
- No "check out my latest" — just the substance

**Format (thread):**
- 3–5 tweets
- Tweet 1: hook (standalone, must make sense alone)
- Tweets 2–4: substance, one point per tweet
- Tweet 5: summary or "what's next"
- Number each tweet: "1/" "2/" etc.
- Code blocks fit in tweets when short (use backtick formatting)

**Tone rules:**
- Drop filler words: "really", "actually", "just", "basically"
- Start with the interesting thing, not context
- If it's a number, lead with the number
- If it's a fix, describe the bug first, then the fix

**Decide: single vs thread**
- Single: one clear atomic insight (a fix, a decision, a trick)
- Thread: multiple connected ideas, a migration story, a comparison

**Posting:**
- When platform is X/Twitter, OFFER to post directly via `mcp__x__send_tweet`
- Ask: "Post it, or copy-paste?"
- If posting a thread: post tweet 1 first, then reply to it for each subsequent tweet
  - Use `mcp__x__send_tweet` with `reply_to_tweet_id` for continuations

**Output:** Text AND optional direct posting via X MCP.

---

### Bluesky

**Voice:** Conversational technical. Like X but slightly warmer — you're talking to developers, not the algorithm.

**Format:**
- Max 300 characters per post
- Single post usually sufficient
- Thread format same as X (1/ 2/ 3/) for longer content
- No hashtags needed (they work but aren't the culture)

**Tone rules:**
- More explanation allowed than X (300 vs 280 chars)
- Can reference the "why" in the post rather than assuming context
- Still direct and technical — not corporate

**Output:** Copy-paste text only (no MCP for Bluesky).

---

## Content Extraction Rules

**What makes a good technical post:**
1. A concrete outcome with specifics (not "improved performance" but "300ms → 40ms")
2. A problem that others likely face
3. A non-obvious solution or insight
4. A system decision with real trade-offs explained

**What to skip:**
- Routine maintenance, version bumps, config changes
- Internal refactors with no user-visible impact
- Work that's too context-specific to be interesting to others

**If the data is thin** (only minor work done): Say so rather than inflate.
"Not much shippable today — worked on [internal topic]. Want a post about a recent bigger ship instead?"

## Examples

**Example 1: LinkedIn post about week**
```
User: "/share linkedin week"
-> Gathers session notes for Mon-Sun
-> Gathers git commits for the week
-> Identifies top 1-2 most interesting shipped things
-> Formats as LinkedIn narrative
-> Outputs copy-paste text with hashtags
```

**Example 2: X thread about a specific topic**
```
User: "/share x vault migration"
-> Searches session notes + commits for "vault" keywords
-> Identifies the story arc: SQLite → Postgres migration
-> Decides: thread (multi-part migration story)
-> Formats 4-tweet thread with technical specifics
-> Offers to post directly via mcp__x__send_tweet
```

**Example 3: Quick tweet today**
```
User: "tweet about today"
-> Gathers today's session notes + commits
-> Finds the most tweetable thing
-> Formats single 280-char tweet
-> Offers to post or copy-paste
```

**Example 4: Bluesky post**
```
User: "/share bluesky reranker"
-> Searches for cross-encoder reranker work
-> Formats conversational 300-char post or short thread
-> Outputs copy-paste text
```

## Pre-Action Check

Before generating a post:
1. Always gather real data first — never fabricate accomplishments
2. Verify dates match the requested period
3. If no interesting content found, say so honestly
4. For X: confirm with user before posting (don't auto-post without permission)

## Preferences

<!-- Updated by Claude when user expresses a preference. Date-stamped. -->

### Defaults

| Setting | Default | Set On |
|---------|---------|--------|
| default platform | (ask) | — |
| default period | today | — |
| x posting | ask before posting | — |
| linkedin hashtag count | 3-5 | — |
| thread vs single tweet | decide based on content | — |
