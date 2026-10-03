# Linux, from zero (Ubuntu)

Both paths below were run end to end on a fresh Ubuntu 26.04 (arm64) install: setup, daemon, statusline in Claude Code, and a real `pai worker run`.

Prerequisite: Claude Code installed.

Common start:

```bash
sudo apt install -y nodejs npm tmux
npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"   # global npm installs without sudo
npm i -g @tekmidian/pai
```

**Keyword search only (SQLite, no Docker):**

```bash
pai setup --yes --storage sqlite
```

**Keyword and semantic search (PostgreSQL + pgvector in Docker):**

```bash
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"                  # then log out and in, or prefix the next command with: sg docker -c "…"
export PAI_PG_SHARED_BUFFERS=256MB               # only on small machines; the default 1GB must fit in RAM
export PAI_PG_SHM_SIZE=3g                        # optional; shared memory for parallel vector index builds (3g is the default)
pai setup --yes --storage postgres
```

Setup starts the `pai-pgvector` container itself (`pgvector/pgvector:pg17`, bound to 127.0.0.1:5432, data in `~/.pai/pgdata`). The daemon waits for the database, so the first start of the container can take its time.

Either way, setup skips macOS-only steps, installs the daemon as a systemd user unit, and turns workers on with the built-in `anthropic` provider. Inside tmux, `pai worker run` opens its follow pane as a tmux split; elsewhere use `pai worker follow <id>`. Setup also enables systemd linger itself so the daemon survives logout, and prints the `sudo loginctl enable-linger` command if the system does not allow it. Where systemd is absent (containers), run the daemon with `pai daemon serve`.
