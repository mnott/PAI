import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWorkerGuard, parseCommand, type WorkerGuardContext } from "./worker-guard.js";

const WT = "/work/wt/abc";
const MAIN = "/work/main";
const HOME = "/home/u";

const wtCtx = (over: Partial<WorkerGuardContext> = {}): WorkerGuardContext => ({
  cwd: WT,
  home: HOME,
  worktreeRoot: WT,
  inWorktree: true,
  mainCheckout: MAIN,
  testScript: () => "vitest",
  ...over,
});
const sharedCtx = wtCtx({ cwd: MAIN, worktreeRoot: MAIN, inWorktree: false, mainCheckout: null });

const WORKER = { PAI_WORKER: "1" };
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const edit = (tool_name: string, file_path: string) => ({ tool_name, tool_input: { file_path } });

const DENY: [string, ReturnType<typeof bash>, WorkerGuardContext, string][] = [
  ["ln -s into main node_modules", bash(`ln -s ${MAIN}/node_modules node_modules`), wtCtx(), "runner provisions node_modules"],
  ["ln -sf relative escape", bash("ln -sf ../../../main/node_modules node_modules"), wtCtx(), "runner provisions node_modules"],
  ["ln -s after cd &&", bash("cd /tmp && ln -s /elsewhere/x y"), wtCtx(), "runner provisions node_modules"],
  ["cp -R worktree to /tmp", bash(`cp -R ${WT} /tmp/build`), wtCtx(), "never from a copy"],
  ["cp -r . to /tmp", bash("cp -r . /tmp/build"), wtCtx(), "never from a copy"],
  ["rsync -a . elsewhere", bash("rsync -a ./ /tmp/build/"), wtCtx(), "never from a copy"],
  ["rsync main checkout", bash(`rsync -av ${MAIN}/ /tmp/b`), wtCtx(), "never from a copy"],
  ["git push", bash("git push origin HEAD"), wtCtx(), "git push blocked"],
  ["push after &&", bash("git commit -m x && git push"), wtCtx(), "git push blocked"],
  ["env-prefixed push", bash("GIT_SSH=x git -C . push"), wtCtx(), "git push blocked"],
  ["npm publish", bash("npm publish --access public"), wtCtx(), "publish blocked"],
  ["bun publish", bash("bun publish"), wtCtx(), "publish blocked"],
  ["npm version bump", bash("npm version patch"), wtCtx(), "npm version blocked"],
  ["git tag create", bash("git tag v1.0.0"), wtCtx(), "git tag blocked"],
  ["git stash in shared checkout", bash("git stash"), sharedCtx, "shared checkout"],
  ["git reset --hard in shared checkout", bash("git reset --hard HEAD"), sharedCtx, "shared checkout"],
  ["git checkout -- . in shared checkout", bash("git checkout -- ."), sharedCtx, "shared checkout"],
  ["git restore . in shared checkout", bash("git restore ."), sharedCtx, "shared checkout"],
  ["git clean -fd in shared checkout", bash("git clean -fd"), sharedCtx, "shared checkout"],
  ["git switch in shared checkout", bash("git switch other"), sharedCtx, "shared checkout"],
  ["git checkout branch in shared checkout", bash("git checkout other"), sharedCtx, "shared checkout"],
  ["TODO.md via redirect", bash("echo x >> Notes/TODO.md"), wtCtx(), "Notes/TODO.md"],
  ["TODO.md via tee", bash("echo x | tee Notes/TODO.md"), wtCtx(), "Notes/TODO.md"],
  ["TODO.md via sed -i", bash("sed -i '' s/a/b/ Notes/TODO.md"), wtCtx(), "Notes/TODO.md"],
  ["bun test on vitest repo", bash("cd sub && bun test"), wtCtx(), "vitest"],
  ["bash -c wrapper", bash(`bash -c 'git push'`), wtCtx(), "git push blocked"],
  ["cd into main checkout", bash(`cd ${MAIN}/src`), wtCtx(), "relative to your worktree"],
  ["cd main then work", bash(`cd ${MAIN} && ls`), wtCtx(), "relative to your worktree"],
  ["redirect to claude.json", bash(`echo {} > ${HOME}/.claude.json`), wtCtx(), "temp-dir copies"],
  ["tilde settings.json sed -i", bash("sed -i s/a/b/ ~/.claude/settings.json"), wtCtx(), "temp-dir copies"],
  ["cp onto pai yaml", bash("cp /tmp/x.yaml ~/.claude/pai/config.yaml"), wtCtx(), "temp-dir copies"],
  ["mv pai json", bash("mv /tmp/x ~/.claude/pai/config.json"), wtCtx(), "temp-dir copies"],
  ["pkill -f real command", bash(`pkill -f "uvicorn paperfull_server.main:app --port 8490"`), wtCtx(), "by PID"],
  ["pkill after &&", bash("cd x && pkill node"), wtCtx(), "by PID"],
  ["sudo killall", bash("sudo killall node"), wtCtx(), "by PID"],
  ["kill $(pgrep)", bash("kill $(pgrep -f uvicorn)"), wtCtx(), "by PID"],
  ["kill backtick pgrep", bash("kill -9 `pgrep node`"), wtCtx(), "by PID"],
  ["pgrep | xargs kill", bash("pgrep -f uvicorn | xargs kill"), wtCtx(), "by PID"],
  ["pkill in bash -c", bash(`bash -c 'pkill -9 node'`), wtCtx(), "by PID"],
];

const ALLOW: [string, ReturnType<typeof bash>, WorkerGuardContext][] = [
  ["ln -s inside worktree", bash("ln -s ../node_modules/x lib/x"), wtCtx()],
  ["ln -s absolute inside worktree", bash(`ln -s ${WT}/a b`), wtCtx()],
  ["cp -R within worktree", bash("cp -R src /work/wt/abc/tmp/src2"), wtCtx()],
  ["cp -r subdir to /tmp", bash("cp -r src /tmp/src"), wtCtx()],
  ["git status/diff/log", bash("git status && git diff --stat | head && git log -3"), wtCtx()],
  ["git add + commit", bash(`git add -A && git commit -m "fix: mention git push and git stash"`), wtCtx()],
  ["git reset in worktree", bash("git reset --hard HEAD~1"), wtCtx()],
  ["git stash list in shared checkout", bash("git stash list"), sharedCtx],
  ["git tag listing", bash("git tag -l 'v*'"), wtCtx()],
  ["npm version (read)", bash("npm version"), wtCtx()],
  ["npm run build", bash("npm run build"), wtCtx()],
  ["bun test on non-vitest repo", bash("bun test"), wtCtx({ testScript: () => "bun test" })],
  ["cd inside worktree", bash("cd src && ls"), wtCtx()],
  ["cat TODO.md", bash("cat Notes/TODO.md"), wtCtx()],
  ["read live config", bash("cat ~/.claude/settings.json ~/.claude.json | head"), wtCtx()],
  ["write other Notes file", bash("echo x > Notes/other.md"), wtCtx()],
  ["write deep pai file", bash("echo x > ~/.claude/pai/logs/x.json"), wtCtx()],
  ["kill by pid", bash("kill 1234"), wtCtx()],
  ["kill pidfile", bash("kill $(cat /tmp/x.pid)"), wtCtx()],
  ["kill job", bash("sleep 5 & kill %1"), wtCtx()],
  ["pgrep alone", bash("pgrep -f uvicorn"), wtCtx()],
  ["pkill in echo", bash("echo pkill is denied"), wtCtx()],
  ["stderr dup redirect", bash("npm test 2>&1 | tail"), wtCtx()],
  ["git checkout -b in worktree", bash("git checkout -b topic"), wtCtx()],
];

describe("decideWorkerGuard", () => {
  it.each(DENY)("denies: %s", (_n, input, ctx, needle) => {
    const d = decideWorkerGuard(input, WORKER, () => ctx);
    expect(d.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain(needle);
  });

  it.each(ALLOW)("allows: %s", (_n, input, ctx) => {
    expect(decideWorkerGuard(input, WORKER, () => ctx).decision).toBe("allow");
  });

  it("is a no-op when PAI_WORKER is unset", () => {
    for (const [, input, ctx] of DENY) {
      expect(decideWorkerGuard(input, {}, () => ctx).decision).toBe("allow");
    }
  });

  it.each([
    ["Write", `${WT}/Notes/TODO.md`, "deny"],
    ["Edit", "Notes/TODO.md", "deny"],
    ["MultiEdit", `${MAIN}/Notes/TODO.md`, "deny"],
    ["Write", `${HOME}/.claude/settings.json`, "deny"],
    ["Edit", `${HOME}/.claude.json`, "deny"],
    ["Write", `${HOME}/.claude/pai/config.yaml`, "deny"],
    ["Write", `${WT}/Notes/other.md`, "allow"],
    ["Edit", `${WT}/src/a.ts`, "allow"],
    ["Write", `${HOME}/.claude/pai/logs/x.yaml`, "allow"],
  ])("%s %s -> %s", (tool, path, want) => {
    expect(decideWorkerGuard(edit(tool, path), WORKER, () => wtCtx()).decision).toBe(want);
    expect(decideWorkerGuard(edit(tool, path), {}, () => wtCtx()).decision).toBe("allow");
  });

  it("ignores other tools", () => {
    expect(decideWorkerGuard({ tool_name: "Read", tool_input: { file_path: "Notes/TODO.md" } }, WORKER, () => wtCtx()).decision).toBe("allow");
  });
});

describe("commit attribution", () => {
  const TRAILER = "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>";
  const run = (c: string) => decideWorkerGuard(bash(c), WORKER, () => wtCtx());
  const dir = mkdtempSync(join(tmpdir(), "wg-"));
  const bad = join(dir, "bad.txt");
  const good = join(dir, "good.txt");
  writeFileSync(bad, `feat: x\n\n${TRAILER}\n`);
  writeFileSync(good, "feat: x\n");

  it.each([
    ["-m trailer", `git commit -m "feat: x" -m "${TRAILER}"`],
    ["heredoc trailer", `git commit -m "$(cat <<'EOF'\nfeat: x\n\n${TRAILER}\nEOF\n)"`],
    ["generated-with", `git commit -m "feat: x 🤖 Generated with [Claude Code](https://claude.com/claude-code)"`],
    ["-F file trailer", `git commit -F ${bad}`],
    ["--file= trailer", `git commit --file=${bad}`],
  ])("denies %s", (_n, c) => {
    const d = run(c);
    expect(d.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain("no AI attribution in commits");
  });

  it.each([
    ["plain commit", 'git commit -m "feat: add thing"'],
    ["prose mentioning claude", 'git commit -m "fix: handle claude output parsing"'],
    ["-F clean file", `git commit -F ${good}`],
    ["-F missing file", `git commit -F ${dir}/nope.txt`],
  ])("allows %s", (_n, c) => {
    expect(run(c).decision).toBe("allow");
  });
});

describe("parseCommand", () => {
  it("splits operators outside quotes and captures redirects", () => {
    expect(parseCommand(`a 'b && c'; d > f 2>&1 || e | g`)).toEqual([
      { words: ["a", "b && c"], redirects: [] },
      { words: ["d"], redirects: ["f"] },
      { words: ["e"], redirects: [] },
      { words: ["g"], redirects: [] },
    ]);
  });
});

describe("worker-guard entry", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/worker-guard.ts";
  const run = (env: NodeJS.ProcessEnv, command: string): string => {
    const { PAI_WORKER: _drop, ...base } = process.env;
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify({ tool_name: "Bash", cwd: process.cwd(), tool_input: { command } }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...base, ...env },
    });
  };

  it("denies git push for a worker", () => {
    const out = JSON.parse(run({ PAI_WORKER: "1" }, "git push")).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("git push blocked");
  });

  it("prints nothing in an interactive session", () => {
    expect(run({}, "git push")).toBe("");
  });

  it("prints nothing for an allowed worker command", () => {
    expect(run({ PAI_WORKER: "1" }, "git status")).toBe("");
  });
});
