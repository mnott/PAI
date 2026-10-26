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
