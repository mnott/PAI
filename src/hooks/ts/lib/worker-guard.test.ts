import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWorkerGuard, parseCommand, type WorkerGuardContext } from "./worker-guard.js";
import { dropHeredocBodies } from "./heredoc.js";

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
  ["path-qualified push", bash("/usr/bin/git push"), wtCtx(), "git push blocked"],
  ["subshell push", bash("(git push)"), wtCtx(), "git push blocked"],
  ["brace group push", bash("{ git push; }"), wtCtx(), "git push blocked"],
  ["if-then push", bash("if true; then git push; fi"), wtCtx(), "git push blocked"],
  ["xargs push", bash("echo x | xargs git push"), wtCtx(), "git push blocked"],
  ["xargs -I tag", bash("echo x | xargs -I{} git tag {}"), wtCtx(), "git tag blocked"],
  ["eval push", bash("eval 'git push'"), wtCtx(), "git push blocked"],
  ["annotated tag", bash("git tag -a v1 -m x"), wtCtx(), "git tag blocked"],
  ["tag in shared checkout (--no-worktree)", bash("git tag v1.0.0"), sharedCtx, "git tag blocked"],
  ["push --tags in shared checkout", bash("git push origin main --tags"), sharedCtx, "git push blocked"],
  ["annotated tag in shared checkout", bash("git tag -a v1 -m x && git push"), sharedCtx, "git tag blocked"],
  ["git stash in shared checkout", bash("git stash"), sharedCtx, "shared checkout"],
  ["git reset --hard in shared checkout", bash("git reset --hard HEAD"), sharedCtx, "shared checkout"],
  ["git checkout -- . in shared checkout", bash("git checkout -- ."), sharedCtx, "shared checkout"],
  ["git restore . in shared checkout", bash("git restore ."), sharedCtx, "shared checkout"],
  ["git clean -fd in shared checkout", bash("git clean -fd"), sharedCtx, "shared checkout"],
  ["git switch in shared checkout", bash("git switch other"), sharedCtx, "shared checkout"],
  ["git checkout branch in shared checkout", bash("git checkout other"), sharedCtx, "shared checkout"],
  ["checkout HEAD~0 detaches", bash("git checkout HEAD~0"), wtCtx(), "commit on your branch"],
  ["checkout sha detaches", bash("git checkout 890d64d"), wtCtx(), "commit on your branch"],
  ["checkout --detach", bash("git checkout --detach"), wtCtx(), "commit on your branch"],
  ["switch --detach", bash("git switch --detach main"), wtCtx(), "commit on your branch"],
  ["checkout HEAD~1", bash("git checkout HEAD~1"), wtCtx(), "commit on your branch"],
  ["switch --detach bare", bash("git switch --detach"), wtCtx(), "commit on your branch"],
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
  ["pkill -f real command", bash(`pkill -f "uvicorn exampleco_server.main:app --port 8490"`), wtCtx(), "by PID"],
  ["pkill after &&", bash("cd x && pkill node"), wtCtx(), "by PID"],
  ["sudo killall", bash("sudo killall node"), wtCtx(), "by PID"],
  ["kill $(pgrep)", bash("kill $(pgrep -f uvicorn)"), wtCtx(), "by PID"],
  ["kill backtick pgrep", bash("kill -9 `pgrep node`"), wtCtx(), "by PID"],
  ["pgrep | xargs kill", bash("pgrep -f uvicorn | xargs kill"), wtCtx(), "by PID"],
  ["pkill in bash -c", bash(`bash -c 'pkill -9 node'`), wtCtx(), "by PID"],
  ["node on .ts", bash("node src/foo.ts"), wtCtx(), "node cannot load TypeScript source"],
  ["npx tsc with file arg", bash("npx tsc --noEmit src/a.ts"), wtCtx(), "tsc with a file argument ignores tsconfig.json"],
  ["git add -f", bash("git add -f Notes/x.md"), wtCtx(), "Notes/ and other ignored paths stay untracked"],
  ["git add with ignored path", bash("git add Notes/x.md"), wtCtx({ isIgnored: (p) => p.startsWith("Notes/") }), "Notes/ and other ignored paths stay untracked"],
];

const ALLOW: [string, ReturnType<typeof bash>, WorkerGuardContext][] = [
  ["commit -qam with ; and - in the message", bash(`git commit -qam "fix(workers): prompt values starting with - stay prompts; pre-event start failures record claude stderr"`), wtCtx()],
  ["commit message naming checkout", bash(`git commit -m "checkout HEAD~1"`), wtCtx()],
  ["checkout -b new branch", bash("git checkout -b feat HEAD~1"), wtCtx()],
  ["checkout a file from a rev", bash("git checkout HEAD -- src/a.ts"), wtCtx()],
  ["ln -s inside worktree", bash("ln -s ../node_modules/x lib/x"), wtCtx()],
  ["ln -s absolute inside worktree", bash(`ln -s ${WT}/a b`), wtCtx()],
  ["cp -R within worktree", bash("cp -R src /work/wt/abc/tmp/src2"), wtCtx()],
  ["cp -r subdir to /tmp", bash("cp -r src /tmp/claude-1/src"), wtCtx()],
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
  ["node on mjs", bash("node scripts/build-hooks.mjs"), wtCtx()],
  ["npx tsc without file arg", bash("npx tsc --noEmit"), wtCtx()],
  ["git add with non-ignored path", bash("git add src/a.ts"), wtCtx()],
  ["git add -A", bash("git add -A"), wtCtx()],
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

  it("allows heredoc commands that would otherwise be denied", () => {
    const command = `cat >> realworld-cli-log.md \x3c\x3c'EOF'
cache eviction: do not pkill the server, killall is blocked
xargs kill
EOF`;
    const d = decideWorkerGuard(bash(command), WORKER, () => wtCtx());
    expect(d.decision).toBe("allow");
  });

  it("still denies pkill commands in heredocs", () => {
    const command = `pkill -f foo`;
    const d = decideWorkerGuard(bash(command), WORKER, () => wtCtx());
    expect(d.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain("by PID");
  });

  it("allows commands with heredocs that redirect to files", () => {
    const command = `cat \x3c\x3cEOF > x.txt
some body
EOF`;
    const segments = parseCommand(command);
    expect(segments.some((s) => s.redirects.includes("x.txt"))).toBe(true);
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

describe("dropHeredocBodies", () => {
  it("removes heredoc bodies from commands", () => {
    const command = `cat >> realworld-cli-log.md \x3c\x3c'EOF'
cache eviction: do not pkill the server, killall is blocked
xargs kill
EOF
`;
    expect(dropHeredocBodies(command)).toBe(`cat >> realworld-cli-log.md \x3c\x3c'EOF'
`);
  });

  it("handles heredocs with different quoting styles", () => {
    const command = `cat \x3c\x3c"EOF"
some body
EOF
`;
    expect(dropHeredocBodies(command)).toBe(`cat \x3c\x3c"EOF"
`);
  });

  it("handles heredocs with unquoted tags", () => {
    const command = `cat \x3c\x3cEOF
some body
EOF
`;
    expect(dropHeredocBodies(command)).toBe(`cat \x3c\x3cEOF
`);
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

describe("worker Chrome", () => {
  const CH = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"';
  const go = (c: string) => decideWorkerGuard(bash(c), WORKER, () => wtCtx()).decision;
  it("denies headless without the keychain flags", () => {
    expect(go(`${CH} --headless=new --user-data-dir=/tmp/x about:blank`)).toBe("deny");
    expect(go(`${CH} --headless=new --use-mock-keychain about:blank`)).toBe("deny");
  });
  it("allows headless with both flags", () => {
    expect(go(`${CH} --headless=new --use-mock-keychain --password-store=basic --user-data-dir=/tmp/x about:blank`)).toBe("allow");
  });
  it("denies non-headless", () => {
    expect(go(`${CH} --user-data-dir=/tmp/x about:blank`)).toBe("deny");
  });
});

describe("recursive search rooted at home or /", () => {
  const H = "/Users/someone";
  const run = (command: string, cwd = WT) =>
    decideWorkerGuard(bash(command), WORKER, () => wtCtx({ cwd, home: H }));

  it.each([
    `cd ${H}; timeout 100 grep -rl "TQP5 / TQP6 / TQP7" --include=ggml-quants.c . | head`,
    "cd ~; grep -r x .",
    `cd ${H} && rg x`,
    "cd / ; find . -name x",
    "cd ~ && rg foo",
    "grep -rn foo ~",
    "rg foo ~/",
    "find / -name x",
    "fd x $HOME",
    "cd ~ && cd . && find . -name x",
  ])("denies: %s", (cmd) => {
    const d = run(cmd);
    expect(d.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain("rg -n PATTERN ~/strata-020");
  });

  it("denies a path-less search when the hook cwd is home", () => {
    expect(run("rg foo", H).decision).toBe("deny");
  });

  it.each([
    "rg foo ~/strata-020",
    "grep -rn foo src/",
    "find /tmp/build -name x",
    "mdfind -name x",
    "grep foo ~/file.txt",
    "grep foo",
    `rg x ${H}/dev/ai/PAI`,
    "cd ~/strata-020 && rg foo",
    "cd ~ && cd strata-020 && grep -rn foo .",
  ])("allows: %s", (cmd) => {
    expect(run(cmd).decision).toBe("allow");
  });
});
