/**
 * pass-priority.ts — run heavy index/embed pass work at background priority.
 *
 * The daemon also serves MCP, so its own priority must stay normal. The heavy
 * work runs in a child (`pai memory pass <name>`) spawned under
 * `taskpolicy -b nice -n 19` (darwin) or `nice -n 19 ionice -c3` (linux);
 * onnxruntime threads inherit the child's priority. The child reports over
 * stdout as one JSON line: {ok:true,result} or {ok:false,error}.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setPriority } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type PassName = "index" | "embed" | "noop";

export interface PassCommand {
  cmd: string;
  args: string[];
}

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((d) => d && existsSync(join(d, bin)));
}

/**
 * Wrap `node <entry> <passArgs>` in the platform's low-priority incantation.
 * Darwin uses nice 19, not 20: measured on macOS, node started with nice 20
 * reverts to nice 0 within a second; 19 sticks.
 */
export function buildPassCommand(
  platform: NodeJS.Platform,
  node: string,
  entry: string,
  passArgs: string[],
  have: (bin: string) => boolean = onPath,
): PassCommand {
  const run = [node, entry, ...passArgs];
  let wrap: string[];
  if (platform === "darwin") {
    wrap = have("taskpolicy") ? ["taskpolicy", "-b", "nice", "-n", "19"] : ["nice", "-n", "19"];
  } else if (platform === "win32") {
    wrap = [];
  } else {
    wrap = have("ionice") ? ["nice", "-n", "19", "ionice", "-c3"] : ["nice", "-n", "19"];
  }
  const [cmd, ...rest] = [...wrap, ...run];
  return { cmd, args: rest };
}

/** The CLI entry the child runs: dist/cli/index.mjs next to the daemon's dist. */
export function cliEntry(): string {
  const daemonEntry = process.argv[1] ?? "";
  return join(dirname(dirname(daemonEntry)), "cli", "index.mjs");
}

/** Spawning itself failed (binary missing): the caller may fall back in-process. */
export class PassSpawnError extends Error {}

const children = new Set<{ kill: () => boolean }>();
process.on("exit", () => children.forEach((c) => c.kill()));

/**
 * Run one pass in a low-priority child. Resolves with the child's result;
 * rejects with the child's error (pass failure) or PassSpawnError (no child).
 */
export function runPassChild<T>(name: PassName, extraArgs: string[] = []): Promise<T> {
  const { cmd, args } = buildPassCommand(process.platform, process.execPath, cliEntry(), [
    "memory",
    "pass",
    name,
    ...extraArgs,
  ]);
  return new Promise<T>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAI_PASS_BACKGROUND: "1" },
    });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", (e) => {
      children.delete(child);
      reject(new PassSpawnError(`cannot spawn ${cmd}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      children.delete(child);
      const line = out.trim().split("\n").pop() ?? "";
      let msg: { ok?: boolean; result?: T; error?: string } | undefined;
      try {
        msg = JSON.parse(line);
      } catch { /* no report line */ }
      if (code === 0 && msg?.ok) return resolve(msg.result as T);
      reject(
        new Error(
          msg?.error ??
            `pass child ${name} exited ${code ?? signal}: ${err.trim().split("\n").pop() ?? ""}`,
        ),
      );
    });
  });
}

/**
 * Inside the wrapper, keep nice at 19: measured on macOS, node's nice resets
 * to 0 about a second after start (5s re-apply interval holds it; the
 * taskpolicy -b QoS is unaffected).
 */
function holdNice(): void {
  const apply = () => {
    try { setPriority(process.pid, 19); } catch { /* non-fatal */ }
  };
  apply();
  setInterval(apply, 5_000).unref();
}

/**
 * `--background` for CLI commands: re-exec this very command under the
 * low-priority wrapper and exit with its status. Inside the re-exec (or a
 * daemon-spawned pass child, which sets the same env) it only holds nice.
 */
export function reexecBackground(): void {
  if (process.env.PAI_PASS_BACKGROUND === "1") return holdNice();
  const { cmd, args } = buildPassCommand(
    process.platform,
    process.execPath,
    process.argv[1],
    process.argv.slice(2),
  );
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, PAI_PASS_BACKGROUND: "1" },
  });
  if (r.error) {
    process.stderr.write(`--background: cannot spawn ${cmd} (${r.error.message}); running at normal priority\n`);
    return;
  }
  process.exit(r.status ?? 1);
}
