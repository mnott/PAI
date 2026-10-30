# UHP servers as harnesses

The Unified Harness Protocol (UHP) is how PAI runs a worker on **any** harness
that speaks it — a server posting `POST <base>/v1/responses`, not a CLI PAI
shells out to. Full protocol detail: [uhp.md](../uhp.md); this page is the
harness view.

- **Frontend:** no. A UHP harness is something PAI drives, never something you
  chat in; there is no setup command that writes a UHP client config.
- **Workers:** yes. A provider with `engine: uhp` runs headless workers
  (`-p '<prompt>'` only — interactive use is refused,
  `src/workers/run/execute-uhp.ts`). Routing, queueing, the ledger, `follow`,
  `replay` and the AG2 report work as for any other worker.
- **Harness ids:** one harness per enabled (provider, class) pair, served at
  `GET <base>/v1/harnesses` (`src/uhp-server/harnesses.ts`).
  `pai worker run --harness uhp:<id> -p '<task>'` pins the run to it.
- **Session ingestion:** not supported — there is no UHP adapter in the
  registry (`src/harness/index.ts` lists `claude-code` and `codex` only).
- **Status line, hooks, session notes:** not applicable; those are Claude Code
  and OpenCode-bridge features.

Setup and config keys (`harnessId`, `uhpProtocol`) are in
[uhp.md](../uhp.md).
