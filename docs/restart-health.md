# Restart health check and rollback

Every restart that follows a dist rebuild (`pai worker merge`, `pai release`) is gated:

1. Before the build, `dist` is copied to `dist.prev` (one generation) and the runtimes that are up (for example gyro-l) are recorded.
2. After the restart, within 60 s: the daemon pid is alive and answers its status call; the router answers `GET /cockpit/data` with 200 on its configured bind and on loopback; each recorded runtime is reachable or busy (busy is not down).
3. On failure `dist.prev` is restored, the daemon is restarted on it and checked again, the merge is reverted in git, the ledger gets `RESTART-HEALTH` and `WORKER-MERGE-RESTART-ROLLBACK`, the owning session's mailbox is notified, and the output says `restart failed health check: <what>; rolled back to <old version>`.

## What the AIBroker dist-watch self-restart must provide

AIBroker has its own dist-watch restart (separate repo, not changed from PAI). PAI expects it to: keep the previous dist generation before swapping; after restarting, answer its status call and serve the router on the configured bind within 60 s; and on failure restart on the previous generation instead of staying down.
