# PAI Knowledge OS

## Local AI used to be hard. Now it is a button.

I have spent a long time on local AI. Getting a strong model to run on my own machine was the easy part; making it actually useful was not. Which server, which quantization, which port, how to keep it alive, how to send it only the work it can do, and how to fall back to the cloud when it cannot. Every piece worked on its own and none of them worked together.

PAI is what came out of that, and I am giving it to the community. A MacBook can already run a serious model: on mine, [Strata](https://github.com/Niko1221/Strata) serves [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) in its compact [Gyro-M](https://huggingface.co/agentionai/Qwen3.8-Flash-Next-Gyro-GGUF) quantization, and PAI turns that into a worker like any other. Start it from the cockpit, and PAI routes worker jobs to it automatically, shows its speed and cache live, and hands a job to the cloud only when it needs a wider context or deeper reasoning than the local model has. You stop thinking about local AI. It just takes its share of the work.

**An AI chat is one vendor, one model, one budget and no memory. PAI turns it into a team: it remembers, it routes every job to the right model, cloud or local, and it shows you all of it live.**

You burn your premium tokens on work a local model could do. You hit the weekly limit on a Tuesday. Every new session starts from zero. PAI fixes all three:

- **Not bound to Anthropic.** Claude Code is only the front end you type into; the model behind it is your choice. Run a whole session on GLM, Kimi, any other provider you add, or a model on your own machine, with no Anthropic model involved at all. Or mix them: switch on the fly with `/model`, in the middle of a session, without losing your place.
- **Model routing, cloud and local.** When one provider's budget runs out, the next one takes over by itself, and every request is accounted per provider and per session.
- **A hierarchy that spends tokens where they matter.** Three tiers: `t0` the session you talk to, `t1` the orchestrator that plans and reviews, `t2` the workers that implement. Workers go local first, because local tokens are free. Cloud comes first only where it earns its price: wide context and real reasoning. And all of it is yours to set: each tier is an ordered list of models, the first available one serves, and you change the order as your default (`pai worker route set t2 local,glm/glm-5.3-flash`, or from the cockpit) or just for one session (`--session <name>`), without touching the others. Every worker runs in its own visible pane and git worktree; you review the diff, PAI merges it.
- **A live cockpit.** One page shows your token budget per provider, cache hits, every model and local server with start and stop buttons, running workers, routing per tier, and memory and embedding progress. Drag the cards into the layout you want.
- **Memory underneath it all.** Every session writes its own notes in the background, searchable across sessions, projects and your notes vault, by keyword, meaning or both. Everything stays on your machine.

**What's inside**

- Sessions: [pick and open](docs/features.md#pick-and-open-a-session) · [pause and end](docs/features.md#pause-and-end-a-session) · [session notes](docs/features.md#session-notes) · [context preservation](docs/features.md#context-preservation-and-auto-compact)
- Memory and search: [search memory](docs/features.md#search-your-memory) · [knowledge graph](docs/features.md#knowledge-graph) · [embeddings](docs/features.md#index-and-embeddings) · [observations](docs/features.md#observations)
- Notes and vault: [connect two ideas](docs/features.md#connect-two-ideas) · [find orphans](docs/features.md#find-orphans) · [what is emerging](docs/features.md#what-is-emerging) · [trace an idea](docs/features.md#trace-an-idea)
- Zettelkasten: [explore links](docs/features.md#explore-links) · [surprising connections](docs/features.md#surprising-connections) · [ask the vault](docs/features.md#ask-the-vault) · [vault health](docs/features.md#vault-health)
- Journal, review, plan: [journal](docs/features.md#journal) · [review](docs/features.md#review) · [plan](docs/features.md#plan)
- Tasks and ingress: [Todoist](docs/features.md#todoist-as-an-input-channel) · [GitHub issues](docs/features.md#github-issues-as-an-input-channel) · [PAILot](docs/features.md#pailot-as-an-input-channel) · [WhatsApp](docs/features.md#whatsapp-as-an-input-channel) · [Telegram](docs/features.md#telegram-as-an-input-channel)
- Workers: [run a worker](docs/features.md#run-a-worker) · [tiers and routing](docs/features.md#tiers-and-routing) · [local models](docs/features.md#local-models) · [plans](docs/features.md#plans) · [queue](docs/features.md#queue)
- Router and cockpit: [router](docs/features.md#router) · [cockpit](docs/features.md#cockpit) · [where tokens go](docs/features.md#where-tokens-go)
- Messaging and rules: [AIBroker](docs/features.md#aibroker) · [whisper rules](docs/features.md#whisper-rules) · [budget advisor](docs/features.md#budget-and-advisor-mode)
- Make and share: [art and diagrams](docs/features.md#art-and-diagrams) · [share](docs/features.md#share) · [research](docs/features.md#research-and-extraction)
- Care: [setup](docs/features.md#setup-and-update) · [backup](docs/features.md#backup-and-restore)

Everything PAI does: [docs/features.md](docs/features.md)

**How it fits together**

![PAI architecture: Claude Code with PAI hooks and skills; the PAI core with CLI, daemon, storage and notes; the router on port 8790 with tiers t0, t1 and t2 and the cockpit; workers in their own panes and worktrees; model providers Anthropic, other cloud and local models; AIBroker for messaging; the Todoist task bus](docs/images/architecture.svg)

*Source: [docs/images/architecture.drawio](docs/images/architecture.drawio), editable in draw.io.*

`pai` starts or resumes a session in the current project. `pai pause` and `pai end` save your place. Memory works on its own; the router, workers and cockpit join when you want them. Terms are explained in the [glossary](docs/README.md#words-used-in-these-docs).

**Install it in one sentence: tell Claude Code "Clone https://github.com/mnott/PAI and set it up for me".** [Jump to install](#install).

![Cockpit: system memory, load, temperature and power, local model server speed, and tokens per bucket and per day per model](docs/images/cockpit-01-system-tokens.jpg)

![Cockpit: totals in the window, cache hit ratio per model, local prefix cache and providers](docs/images/cockpit-02-totals-cache.jpg)

![Cockpit: local servers with their instances, the models with start and stop, and the worker pool](docs/images/cockpit-03-local-servers-models-pool.jpg)

![Cockpit: workers running and waiting, and the memory section with backend, passes, embedding and index progress](docs/images/cockpit-04-workers-memory.jpg)

![Cockpit: performance details with the cache verdict by pause and sessions by tokens](docs/images/cockpit-05-performance.jpg)

![Cockpit: worker runs, speed per model, and routing with one line per delegation tier](docs/images/cockpit-06-runs-speed-routing.jpg)

![Cockpit: settings with the model registry editor and its backups](docs/images/cockpit-07-settings-registry.jpg)

*The router cockpit (`http://127.0.0.1:8790/cockpit`). See [the cockpit page](docs/cockpit.md).*

## Install

Prerequisites: [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer. Docker is only needed for the optional PostgreSQL storage (semantic search); the default sqlite needs nothing.

The easy way: tell Claude Code

> Clone https://github.com/mnott/PAI and set it up for me

Claude reads this repository, finds the setup skill and walks you through it: it checks each phase first, does only what is missing, and ends with a pass/fail list of its checks.

Or install it as a plugin, then say **"set up PAI"**:

```
/plugin marketplace add mnott/PAI
/plugin install pai@pai
```

Setup also installs [AIBroker](https://github.com/mnott/AIBroker), a separate project that is PAI's messaging layer: messages between sessions, worker reports to the session that started them, terminal tab names, and WhatsApp, Telegram and PAILot all go through it. PAI starts without it, but none of that works until it is there. To install it by hand:

```bash
npm install -g aibroker@^0.62.4
aibroker setup      # service, MCP registration, Claude Code hooks
aibroker doctor     # every check green, or it says exactly what to fix
```

Without the plugin, from a clone, or for a one-session plugin load: [docs/install/index.md](docs/install/index.md). Memory works as soon as setup is done; workers are optional ([First workers](docs/install/first-workers.md)).

## Where to go next

### Install

[Install](docs/install/index.md) · [First workers](docs/install/first-workers.md)

### Concepts

[Workers](docs/concepts/workers.md) · [delegation tiers](docs/concepts/delegation-tiers.md) · [panes](docs/concepts/panes.md) · [providers](docs/concepts/providers.md), and the rest in [docs/README.md](docs/README.md).

### Cockpit

[The cockpit page](docs/cockpit.md): sections, aliases, layout.

### Reference

[Configuration](docs/config.md) · [Config defaults](docs/config-defaults.md) · [Commands](docs/commands/README.md) (generated from the CLI: `pai help`, `pai more`, `pai help <command>`)

The full index, including memory, search and developer docs, is [docs/README.md](docs/README.md).

## Daily use

```bash
pai                 # picker: newest sessions first, type to filter, Enter opens
pai NAME            # open a session by name
pai ls              # the same list as a plain table
pai more            # every other command, grouped
pai help <command>  # full help for one command
```

`pai pause` saves your place before you leave a session and `pai end` finishes it.

## Acknowledgments

Inspired by Daniel Miessler's Personal AI Infrastructure, claude-mem, Cognee and PageIndex. Full credit and links: [docs/README.md](docs/README.md#acknowledgments).

## License

MIT
