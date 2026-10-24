/**
 * run/types.ts — the run option and argument shapes shared by the run modules, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { type SystemJob } from "../pane-waiver.js";
import { parseRunnerArgs } from "../args.js";
import { readWorkersSection, type QueuePriority } from "../config.js";
import { type PortCheck } from "../local-provider.js";
import { type WorkerStatus } from "../status.js";
import { type RouteInfo } from "../policy.js";
import { resolveTarget } from "../routing.js";
import { type WorktreeInfo } from "../worktree.js";
import { type WorkerReport } from "../report.js";
import { type RunLimit } from "../deadline.js";
import { type UsageBlock } from "../../utils/input-side-tokens.js";

export interface RunOptions {
  providerFlag?: string;
  /** --class value (the old --role): a task class from workers.classes. */
  className?: string;
  modelFlag?: string;
  label?: string;
  /** Typed system waiver (keepalive heartbeat): the start may run headless, ledgered PANE-WAIVED kind=system. Nothing else waives a pane. */
  systemWaiver?: SystemJob;
  /** --no-stagger: skip the same-provider start gate. */
  noStagger?: boolean;
  /** --no-queue: skip the per-provider concurrency cap. */
  noQueue?: boolean;
  /** --priority: queue admission priority of this run (overrides workers.priority.sessions). */
  queuePriority?: QueuePriority;
  /** --now: wait at the front of the provider's queue (capacity.ts). */
  priority?: "front";
  /** --model fast without a provider: the routed provider's fast model. */
  modelFast?: boolean;
  /** --model default without a provider: the routed provider's default model, not its worker_model. */
  modelDefault?: boolean;
  /** --spec value, resolved for display/recording ("-" for stdin). */
  specPath?: string;
  /** --mcp value: server/set names, comma-separated. */
  mcpFlag?: string;
  /** Everything after `--` (the claude args). */
  claudeArgs: string[];
  /** Working directory for the run (default: this process's cwd). */
  cwd?: string;
  /** Chain stage bookkeeping: the chain id this stage belongs to. */
  parent?: string;
  /** Chain stage bookkeeping: the class name of this stage. */
  stage?: string;
  /** Suppress result printing (MCP worker_run: its stdout is the RPC channel). */
  quiet?: boolean;
  /** Internal: notified with the worker id once it exists (resume uses it). */
  onWorkerStart?: (wid: string) => void;
  /** Internal: preset worker id (the planner mints its id before phase 1). */
  id?: string;
  /** --worktree/--no-worktree; undefined lets the class default decide. */
  worktreeFlag?: boolean;
  /** Resume: the id whose worktree this run takes over (see adoptTree). */
  resumeOf?: string;
  /** --max-minutes: stop the run after N minutes (0 = no limit; default workers.defaultMaxMinutes). */
  maxMinutes?: number;
  /** --deadline HH:MM (local): stop the run then; exclusive with maxMinutes. */
  deadline?: string;
  /** --no-pool: run fresh, never ask the pool (recorded as WORKER-POOL-SKIP reason=opted-out). */
  noPool?: boolean;
  /** --browser / --no-browser: undefined follows workers.noBrowserByDefault. */
  browser?: boolean;
  /** --print-cmd: print the assembled claude argv as JSON and exit, no spawn. */
  printCmd?: boolean;
  /** "provider/model (why)" — one line on how the provider was chosen. */
  routeWhy?: string;
  /** --urgent: wants a fast turnaround (policy auto/prefer-local route to the cloud). */
  urgent?: boolean;
  /** --local-ok: this run may go local under policy prefer-cloud. */
  localOk?: boolean;
  /** --cloud: this run goes to the cloud under policy prefer-local/auto. */
  cloud?: boolean;
  /** --local: run on the local model server PAI resolves (resolveLocalProvider); beats --provider. */
  localFlag?: boolean;
  /** --local NAME: this running local model instead of the tier-order pick. */
  localName?: string;
  /** Internal: the policy already decided (fall-through re-run); carries its route and the run it repeats. */
  _route?: RouteInfo;
  _fallThroughOf?: string;
  /** Internal: tiers this task already escalated out of (escalation.ts); an escalated re-run is not escalated again from them. */
  _escalatedFrom?: string[];
  /** Internal: suppress recursion depth on reroute. */
  _reroutes?: number;
  /** Internal: this run is the one automatic re-launch after an empty model response. */
  _emptyRetried?: boolean;
  /** Internal: this run is the planner's phase-1 worker, not a new orchestration. */
  _planner?: boolean;
  /** --report json|ag2: which contract/parser the run uses (default: ag2, or PAI_WORKER_REPORT). */
  reportFormatFlag?: "json" | "ag2";
  /** --no-report-retry: skip the one bounded re-ask on an invalid AG2 final message. */
  noReportRetry?: boolean;
  /** --orchestrate: the worker plans and reviews; code edits are denied (PAI_WORKER_ORCHESTRATOR=1). */
  orchestrate?: boolean;
  /** --capability/--for: run through resolveCapability instead of resolveTarget. */
  capabilityFlag?: string;
  /** --out: image-engine output path (default: <logDir>/<id>.png). */
  imageOut?: string;
  /** --size: image-engine "WIDTHxHEIGHT" (default: 1024x1024). */
  imageSize?: string;
  /** --timeout-ms: image-engine request timeout (default: 120000). */
  imageTimeoutMs?: number;
  /**
   * Port-probe seam for the down/disabled local-provider guard (tests
   * inject; production: httpModelsCheck — the same probe
   * resolveLocalProvider uses).
   */
  _localCheck?: PortCheck;
}

// a type alias (not an interface): it must stay assignable to
// Record<string, unknown> when written into the event transcript
export type StreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  context_window?: number;
  model_info?: { context_window?: number } | null;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      input?: unknown;
      /** tool_result blocks: the result payload (string or text blocks). */
      content?: unknown;
      is_error?: boolean;
    }>;
    usage?: UsageBlock;
  };
  usage?: UsageBlock;
  result?: string;
  is_error?: boolean;
  is_compact?: boolean;
  num_turns?: number;
  duration_ms?: number;
  /** API time of the final turn — the TTFT proxy on zeroed per-turn usage. */
  duration_api_ms?: number;
};

export interface ModelStepDown {
  /** The model id the run goes out on. */
  model: string;
  /** One launch-preamble line, or null when resolution is unchanged. */
  notice: string | null;
}

export interface ImageExecuteArgs {
  logDir: string;
  target: ReturnType<typeof resolveTarget>;
  model: string;
  label: string;
  parsed: ReturnType<typeof parseRunnerArgs>;
  capability: string;
  outPath?: string;
  size?: string;
  timeoutMs?: number;
  cwd?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  quiet?: boolean;
  onWorkerStart?: (wid: string) => void;
  id?: string;
}

export interface FinaliseArgs {
  logDir: string;
  ledger: string;
  status: WorkerStatus;
  /** The process's real outcome; recordWorktree sees this, never the orphan verdict. */
  ok: boolean;
  rc: number;
  secs: number;
  /** Engine-specific WORKER-END fields (provider, mode, engine, model, label, ...). */
  end: Record<string, unknown>;
  report: WorkerReport | null;
  /** Handoff text when the report has no notes. */
  fallbackText?: string;
  worktree?: WorktreeInfo | null;
  /** The deadline stopped the run after this many minutes. */
  timedOut?: number;
  /**
   * Runs after the worktree outcome is recorded, before the parent handoff
   * (print the result, quota reroute). A returned number ends the run with
   * it, skipping the handoff — the reroute's own run reports instead.
   */
  /** why a failed local run would be re-run on the cloud; with commits it is reviewed instead */
  fallThroughWhy?: (status: WorkerStatus, report: WorkerReport | null) => string | null;
  /** True when the run ended on a cloud provider (and is not a benchmark): an invalid report then ends as r=~, never a re-run. */
  cloudRun?: (status: WorkerStatus) => boolean;
  /** set when a committed run was kept for review: beforeHandoff must not re-run or escalate it */
  onReviewed?: () => void;
  beforeHandoff?: (status: WorkerStatus, report: WorkerReport | null) => Promise<number | void> | number | void;
}

export interface ExecuteArgs {
  /** capacity + stagger gates already passed (set by gateStart) */
  gated?: boolean;
  /** ms spent queued for a slot (set by gateStart); the deadline already moved by it. */
  queueWaitedMs?: number;
  config: ReturnType<typeof readWorkersSection>["workers"];
  logDir: string;
  target: ReturnType<typeof resolveTarget>;
  model: string;
  label: string;
  parsed: ReturnType<typeof parseRunnerArgs>;
  claudeArgs: string[];
  systemWaiver?: SystemJob;
  noStagger?: boolean;
  noQueue?: boolean;
  /** --priority: queue admission priority of this run (overrides workers.priority.sessions). */
  queuePriority?: QueuePriority;
  priority?: "front";
  mcpFlag?: string;
  cwd?: string;
  specPath?: string;
  parent?: string;
  stage?: string;
  quiet?: boolean;
  onWorkerStart?: (wid: string) => void;
  id?: string;
  worktreeFlag?: boolean;
  resumeOf?: string;
  className?: string;
  reroutes: number;
  emptyRetried?: boolean;
  route?: RouteInfo;
  fallThroughOf?: string;
  escalatedFrom?: string[];
  printCmd?: boolean;
  /** "provider/model (why)" — one line on how the provider was chosen. */
  routeWhy?: string;
  reportFormat: "json" | "ag2";
  noReportRetry?: boolean;
  /** --orchestrate: PAI_WORKER_ORCHESTRATOR=1 in the env and the orchestrator addendum in the contract. */
  orchestrate?: boolean;
  /** Capability name this run resolved through (--capability, or an implied class capability), when it did. */
  capability?: string;
  /** Time limit of the run; null = none. */
  limit: RunLimit | null;
  /** Browser tools are stripped from this run (and denied by the worker guard). */
  noBrowser: boolean;
  /** The options this run was launched with; a relaunch starts from these (see relaunchOptions). */
  opts: RunOptions;
  /** Set once the follow pane was handled (tryPoolRun); executeRun then neither opens nor verifies a second one. */
  panePrepared?: { verified: boolean };
  /** The follow pane opening beside admission and the claim (gateStart); settles once panePrepared is set. Never rejects. */
  paneOpening?: Promise<void>;
  /** The pane could not be opened (not a missing terminal): executeRun throws it, the run does not start unseen. */
  paneError?: Error;
  /** Ms the pane took to open and verify (off the critical path), ms spent in the capacity + stagger gates, epoch ms a fresh spawn began. */
  setupPaneMs?: number;
  admissionMs?: number;
  spawnT0?: number;
  /** Epoch ms the run started: setupMs counts from here to the worker process holding its first turn. */
  runT0?: number;
  /** Starts the fall-through run; tests swap it, runs use runWorker. */
  runner?: (opts: RunOptions) => Promise<number>;
  /** Why the spare claim missed (the pool was asked, this run spawned fresh); recorded on the WORKER-END line. */
  spareMiss?: string;
}

export interface Ag2ReaskArgs {
  env: NodeJS.ProcessEnv;
  cwd: string;
  model: string;
  callerPinnedModel: boolean;
  chromeArgs: string[];
  mcpArgs: string[];
  toolArgs: string[];
  toolsFlag: string[];
  /** Slim-profile args of the original launch, so the resumed turn loads the same setup. */
  slimArgs?: string[];
  sessionId: string;
  timeoutMs?: number;
  /** Argv head of the original launch (claudeCommand); defaults to plain claude. */
  claudeCmd?: string[];
}

export interface CodexArgs extends Omit<ExecuteArgs, "reroutes" | "mcpFlag" | "opts"> {}
