/**
 * chain.ts — draft-then-implement chains: `--chain draft,implement[,review]`.
 *
 * The chain runs each stage as its own worker (own id, own pane, `parent` set
 * to the chain id), so `ps` shows the chain as a tree and every stage can be
 * followed, replayed and said to like any other worker:
 *
 *   - draft    turns the operator's brief into a full spec file under
 *              <logDir>/specs/<chain id>.md (goal, constraints, files likely
 *              touched, acceptance checks, verification commands);
 *   - any other stage (implement, plan, …) runs with that spec as its prompt
 *              and the original brief attached;
 *   - review   reads the spec and the working-tree diff and produces the
 *              structured report.
 *
 * A stage that fails (or a draft that produces no spec file) stops the chain;
 * the caller then writes the spec itself and re-runs without the draft stage.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkersSection } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath, workersLogDir } from "./paths.js";
import { newWorkerId } from "./status.js";
import { shortText } from "./args.js";
import { runWorker, type RunOptions } from "./run.js";

/** Where a chain's spec file lives: <logDir>/specs/<chain id>.md. */
export function specPathFor(logDir: string, chainId: string): string {
  return join(logDir, "specs", `${chainId}.md`);
}

/**
 * Replace the caller's -p value with `prompt`, dropping every existing
 * -p/--print pair first (two -p flags on one claude command line are an error,
 * so the chain must never leave the brief in place when swapping prompts).
 */
export function swapPromptArg(claudeArgs: string[], prompt: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < claudeArgs.length; i++) {
    const a = claudeArgs[i];
    if (a === "-p" || a === "--print") {
      if (i + 1 < claudeArgs.length && !claudeArgs[i + 1].startsWith("-")) i += 1;
      continue;
    }
    out.push(a);
  }
  out.push("-p", prompt);
  return out;
}

export function draftPrompt(brief: string, specPath: string): string {
  return [
    "You are the DRAFT stage of a worker chain. Turn the operator's brief below into a full implementation spec and write it to",
    specPath,
    "with the Write tool.",
    "",
    "Use exactly these five sections as Markdown headings:",
    "# Goal",
    "# Constraints",
    "# Files likely touched",
    "# Acceptance checks",
    "# Verification commands",
    "",
    "Read the repository first (Glob/Grep/Read) so the spec names real files and real commands. Do not implement anything.",
    "",
    "## Operator brief",
    "",
    brief,
  ].join("\n");
}

export function implementPrompt(brief: string, specPath: string | null, spec: string | null): string {
  const head = spec
    ? [
        "You are the IMPLEMENT stage of a worker chain. The draft stage wrote the spec below (also at " +
          specPath +
          "). Implement it exactly, then run the spec's verification commands before finishing.",
        "",
        "## Spec",
        "",
        spec,
      ]
    : ["Implement the operator's brief below."];
  return [...head, "", "## Operator brief", "", brief].join("\n");
}

export function reviewPrompt(brief: string, specPath: string | null, spec: string | null): string {
  const specPart = spec
    ? [
        "",
        "## Spec (also at " + specPath + ")",
        "",
        spec,
      ]
    : [];
  return [
    "You are the REVIEW stage of a worker chain. The implement stage just ran. Read the repository's diff (run `git diff` and `git status`; use `git diff --stat` for the overview) and check it against the spec's acceptance checks and verification commands — run the checks when they are cheap. Do not fix anything you find; report it.",
    ...specPart,
    "",
    "## Operator brief",
    "",
    brief,
  ].join("\n");
}

export interface ChainOptions {
  /** Class names, run in order: e.g. ["draft", "implement", "review"]. */
  stages: string[];
  /** Overrides the class of every stage when given (--class with --chain). */
  className?: string;
  providerFlag?: string;
  modelFlag?: string;
  label?: string;
  noPane?: boolean;
  mcpFlag?: string;
  /** The operator's brief — the -p value of the run. */
  brief: string;
  /** The caller's claude args (allowedTools etc.); the -p value is swapped. */
  claudeArgs: string[];
  cwd?: string;
  /** Internal: notified with the chain id once it exists (worker_run uses it). */
  onChainStart?: (chainId: string) => void;
  /** Internal: suppress result printing (the MCP shim's stdout is the RPC channel). */
  quiet?: boolean;
}

export interface ChainDeps {
  /** Stage runner; tests inject a mock, production uses runWorker. */
  runStage?: (opts: RunOptions) => Promise<number>;
  /** logDir override for tests; default: the configured workers logDir. */
  logDir?: string;
}

/** Run a chain of stages; returns the exit code of the first failed stage, 0 when all pass. */
export async function runChain(opts: ChainOptions, deps: ChainDeps = {}): Promise<number> {
  const stages = opts.stages.map((s) => s.trim()).filter(Boolean);
  if (!stages.length) throw new Error("--chain needs at least one class, e.g. --chain draft,implement");
  const runStage = deps.runStage ?? runWorker;
  const logDir = deps.logDir ?? workersLogDir(readWorkersSection().workers);
  const chainId = newWorkerId();
  const specPath = specPathFor(logDir, chainId);
  mkdirSync(join(logDir, "specs"), { recursive: true }); // the draft stage writes into it
  const baseLabel = opts.label ?? shortText(opts.brief, 40);

  appendLedger(ledgerPath(logDir), "WORKER-CHAIN", {
    chain: chainId,
    stages: stages.join(","),
    label: baseLabel,
  });
  opts.onChainStart?.(chainId);

  let spec: string | null = null;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (stage === "draft") {
      spec = null; // a chain may legally start over; the draft rewrites it
    } else if (spec === null && existsSync(specPath)) {
      spec = readFileSync(specPath, "utf8");
    }
    const prompt =
      stage === "draft"
        ? draftPrompt(opts.brief, specPath)
        : stage === "review"
          ? reviewPrompt(opts.brief, spec ? specPath : null, spec)
          : implementPrompt(opts.brief, spec ? specPath : null, spec);
    process.stderr.write(
      `chain ${chainId}: stage ${i + 1}/${stages.length} ${stage} (spec: ${specPath})\n`
    );
    const rc = await runStage({
      className: opts.className ?? stage,
      providerFlag: opts.providerFlag,
      modelFlag: opts.modelFlag,
      label: `${baseLabel} · ${stage}`,
      noPane: opts.noPane,
      mcpFlag: opts.mcpFlag,
      claudeArgs: swapPromptArg(opts.claudeArgs, prompt),
      cwd: opts.cwd,
      parent: chainId,
      stage,
      quiet: opts.quiet,
    });
    if (stage === "draft") {
      if (!existsSync(specPath)) {
        process.stderr.write(
          `chain ${chainId}: draft stage produced no spec at ${specPath} — stopping. ` +
            `Write the spec yourself and re-run without the draft stage.\n`
        );
        appendLedger(ledgerPath(logDir), "WORKER-CHAIN-END", {
          chain: chainId,
          rc: rc !== 0 ? rc : 1,
          failed: "draft",
        });
        return rc !== 0 ? rc : 1;
      }
      spec = readFileSync(specPath, "utf8");
    }
    if (rc !== 0) {
      appendLedger(ledgerPath(logDir), "WORKER-CHAIN-END", {
        chain: chainId,
        rc,
        failed: stage,
      });
      return rc;
    }
  }
  appendLedger(ledgerPath(logDir), "WORKER-CHAIN-END", { chain: chainId, rc: 0 });
  return 0;
}
