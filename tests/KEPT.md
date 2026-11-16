# Kept tests

Tests are governed: a test file stays only with evidence. (a) a real product bug it guarded (fixing commit), (b) it pins a security guard or destructive-operation block, (c) it pins an external contract other software depends on. One-time tests are discarded after use. Add a file here with its evidence or do not commit it. Run the core with `PAI_VITEST_MAX_WORKERS=2 npx vitest run`.

| File | Class | Evidence |
| --- | --- | --- |
| src/hooks/ts/lib/worker-git-guard.test.ts | b | worker git safety: blocks in-place tree rewrites (4ab5a68c, d68822af) |
| src/hooks/ts/lib/worker-bash-rules.test.ts | b | worker Bash block rules (rm and friends) |
| src/hooks/ts/pre-tool-use/security-validator.test.ts | b | force-push / destructive command blocks; 7b2782a8 fixed --force-with-lease |
| src/utils/no-token-literals.test.ts | b | credential literals must not be committed (64ed9ffa, 6d4ba5e3) |
| src/storage/foreign-config-guard.test.ts | a,b | foreign config on the live DB cannot run destructive ops (b96fdb78) |
| src/storage/backup-safety.test.ts | a,b | safety snapshot before restore (1dcedeea) |
| src/cli/commands/lifecycle/restore-safety.test.ts | a,b | restore into the resolved DB, refuse source mismatch (15e96cb2, 52d8df09) |
| src/registry/worktree-guard.test.ts | a | linked worktrees / worker log dirs never registered as projects (31aa98eb, 270ef3c1) |
| src/router/wire/wire.test.ts | c | router wire format for OpenAI/Anthropic clients (74feddea) |
| src/registry/migrate.test.ts | c | registry schema migration (51555620) |
| src/config/home-migrate.test.ts | c | ~/.pai home migration (d1c1a781) |
| src/cli/docs-sync.test.ts | c | docs/commands must match command definitions (89e74fa4, df809929) |
| src/cli/docs-keys.test.ts | c | documented config keys and commands must exist (d7d4aa61, 9d37846c) |
| src/uhp-server/contract.test.ts | c | UHP 2026-10-19 wire contract (discovery shape, error envelope, auth codes) that third-party UHP clients and the conformance suite depend on; a uhp-origin worker has no owner session for notices |
| src/uhp-server/responses.contract.test.ts | c | UHP 2026-10-19 task contract (stream and non-stream assemble the same output, gapless sequence numbers with one terminal event, Idempotency-Key spawns one worker, cancel answers at once and ends `cancelled`, session_busy / harness_mismatch / response_not_found) that third-party UHP clients and the conformance suite depend on; a uhp-origin worker has no owner session for notices |
| src/workers/uhp.test.ts | c | UHP client wire contract: SSE strictness (gapless sequence_number, one terminal event), error-envelope mapping, request headers; third-party UHP servers depend on what the client sends and accepts |
| src/cli/impl/project/rename.test.ts | b | `pai project rename` re-keys registry and ~/.pai state and must refuse a NEW that is a slug or alias of another project (destructive re-key) |
| src/cli/lib/launch-session-config.test.ts | a | interactive launcher ignored project/global session_config (--dangerously-skip-permissions, env), so resumed sessions kept their stored permission mode |
| src/memory/indexer/helpers.test.ts | a | docs-only git repo lost its ~60 .md docs from search because every .git folder skipped the content scan; only git repos with a code marker skip it |
| src/workers/pane-host.test.ts | a | pane host resolution after claude resume/fork: fork without map entry uses its --resume parent entry; foreground match stops at the bg-pty-host; daemon spawner inherited env not trusted (2026-11-13 Archiware panes opened in Webseiten window) |
| src/workers/standalone/status-route.test.ts | a | status line showed no worker target under global routing (only "✓4 ✗3 today"); label is now the default tier serving entry, 30 s cached, pins unchanged |
| src/workers/mode.test.ts | c | `pai worker mode` speed/balanced/budget tier mapping and the `mode:` key in workers.yaml; operator-facing switch (2026-11-16 eval night: Sonnet->Haiku L2 faster and -17 % cloud, Gyro-L L2 -35 % cloud but 6x slower) |
| src/workers/orchestrate-merge.test.ts | c | `--class orchestrate` requests for one repo inside workers.orchestrate.mergeWindowSec merge into one numbered L1 job, others never do (eval night 2026-11-15/16: 2 tasks per L1 saved money, 1 per L1 cost more) |
| src/hooks/ts/lib/delegation-gate.test.ts | b | L0 route, worker-pane and no-root-search guards moved from the out-of-repo caseleaf hook into PAI (operator 2026-11-16) |
| src/workers/report.test.ts | a | `--class orchestrate`/`plan` without the `--orchestrate` flag got the implementation-worker contract and implemented everything on its cloud model instead of starting L2 implementers (eval night 2026-11-16; planner opening + ORCHESTRATOR_START_BLOCK pinned) |
| src/guard/gates.test.ts | b | L1 (class orchestrate/plan) edit lock until a child has failed: a planner that does the package itself is denied |
| src/hooks/ts/lib/headless-gate.test.ts | b | worker headless guard: denies open, activating osascript, window-creating Swift probes and .app binaries (headless worker popped windows on the operator desktop, 2026-11-16) |
| src/workers/run/follow-reroute.test.ts | a | an escalated queued run died with 143 and lost its caller (2026-11-16: 91383→70199, 39358→50309); pins the hand-over marker wait, the follow's json (worker_id=new, worker_ids=[old,new], rc=restart), plain-kill 143, and the lost-status repair |
| src/workers/reroute.test.ts | a,b | the hand-over marker must stand before the queued run is stopped (escalation lost its caller, 2026-11-16); pins escalationReason and escalateOverdue once-per-job; queued jobs wait for their slot (queuedMaxMin 0 = off) unless the operator gave priority; running stall escalation unchanged |
| src/workers/reaper.test.ts | a | reaper killed a detached L2 child of a live L1 as an orphan (pid 30522, 7 min in, orchestrator lost 10 min, 2026-11-16); a worker with a live recorded parent is never an orphan; a process whose cwd sits in a LIVE worker's own worktree is that worker's process or child and is spared (2026-11-16: pids 64640/15907, launchers started from inside a running L1, reaped because ownerOf named the parentless L1) |
