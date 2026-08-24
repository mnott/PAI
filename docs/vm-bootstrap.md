# Installing PAI from zero on a clean macOS

Written against a freshly installed macOS VM with nothing added, so the starting
point is known rather than assumed. Every "present" and "missing" below was
measured on that machine, not inferred from what a Mac usually has.

## Baseline: what a clean macOS actually gives you

    macOS 26.6 (25G72), arm64
    disk 222 GB free of 256 GB
    8 GB RAM, 4 CPUs

Present in `/usr/bin` on a clean system:

| tool | note |
|---|---|
| `curl` | real, works |
| `sqlite3` | real, works |
| `jq` | real, works |
| `git` | **shim only** — see below |
| `python3`, `pip3` | **shim only** — see below |
| `xcode-select` | present, but no tools behind it |

Missing entirely: `brew`, `node`, `npm`, `npx`, `bun`, `gh`, `docker`, `uv`,
and the Claude Code CLI.

## The trap: `git` and `python3` look installed and are not

`command -v git` succeeds and prints `/usr/bin/git`, which reads as "git is
available". It is not. Those paths are stubs that hand off to the Xcode Command
Line Tools, and with no CLT installed they fail:

    $ git --version
    xcode-select: error: No developer tools were found and no install could be
    requested (possibly because there is no active GUI session).

So any bootstrap script that checks `command -v git` will conclude git is present
and then fail later, somewhere less obvious. Check `git --version` — the thing
you actually need — not the path.

## Step 0: Xcode Command Line Tools

Everything else depends on this: Homebrew needs it, and node-gyp builds need it
for native modules.

`xcode-select --install` opens a GUI dialog, which is unavailable over a remote
exec channel. The headless route:

```bash
# Marker file makes softwareupdate offer the CLT package
sudo touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
LABEL=$(softwareupdate -l 2>/dev/null \
  | grep -B1 "Command Line Tools" \
  | awk -F'Label: ' '/Label:/ {print $2}' \
  | tail -1)
sudo softwareupdate -i "$LABEL" --verbose
sudo rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
```

Verify with `git --version` returning an actual version, not an error.

## Step 1 onward — ordered by dependency

1. **Xcode CLT** — above. Blocks everything.
2. **Homebrew** — the install script needs CLT and a working `curl`.
3. **Node** (via brew or nvm). PAI targets a current LTS; `better-sqlite3` and
   friends are native modules, hence the CLT dependency.
4. **Claude Code CLI** — the client PAI's hooks and skills attach to.
5. **Docker** — only if using the Postgres/pgvector backend. On 8 GB RAM this is
   the component to think hardest about; the SQLite backend needs no container.
6. **PAI itself** — `npm i -g @tekmidian/pai`, then its setup flow.

## Capacity note, stated before it bites

8 GB RAM and 4 CPUs is a demo-sized machine. PAI's embedder is CPU-hungry and
Postgres wants memory of its own. For a walkthrough that must simply *work*,
prefer the SQLite backend and leave pgvector as an optional later step, rather
than opening with a container that competes with the embedder for RAM.

## Verifying, rather than assuming

Two habits this baseline argues for:

- Check what the tool *does*, not that a path exists. `command -v` was wrong
  about both `git` and `python3` here.
- Take the inventory on the target machine. A developer Mac has CLT, Homebrew
  and Node installed years ago and forgotten; none of that is true on a clean
  system, and the difference is invisible from the developer's own shell.
