# KAI SYSTEM CONSTITUTION

**The Foundational Philosophy, Architecture, and Operations of Your Personal AI Infrastructure**

**Last Updated:** 2025-11-17
**Status:** Active - This is the canonical reference for all Kai architectural decisions

---

## Table of Contents

### Part I: Philosophy (Why)
1. [Core Philosophy](#core-philosophy)
2. [The Eight Founding Principles](#the-eight-founding-principles)

### Part II: Architecture (How)
3. [Progressive Disclosure System](#progressive-disclosure-system)
4. [Skills-as-Containers Philosophy](#skills-as-containers-philosophy)
5. [System Prompt Routing Pattern](#system-prompt-routing-pattern)
6. [The Four Primitives](#the-four-primitives)
7. [CLI-First Architecture](#cli-first-architecture)
8. [Two-Tier MCP Strategy](#two-tier-mcp-strategy)

### Part III: Operations (What)
9. [Critical Systems](#critical-systems)
10. [Directory Structure](#directory-structure)
11. [Operational Patterns](#operational-patterns)
12. [Testing & Quality](#testing--quality)

---

# PART I: PHILOSOPHY

## Core Philosophy

**Kai is scaffolding for AI, not a replacement for human intelligence.**

The system is designed on the principle that **AI systems need structure to be reliable**. Like physical scaffolding supports construction work, Kai provides the architectural framework that makes AI assistance dependable, maintainable, and effective.

### The Central Insight

**Deterministic systems are more reliable than probabilistic ones.**

When you can predict what will happen, you can:
- Build on it
- Test it
- Trust it
- Scale it
- Fix it when it breaks

This is why Kai emphasizes:
- CLI tools over ad-hoc prompting
- Code before prompts
- Specifications before implementation
- Tests before features

---

## The Eight Founding Principles

### 1. Scaffolding > Model

**The system architecture matters more than the underlying AI model.**

A well-structured system with good scaffolding will outperform a more powerful model with poor structure. Kai's value comes from:

- Organized workflows that guide AI execution
- Routing systems that activate the right context
- Quality gates that verify outputs
- History systems that enable learning
- Voice feedback that provides awareness

**Key Takeaway:** Build the scaffolding first, then add the AI.

### 2. As Deterministic as Possible

**Favor predictable, repeatable outcomes over flexibility.**

In production systems, consistency beats creativity:

- Same input → Same output (always)
- No reliance on prompt variations
- No dependence on model mood
- Behavior defined by code, not prompts
- Version control tracks explicit changes

**Implementation:**
- CLI tools with explicit commands
- Typed interfaces with validation
- Test suites that lock in behavior
- Error handling that's predictable
- Logs that explain what happened

**Key Takeaway:** If it can be made deterministic, make it deterministic.

### 3. Code Before Prompts

**Write code to solve problems, use prompts to orchestrate code.**

Prompts should never replicate functionality that code can provide:

❌ **Bad:** Prompt AI to parse JSON, transform data, format output
✅ **Good:** Write TypeScript to parse/transform/format, prompt AI to call it

❌ **Bad:** Prompt AI to query database with complex logic
✅ **Good:** Write SQL query in code, prompt AI to execute it

❌ **Bad:** Prompt AI to scrape website and filter results
✅ **Good:** Write scraper that filters in code, prompt AI to use it

**Key Takeaway:** Code is cheaper, faster, and more reliable than prompts.

### 4. CLI as Interface

**Every operation should be accessible via command line.**

Command line interfaces provide:
- Discoverability (--help shows all commands)
- Scriptability (commands can be automated)
- Testability (test CLI independently of AI)
- Flexibility (use with or without AI)
- Transparency (see exactly what was executed)

**Example:**
```bash
# Good: Explicit CLI command
blog publish --post my-post.md --verify-deployment

# Bad: Hidden AI magic
# (user has no idea what commands are being run)
```

**Key Takeaway:** If there's no CLI command for it, you can't script it or test it reliably.

### 5. Goal → Code → CLI → Prompts

**The proper development pipeline for any new feature.**

```
User Goal
    ↓
Understand Requirements (what needs to happen)
    ↓
Write Deterministic Code (how it happens)
    ↓
Wrap as CLI Tool (make it accessible)
    ↓
Add AI Prompting (make it easy to use)
```

**Never skip steps:**
- Don't write prompts before code
- Don't write code without understanding requirements
- Don't skip the CLI layer
- Don't forget the "why" (user goal)

**Key Takeaway:** Each layer builds on the previous. Skip a layer, get a shaky system.

### 6. Spec/Test/Evals First

**Define expected behavior before writing implementation.**

**Specifications:**
- What should this do?
- What inputs does it accept?
- What outputs does it produce?
- What edge cases exist?

**Tests:**
- Write test before implementation
- Test should fail initially
- Implement until test passes
- Refactor while tests pass

**Evaluations:**
- For AI components, write evals
- Define golden outputs
- Measure against baselines
- Track regression over time

**Key Takeaway:** If you can't specify it, you can't test it. If you can't test it, you can't trust it.

### 7. Meta/Self Updates

**The system should be able to improve itself.**

Kai can:
- Update its own documentation
- Modify skill files
- Add new workflows
- Create new tools
- Refactor its own code
- Deploy changes to itself

**Principles for Meta-Updates:**
- **Safety First:** Always verify before pushing
- **Rollback Capability:** Keep backups in `upgrades/deprecated/`
- **Documentation:** Log every architectural change
- **Testing:** Test meta-update tools like any other code
- **Version Control:** Commit changes explicitly

**Key Takeaway:** A system that can't update itself will stagnate. Build the capability to evolve.

### 8. Custom Skill Management

**Skills are the organizational unit for all domain expertise.**

Skills are more than documentation - they are active orchestrators:

- **Self-activating:** Trigger automatically based on user request
- **Self-contained:** Package all context, workflows, and assets
- **Composable:** Can call other skills and agents
- **Evolvable:** Easy to add, modify, or deprecate
- **Discoverable:** Natural language routing to right skill

**Key Takeaway:** Skills are how Kai scales - each new domain gets its own skill, maintaining organization as the system grows.

---

# PART II: ARCHITECTURE

## Progressive Disclosure System

**Three-Tier Context Loading Architecture**

The most important pattern for token efficiency and cognitive clarity.

### How It Works

**Tier 1: System Prompt (Always Active)**
- Lives in skill `description:` YAML front matter
- Loaded automatically at Claude Code session start
- ~200-500 words of absolute essentials
- Triggers for skill activation
- Points to Tier 2 for comprehensive context

**Tier 2: SKILL.md Body (On-Demand)**
- Loaded when skill is activated
- Main reference content (~500-2000 lines)
- Complete workflows and routing logic
- Points to Tier 3 references when needed
- Self-contained for most operations

**Tier 3: Reference Files (Just-In-Time)**
- Flat .md files at skill directory root
- Individual deep-dive topics
- Loaded only when specific detail needed
- Examples: `security-protocols.md`, `delegation-patterns.md`

### Example: CORE Skill Loading

```yaml
---
name: CORE
description: |
  Kai core identity and infrastructure. Loaded at session start.
  Essential context: identity, contacts, stack prefs, security, voice routing
  Deep references: CONSTITUTION.md, security-protocols.md, etc.
---
```

**Loading Sequence:**
1. **Session Start** → CORE description loads → Auto-active
2. **User Question** → "How do I parallelize?" → Reads delegation-patterns.md
3. **Complex Task** → "Publish blog" → Loads writing skill → Follows workflow

### Why Progressive Disclosure?

**Token Efficiency:**
- Only load context that's actually needed
- Most tasks use Tier 1 + Tier 2
- Tier 3 loaded for specialized needs

**Cognitive Clarity:**
- User sees what matters for their request
- Not overwhelmed by full documentation
- Can drill down as needed

**Performance:**
- Faster skill activation
- Reduced context window usage
- Better response latency

---

## Skills-as-Containers Philosophy

### What Skills Are

**Skills are NOT:**
- Just markdown documentation
- Passive knowledge bases
- Simple file containers

**Skills ARE:**
- Active orchestrators
- Workflow routers
- Context managers
- Integration hubs

### Skills Package Domain Expertise

A skill is a complete package containing:

1. **Routing logic** - When to activate (triggers in system prompt)
2. **Workflows** - How to execute tasks (step-by-step procedures)
3. **Reference materials** - Deep knowledge (Tier 3 files)
4. **Supporting assets** - Templates, examples, tools
5. **Integration points** - Calls to other skills/agents

### Skill Structure Archetypes

**Minimal Skill:**
```
skill-name/
├── SKILL.md              # All context in one file
└── (optional assets/)
```

**Standard Skill:**
```
skill-name/
├── SKILL.md              # Core routing and context
├── workflow1.md          # Specific procedures
├── workflow2.md
├── reference.md          # Deep-dive topics
└── assets/
    └── templates/
```

**Complex Skill:**
```
skill-name/
├── SKILL.md              # Core orchestration
├── workflows/
│   ├── primary-flow.md
│   ├── advanced-flow.md
│   └── specialized/
├── reference/
│   ├── topic-a.md
│   └── topic-b.md
├── assets/
│   ├── templates/
│   └── examples/
├── tools/                # CLI tools (per CLI-First)
│   ├── cli.ts
│   └── lib/
└── tests/
```

### Alignment with Anthropic Framework

**Anthropic's Vision:**
✅ Skills as modular capabilities
✅ Filesystem-based, load on-demand
✅ Progressive loading pattern
✅ Package workflows and knowledge

**Kai's Extensions:**
➕ Skills contain Commands as internal organization
➕ Natural language auto-selection via system prompt
➕ Skills as meta-containers for all primitives
➕ CLI-First tooling integrated into skill structure

---

## System Prompt Routing Pattern

**THE MOST IMPORTANT ARCHITECTURAL PATTERN IN KAI**

This pattern enables natural language to activate structured workflows without manual skill selection.

### How Routing Works

Every skill uses this pattern in its `description:` field:

```yaml
---
name: skill-name
description: |
  [Brief description of skill purpose]

  USE WHEN user says '[trigger]', '[trigger2]', '[trigger3]'
  or [describes need matching skill domain].
---
```

**The Flow:**

1. **User makes request** in natural language
   ```
   User: "Create a blog post about AI safety"
   ```

2. **Claude Code matches request to skill description**
   - Scans all skill descriptions (Tier 1 loaded at session start)
   - Finds "writing" skill with triggers: "write blog", "create post", "publish blog"
   - Activates writing skill

3. **Skill SKILL.md loads and provides routing**
   ```markdown
   # Writing Skill

   ## When to Activate This Skill
   - "write blog" → workflows/blog/write.md
   - "publish blog" → workflows/blog/publish.md
   - "edit content" → workflows/edit-content.md
   ```

4. **Workflow executes** with full skill context

### Why This Is Critical

- ✅ Enables natural language → structured workflows
- ✅ No manual skill selection needed
- ✅ Skills discover and activate automatically
- ✅ User speaks naturally, system routes correctly
- ✅ Extensible: new skills auto-integrate

### Routing Pattern Standards

**DO:**
```yaml
description: |
  Complete business infrastructure.

  USE WHEN user says 'create proposal', 'consulting offer',
  'hormozi framework', 'check finances', 'benefits tracking'.
```

**DON'T:**
```yaml
description: Business skill  # Too vague, no triggers!
```

### Best Practices

1. Include 5-10 natural language triggers
2. Cover synonyms ("write blog", "create post", "draft article")
3. Include domain terms ("hormozi", "bug bounty", "OAuth")
4. Be specific about what skill handles
5. Update triggers as new workflows are added

### The 4-Level Routing Hierarchy

```
User Request
    ↓
Level 1: System Prompt Routing (Which skill?)
    ↓
Level 2: Skill Activation (Should this skill load?)
    ↓
Level 3: Internal Context Routing (What section of SKILL.md?)
    ↓
Level 4: Workflow Invocation (Which specific procedure?)
    ↓
Execution
```

**For complete routing guide, see:** `${PAI_DIR}/Skills/CORE/SkillSystem.md`

---

## The Four Primitives

**The building blocks of Kai's architecture.**

### 1. Skills: Meta-Containers for Domain Expertise

**When to Use:**
- Need competence in topic/domain
- Multiple related tasks in domain
- Want reusable workflows
- Package expertise (Research, Security, Writing)

**Example Structure:**
```
${PAI_DIR}/Skills/blogging/
├── SKILL.md                    # Core skill + routing
├── workflows/
│   ├── write.md               # Write blog workflow
│   └── publish.md             # Publish workflow
├── assets/
│   ├── frontmatter.md
│   └── style-guide.md
└── examples/
    └── example-post.md
```

### 2. Commands: Discrete Task Workflows Within Skills

**What They Are:**
- Specific task implementations within Skill domain
- Standalone markdown files with workflows
- Callable directly OR auto-selected
- Like "exported functions" from Skill module

**When to Use:**
- Discrete, repeatable task within domain
- Clear start/end and specific steps
- Want explicit OR natural language invocation
- Too specific for main SKILL.md

**Example:**
```markdown
# write-blog.md (Command)

## Trigger
User says: "write a blog", "create a post", "write an article"

## Workflow
1. Get content from user
2. Apply frontmatter template
3. Format in the user's voice
4. Start dev server
5. Open in Chrome for preview
```

### 3. Agents: Autonomous Task Executors

**What They Are:**
- Specialized entities with full tool access
- Independent context and instructions
- Can delegate to other agents
- Complete tasks autonomously

**When to Use:**
- Task requires autonomous decision-making
- Need specialized expertise (security, design, code)
- Multi-step workflow with branching logic
- Want parallel execution

**Agent Configuration:**
```
${PAI_DIR}/Agents/engineer.md

Frontmatter:
- voice_id: [ElevenLabs voice ID]
- capabilities: [what agent can do]

Body:
- Role definition
- Specialized instructions
- Tool access
- Delegation protocols
```

### 4. MCPs: External Tool Integrations

**What They Are:**
- External servers providing tools via Model Context Protocol
- Anthropic's standard for tool integration
- Running servers Claude Code connects to
- Profile-based configuration in Kai

**When to Use:**
- Need external API access
- Want persistent tool servers
- Integrate third-party services
- Extend Claude Code capabilities

**See [Two-Tier MCP Strategy](#two-tier-mcp-strategy) for Kai's approach to MCPs.**

---

## CLI-First Architecture

### The Pattern

```
Requirements → CLI Tool → Prompting Layer
   (what)      (how)       (orchestration)
```

**The Three-Step Process:**

1. **Understand Requirements** - Document everything the tool needs to do
2. **Build Deterministic CLI** - Create command-line tool with explicit commands
3. **Wrap with Prompting** - AI orchestrates the CLI, doesn't replace it

### Why CLI-First?

#### Old Way (Prompt-Driven)
```
User Request → AI generates code/actions ad-hoc → Inconsistent results
```

**Problems:**
- ❌ Inconsistent outputs (prompts drift, model variations)
- ❌ Hard to debug (what exactly happened?)
- ❌ Not reproducible (same request, different results)
- ❌ Difficult to test (prompts change, behavior changes)
- ❌ No version control (prompt changes don't track behavior)

#### New Way (CLI-First)
```
User Request → AI uses deterministic CLI → Consistent results
```

**Advantages:**
- ✅ Consistent outputs (same command = same result)
- ✅ Easy to debug (inspect CLI command that was run)
- ✅ Reproducible (CLI commands are deterministic)
- ✅ Testable (test CLI directly, independently of AI)
- ✅ Version controlled (CLI changes are explicit code changes)

### CLI Design Best Practices

**1. Command Structure**
```bash
# Good: Hierarchical, clear structure
tool command subcommand --flag value

# Examples:
evals use-case create --name foo
evals test-case add --use-case foo --file test.json
evals run --use-case foo --model claude-3-5-sonnet
```

**2. Idempotency**
```bash
# Same command multiple times = same result
evals use-case create --name foo  # Creates
evals use-case create --name foo  # Already exists, no error
```

**3. Output Formats**
```bash
# Human-readable by default
evals list use-cases

# JSON for scripting
evals list use-cases --json
```

**4. Progressive Disclosure**
```bash
# Simple for common cases
evals run --use-case newsletter-summary

# Advanced options available
evals run --use-case newsletter-summary \
  --model claude-3-5-sonnet \
  --prompt v2.0.0 \
  --verbose
```

### Prompting Layer Responsibilities

**The prompting layer should:**
- Understand user intent
- Map intent to appropriate CLI commands
- Execute CLI commands in correct order
- Handle errors and retry logic
- Summarize results for user
- Ask clarifying questions when needed

**The prompting layer should NOT:**
- Replicate CLI functionality in ad-hoc code
- Generate solutions without using CLI
- Perform operations that should be CLI commands
- Bypass the CLI for "simple" operations

### When to Apply CLI-First

**✅ Apply CLI-First When:**
1. **Repeated Operations** - Task will be performed multiple times
2. **Deterministic Results** - Same input should always produce same output
3. **Complex State** - Managing files, databases, configurations
4. **Query Requirements** - Need to search, filter, aggregate data
5. **Version Control** - Operations should be tracked and reproducible
6. **Testing Needs** - Want to test independently of AI
7. **User Flexibility** - Users might want to script or automate

**Examples:** Evaluation systems, content management, infrastructure management, data processing

**❌ Don't Need CLI-First When:**
1. **One-Off Operations** - Will only be done once or rarely
2. **Simple File Operations** - Just reading or writing a single file
3. **Pure Computation** - No state management or side effects

**Examples:** Reading a specific file once, quick data exploration, one-time refactoring

### Key Takeaway

**Build tools that work perfectly without AI, then add AI to make them easier to use.**

AI should orchestrate deterministic tools, not replace them with ad-hoc prompting.

**For complete CLI-First guide, see:** `${PAI_DIR}/Skills/CORE/cli-first-architecture.md`

### CLI-First for API Calls

**CRITICAL PATTERN: Never write API calls directly in prompts or bash scripts.**

When integrating external APIs, always follow this pattern:

#### The Old Way (Ad-Hoc Scripts) ❌

```bash
#!/bin/bash
# fetch-data.sh - fragile bash script

API_KEY=$LIMITLESS_API_KEY
URL="https://api.service.com/v1/data?param=$1"
curl -H "X-API-Key: $API_KEY" "$URL"
```

**Problems:**
- ❌ No validation of inputs
- ❌ No error handling
- ❌ No documentation (--help)
- ❌ Hard to test
- ❌ Difficult to maintain
- ❌ No type safety
- ❌ Code embedded in prompts

#### The New Way (CLI Tool) ✅

```typescript
#!/usr/bin/env bun
// cli-tool.ts - documented, testable CLI

/**
 * CLI tool for Service API
 * @author {{ENGINEER_NAME}}
 */

// Full TypeScript implementation with:
// - Input validation
// - Error handling
// - --help documentation
// - Type safety
// - Testability
// - Clean separation from prompts
```

**Benefits:**
- ✅ Validated inputs (date formats, required fields)
- ✅ Comprehensive error handling
- ✅ Full --help documentation
- ✅ Type-safe TypeScript
- ✅ Independently testable
- ✅ Version controlled
- ✅ Zero code in prompts

#### Canonical Example: llcli

**Location:** `${PAI_DIR}/bin/llcli/`

The Limitless.ai CLI demonstrates perfect CLI-First API integration:

**Structure:**
```
${PAI_DIR}/bin/llcli/
├── llcli.ts          # Main CLI implementation (TypeScript)
├── package.json      # Dependencies and metadata
└── README.md         # Full documentation
```

**Usage:**
```bash
# Documented commands
llcli --help
llcli today --limit 20
llcli date 2025-11-17
llcli search "keyword" --limit 50

# Clean JSON output (pipes to jq)
llcli today | jq '.data.lifelogs[].title'

# Composable with other tools
llcli search "consulting" | grep -i "quorum"
```

**Features:**
- ✅ Full --help system
- ✅ Input validation (date formats, required args)
- ✅ Error messages to stderr
- ✅ Exit codes (0 success, 1 error)
- ✅ JSON output to stdout
- ✅ TypeScript with types
- ✅ Environment config (${PAI_DIR}/.env)
- ✅ Composable (pipes to jq, grep, etc.)

#### Migration Pattern

**Before (Bash Script):**
```bash
# In skill prompt:
${PAI_DIR}/Skills/skill-name/scripts/fetch-data.sh today "" 20
```

**After (CLI Tool):**
```bash
# In skill prompt:
${PAI_DIR}/bin/toolname/toolname.ts today --limit 20
```

**Key Differences:**
1. **Location:** `/bin/` not `/Skills/.../scripts/`
2. **Language:** TypeScript not Bash
3. **Documentation:** --help not comments
4. **Validation:** Type-checked not string parsing
5. **Reusability:** System-wide not skill-specific

#### When to Create API CLI Tools

**✅ Create CLI Tool When:**
1. API will be called >5 times
2. Need to validate inputs (dates, formats, etc.)
3. Want composability (pipe to jq, grep)
4. API has multiple endpoints/modes
5. Need error handling and retries
6. Want independent testing
7. Future skills might use same API

**❌ Use MCP When:**
1. First time exploring API (Tier 1 MCP for discovery)
2. One-off API call
3. API changes frequently (discovery phase)

**Then migrate:** MCP → CLI tool (once you understand the API)

#### CLI Tool Checklist

Every API CLI tool must have:

- [ ] Full --help documentation
- [ ] Input validation with clear errors
- [ ] TypeScript with proper types
- [ ] Error messages to stderr
- [ ] JSON output to stdout
- [ ] Exit codes (0/1)
- [ ] README.md with examples
- [ ] Environment config (API keys in ${PAI_DIR}/.env)
- [ ] Located in ${PAI_DIR}/bin/toolname/
- [ ] Executable with shebang (#!/usr/bin/env bun)

#### Examples in Kai

Current CLI API tools:
- **llcli** - Limitless.ai API (`${PAI_DIR}/bin/llcli/`)

Future candidates:
- **ghcli** - GitHub API wrapper (cleaner than `gh`)
- **linearcli** - Linear issue management
- **notecli** - Notion API wrapper

**Key Principle:** API calls are infrastructure. Build them once as CLI tools, use them reliably forever.

---

## Two-Tier MCP Strategy

### The Problem with Traditional MCPs

Traditional MCP-only architectures have fatal flaws for production use:

❌ **Token Explosion**
- Pass full schemas (1000s of tokens per call)
- Return unfiltered datasets (50,000+ tokens)
- No ability to filter before model context
- Costs spiral quickly with frequent use

❌ **No Type Safety**
- Dynamic schemas discovered at runtime
- No IDE autocomplete or validation
- Runtime errors instead of compile-time checks

❌ **No Code-Time Optimization**
- Can't filter data before it reaches model
- Can't reuse transformation logic
- Every call starts from scratch

### The Two-Tier Solution

**Tier 1: Legacy MCPs - Discovery Phase**

**Location:** `${PAI_DIR}/MCPs/`

**When to Use:**
- ✅ First time using an API/service
- ✅ Discovering what endpoints/actors exist
- ✅ Understanding capabilities and schemas
- ✅ One-time exploration tasks
- ✅ Prototyping new integrations

**Characteristics:**
- High token cost (schemas + full datasets)
- No type safety
- Dynamic discovery
- Flexible but inefficient
- Great for learning, bad for production

**Tier 2: System MCPs - Execution Phase**

**Location:** `${PAI_DIR}/Skills/system-mcp/`

**When to Use:**
- ✅ API will be called >10 times
- ✅ Need to filter large datasets
- ✅ Token costs are significant
- ✅ Want type safety and autocomplete
- ✅ Need reusable helper functions

**Implementation:**
- File-based TypeScript wrappers
- Direct API calls (not MCP protocol)
- Type-safe interfaces
- Pre-filter data before model context
- 99% token savings

**Example:**
```typescript
// system-mcp/providers/brightdata/actors.ts
import { scrapeAsMarkdown } from './api';

// Type-safe, token-efficient
const result = await scrapeAsMarkdown(url);
// Data filtered BEFORE entering model context
```

**Workflow:**
1. **Discovery** - Use legacy MCP to explore API
2. **Document** - Record actor IDs, schemas, examples
3. **Implement** - Create TypeScript wrapper in system-mcp
4. **Execute** - Use `bun run script.ts` for deterministic calls
5. **Retire MCP** - Move legacy MCP to `unused/` directory

### Key Principle

**Discovery via MCP → Production via CLI-First TypeScript**

This follows the CLI-First principle: Build deterministic tools, wrap with AI orchestration.

---

# PART III: OPERATIONS

## Critical Systems

### 1. Structured Output Format + Voice Integration

**THE VOICE FEEDBACK ARCHITECTURE**

Kai uses mandatory structured output format that integrates with voice server for spoken feedback.

**The Format (MANDATORY):**
```markdown
📋 SUMMARY: Brief overview
🔍 ANALYSIS: Key findings
⚡ ACTIONS: Steps taken with tools used
✅ RESULTS: Outcomes and changes
📊 STATUS: Current state
📁 CAPTURE: [Required - context for this session]
➡️ NEXT: Recommended follow-ups
📖 STORY EXPLANATION: [8 lines - narrative summary of what happened]
🎯 COMPLETED: [What finished - 12 words max]
```

**Why COMPLETED Line Is Critical:**
- **Voice Integration:** This line is spoken aloud via ElevenLabs
- **User Feedback:** The user hears completion via agent-specific voice
- **Event Logging:** Captured to history/raw-outputs/
- **Status Tracking:** Enables observability dashboard

**Voice Integration Flow:**

1. **Kai/Agent completes task**
   ```markdown
   🎯 COMPLETED: Blog post published and verified live on production
   ```

2. **Stop hook fires** (`${PAI_DIR}/Hooks/stop-hook.ts`)
   - Reads transcript after response
   - Extracts COMPLETED line text
   - Determines entity (Kai vs specific agent)

3. **Voice request sent** to server
   ```bash
   curl -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{
       "message": "Blog post published and verified live on production",
       "voice_id": "s3TPKV1kjDlVtZbl4Ksh",
       "title": "Kai"
     }'
   ```

4. **Voice server processes** (`${PAI_DIR}/voice-server/server.ts`)
   - Sanitizes message (security)
   - Calls ElevenLabs API with voice_id
   - Receives MP3 audio
   - Plays via afplay (macOS)
   - Shows macOS notification

5. **The user hears completion** in agent-specific voice

**COMPLETED Line Writing Standards:**

**DO:**
```markdown
🎯 COMPLETED: Blog post published and verified on Cloudflare
🎯 COMPLETED: Security scan found no secrets in 47 files
🎯 COMPLETED: Parallel interns updated 10 agent configs successfully
```

**DON'T:**
```markdown
🎯 COMPLETED: Completed the task  # Redundant "completed"
🎯 COMPLETED: Successfully accomplished the user's request...  # Too long!
🎯 COMPLETED: Done  # Too vague
```

**Rules:**
- Target 8-12 words (spoken aloud, must sound natural)
- NEVER say "Completed" in the line (sounds terrible: "Completed completed...")
- Direct answer for questions, not meta-descriptions
- Describe WHAT finished, not THAT you finished

**Complete voice routing: `${PAI_DIR}/voice-server/USAGE.md`**

### 2. History System

**THE PERMANENT KNOWLEDGE BASE**

**Location:** `${PAI_DIR}/History/`

**Purpose:** Capture ALL valuable work for future reference, learning, and analysis.

**Directory Structure:**
```
${PAI_DIR}/History/
├── raw-outputs/              # Raw event logs (JSONL)
│   └── YYYY-MM/
│       └── YYYY-MM-DD_all-events.jsonl
│
├── learnings/                # Problem-solving narratives
│   └── YYYY-MM/
│       └── YYYY-MM-DD-HHMMSS_LEARNING_description.md
│
├── sessions/                 # Work logs and summaries
│   └── YYYY-MM/
│       └── YYYY-MM-DD-HHMMSS_SESSION_description.md
│
├── research/                 # Analysis and investigations
│   └── YYYY-MM-DD_topic/
│       ├── analysis.md
│       ├── findings.md
│       └── sources.md
│
├── execution/                # Command outputs and results
│   └── YYYY-MM/
│       └── YYYY-MM-DD-HHMMSS_command-name.txt
│
└── upgrades/                 # Architectural changes
    ├── deprecated/
    │   └── YYYY-MM-DD_upgrade-name/
    │       ├── README.md
    │       └── [deprecated files]
    └── YYYY-MM-DD_upgrade-description.md
```

**How History Is Populated:**

1. **Automatic (via Hooks)**
   - `start-hook.ts` - Logs session start
   - `stop-hook.ts` - Logs completion + voice
   - `tool-hook.ts` - Logs tool usage
   - All events → `raw-outputs/YYYY-MM/YYYY-MM-DD_all-events.jsonl`

2. **Manual (by Kai)**
   - Research completed → save to `research/`
   - Learning captured → save to `learnings/`
   - Work summary → save to `sessions/`

3. **Workflow-Driven**
   - Some skills auto-save outputs
   - Example: research skill → `history/research/`

**Scratchpad vs History:**

**Scratchpad** (`${PAI_DIR}/scratchpad/`):
- TEMPORARY working files
- Tests and experiments
- Draft outputs before finalization
- Random one-off requests
- Delete when done

**History** (`${PAI_DIR}/History/`):
- PERMANENT valuable outputs
- Research findings
- Learnings and insights
- Session logs
- Keep forever

**Critical Rule:** When in doubt, save to history!

### 3. Hook System

**EVENT-DRIVEN AUTOMATION**

**Location:** `${PAI_DIR}/Hooks/`

**Purpose:** Automatically capture events, trigger actions, and integrate systems without explicit calls.

**Hook Types:**

1. **start-hook.ts** - Fires at session start
   - Logs session ID
   - Initializes context
   - Sets up environment

2. **stop-hook.ts** - Fires after every response
   - Parses COMPLETED line
   - Routes to voice server
   - Logs completion event
   - Updates observability

3. **tool-hook.ts** - Fires on tool use
   - Logs tool calls
   - Tracks file access
   - Monitors system commands

4. **prompt-submit-hook.ts** - Fires when user sends message
   - Can validate input
   - Can inject context
   - Can modify prompts

**Reference:** `${PAI_DIR}/Skills/CORE/hook-system.md`

### 4. Agent System

**MULTI-AGENT ORCHESTRATION**

**Kai's 12+ Specialized Agents:**

| Agent | Purpose | Voice ID |
|-------|---------|----------|
| kai | Main orchestrator, delegates tasks | s3TPKV1kjDlVtZbl4Ksh |
| intern | High-agency genius generalist | d3MFdIuCfbAIwiu7jC4a |
| engineer | TDD implementation with spec-driven dev | fATgBRI8wg5KkDFg8vBd |
| principal-engineer | Strategic architecture + planning | iLVmqjzCGGvqtMCk6vVQ |
| architect | System design + specifications | muZKMsIDGYtIkjjiUS82 |
| designer | UX/UI design + visual systems | ZF6FPAbjXT4488VcRRnw |
| artist | AI image generation + creative prompts | ZF6FPAbjXT4488VcRRnw |
| pentester | Security testing + vulnerability assessment | xvHLFjaUEpx4BOf7EiDd |
| writer | Content creation + blog management | gfRt6Z3Z8aTbpLfexQ7N |
| perplexity-researcher | Web research via Perplexity API | AXdMgz6evoL7OPd7eU12 |
| claude-researcher | Multi-query research with WebSearch | AXdMgz6evoL7OPd7eU12 |
| gemini-researcher | Multi-perspective Gemini research | 2zRM7PkgwBPiau2jvVXc |

**Delegation Patterns:**

**Sequential Delegation:**
```
Kai → Engineer → Implementation complete
```

**Parallel Delegation:**
```
Kai → [Intern1, Intern2, Intern3] → All complete → Kai synthesizes
```

**Nested Delegation:**
```
Kai → Architect (designs) → Engineer (implements) → Kai verifies
```

**Spotcheck Pattern:**
```
Kai → [10 Interns update files] → Spotcheck Intern (verifies all 10)
```

**Reference:**
- `${PAI_DIR}/Skills/CORE/delegation-patterns.md`
- `${PAI_DIR}/Skills/CORE/agent-protocols.md`

### 5. MCP Profile Management

**CONTEXT-SPECIFIC TOOL CONFIGURATION**

**Location:** `${PAI_DIR}/MCPs/`

**Purpose:** Swap tool configurations based on work type without restarting Claude Code manually.

**Available Profiles:**

| Profile | Tools Included | Use Case |
|---------|---------------|----------|
| none | No MCPs | Maximum performance |
| minimal | content, daemon | Basic operations |
| chrome-enabled | minimal + Chrome DevTools | Web testing |
| dev-work | minimal + Shadcn, Codex, Supabase | Development |
| security | minimal + httpx, naabu | Security testing |
| research | minimal + Brightdata, Apify, Chrome | Research tasks |
| full | All MCPs | Everything enabled |

**Profile Switching:**
```bash
# Show current profile
${PAI_DIR}/MCPs/swap-mcp

# Switch to profile
${PAI_DIR}/MCPs/swap-mcp chrome-enabled

# MUST restart Claude Code to apply!
```

**Reference:** `${PAI_DIR}/Skills/CORE/mcp-strategy.md`

---

## Directory Structure

**Complete ${PAI_DIR}/ Map:**

```
${PAI_DIR}/
│
├── skills/                           # Domain expertise packages
│   ├── CORE/                        # Kai identity + infrastructure
│   │   ├── SKILL.md                 # Main Kai skill (Tier 2)
│   │   ├── CONSTITUTION.md          # This file
│   │   ├── MY_DEFINITIONS.md        # Canonical definitions
│   │   ├── *.md                     # Reference files (Tier 3)
│   │   └── workflows/               # Infrastructure tools
│   │
│   └── [30+ domain skills]/         # Research, development, business, etc.
│
├── agents/                          # Specialized agent configs
│   ├── kai.md
│   ├── intern.md
│   ├── engineer.md
│   └── [10+ more agents].md
│
├── hooks/                           # Event-driven automation
│   ├── start-hook.ts               # Session start
│   ├── stop-hook.ts                # Voice + logging
│   ├── tool-hook.ts                # Tool tracking
│   └── prompt-submit-hook.ts       # Prompt pre-processing
│
├── history/                         # Permanent knowledge base
│   ├── raw-outputs/                # JSONL event logs
│   ├── learnings/                  # Problem-solving narratives
│   ├── sessions/                   # Work logs
│   ├── research/                   # Analysis outputs
│   ├── execution/                  # Command outputs
│   └── upgrades/                   # Architectural changes
│
├── scratchpad/                      # Temporary working files
│   └── YYYY-MM-DD-HHMMSS_*/        # Dated subdirectories
│
├── voice-server/                    # ElevenLabs TTS integration
│   ├── server.ts                   # Main server
│   ├── manage.sh                   # Control script
│   └── macos-service/              # LaunchAgent
│
├── MCPs/                           # MCP profile management
│   ├── swap-mcp                    # Profile switcher
│   └── profiles/                   # Profile configs
│
├── .env                            # API keys and credentials
├── settings.json                   # Claude Code configuration
└── mcp-profile.txt                 # Current active profile
```

**Key Directories:**

- **skills/** - All domain expertise lives here
- **agents/** - Specialized agent configurations
- **hooks/** - Event-driven automation
- **history/** - Permanent knowledge (NEVER delete)
- **scratchpad/** - Temporary workspace (DELETE when done)
- **voice-server/** - Text-to-speech system

---

## Operational Patterns

### Creating New Skills

**SKILL.md Template:**
```markdown
---
name: my-skill
description: |
  [Skill purpose]

  USE WHEN user says '[trigger1]', '[trigger2]', '[trigger3]'.
---

# My Skill

## 🎯 Load Full CORE Context

read ${PAI_DIR}/Skills/CORE/SKILL.md

## When to Activate This Skill

- "trigger1" → workflow1
- "trigger2" → workflow2

## Workflows

### Workflow 1
1. Step 1
2. Step 2
3. Step 3
```

**Best Practices:**
1. Clear, specific triggers in description
2. Load CORE context at top of SKILL.md
3. Organized workflows with clear steps
4. Reference files for deep dives
5. Assets/examples for templates

**Reference:** `${PAI_DIR}/Skills/CORE/SkillSystem.md`

### Adding Workflows

**Workflow Format:**
```markdown
# My Workflow

## Purpose
[What this workflow accomplishes]

## Triggers
- "user phrase 1"
- "user phrase 2"

## Prerequisites
- [What must be true before starting]

## Steps

### 1. [Step Name]
[Detailed instructions]

### 2. [Step Name]
[Detailed instructions]

## Validation
[How to verify success]

## Rollback
[How to undo if needed]
```

### Configuring Agents

**Agent Template:**
```markdown
---
name: agent-name
voice_id: [ElevenLabs voice ID]
---

# Agent Name

## Role
[Agent's purpose and specialization]

## Capabilities
- [What agent can do]
- [Specialized knowledge]
- [Tool access]

## Voice Configuration
**Voice ID:** [ElevenLabs voice ID]
**When to use voice:** ALWAYS (mandatory)

## Instructions
[Detailed behavior and patterns]

## Delegation
[When to delegate to other agents]

## Output Format
[Use standard COMPLETED format]
```

**Reference:** `${PAI_DIR}/Skills/CORE/agent-protocols.md`

---

## Testing & Quality

### Core Principle

**If it can be tested, it must be tested.**

### The Testing Hierarchy

1. **CLI Tools** - Unit test independently of AI
2. **Workflows** - Integration test with real tool calls
3. **AI Layer** - End-to-end test with real user requests
4. **Regression** - Automated test suite for all critical paths

### CLI-First Testing Benefits

**Because we build CLI tools first:**
- ✅ Tools can be tested without AI
- ✅ Tests are deterministic (no prompt variations)
- ✅ Fast feedback loops (no model calls needed)
- ✅ Comprehensive coverage (test every command)
- ✅ Regression detection (CLI behavior locked in)

### Test-Driven Development (TDD)

**Standard workflow for all implementations:**

1. **Write test first** - Define expected behavior
2. **Run test (fails)** - Verify test actually tests something
3. **Implement** - Write minimal code to pass test
4. **Run test (passes)** - Verify implementation works
5. **Refactor** - Clean up while tests still pass
6. **Repeat** - Build feature incrementally

### Quality Gates

**Before declaring work complete:**

1. **Unit Tests Pass** - All CLI commands tested
2. **Integration Tests Pass** - Workflows execute correctly
3. **Visual Validation** - Screenshots verify appearance (for web)
4. **Deployment Verified** - Production site checked (for deployed systems)
5. **Documentation Updated** - Changes documented

**Never skip quality gates.** If testing reveals issues, fix them before completion.

**Reference:** `${PAI_DIR}/Skills/CORE/TESTING.md`

---

## Architectural Principles Summary

### The Ten Commandments of Kai Architecture

1. **Command Line First** - Build CLI tools before AI wrappers
2. **Deterministic Code First** - Same input always produces same output
3. **Prompts Wrap Code** - AI orchestrates tools, doesn't replace them
4. **Progressive Disclosure** - Load context only when needed (3 tiers)
5. **Skills-as-Containers** - Package expertise with routing and workflows
6. **System Prompt Routing** - Natural language triggers automatic skill activation
7. **Two-Tier MCP Strategy** - Discovery via MCP, production via TypeScript
8. **The Four Primitives** - Skills, Commands, Agents, MCPs work together
9. **Test-Driven Development** - All tools tested independently before AI integration
10. **Quality Gates** - Never skip validation steps before declaring completion

### When Building New Kai Systems

**Always ask:**
1. Can this be a CLI tool? (If yes → build CLI first)
2. Will this be called >10 times? (If yes → make it deterministic)
3. Does this need AI? (AI should orchestrate, not implement)
4. What's the routing trigger? (Define in skill description)
5. Where does this fit? (Skill, Command, Agent, or MCP?)
6. How do I test this? (Write tests before implementation)
7. What tier is this context? (System prompt, SKILL.md, or reference file?)

### Evolution and Adaptation

**This constitution is living:**
- Update as new patterns emerge
- Deprecate outdated approaches
- Document architectural decisions
- Learn from production use
- Continuously improve

**But core principles remain:**
- CLI-First
- Deterministic Code
- Prompts Wrap Code
- Scaffolding > Model
- As Deterministic as Possible
- Code Before Prompts

**These are non-negotiable foundations that ensure Kai remains dependable, maintainable, and effective.**

---

## Related Documentation

**For implementation details, see:**
- Skill structure patterns: `SkillSystem.md`
- CLI-First detailed guide: `cli-first-architecture.md`
- MCP strategy full details: `mcp-strategy.md`
- Testing comprehensive guide: `TESTING.md`
- Security protocols: `security-protocols.md`
- Voice system: `${PAI_DIR}/voice-server/USAGE.md`
- Agent protocols: `agent-protocols.md`
- Delegation patterns: `delegation-patterns.md`

---

**END OF CONSTITUTION**

**This document defines what Kai is and how Kai works at the most fundamental level.**
