import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { maskedProofReason, nodeOnTypeScriptReason, tscFileArgReason, forceAddReason, gitAddPaths, dbWriteReason, liveContainerReason, type DbWriteContext } from "./worker-bash-rules.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDecision } from "../lib/render-decision.js";
import { decideWorkerGuard, type WorkerGuardContext } from "./worker-guard.js";
import { decideTestGovernance } from "./test-governance.js";

describe("nodeOnTypeScriptReason", () => {
  it("should deny node with .ts file", () => {
    expect(nodeOnTypeScriptReason("node src/app.ts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node with .tsx file", () => {
    expect(nodeOnTypeScriptReason("node src/app.tsx")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node with .mts file", () => {
    expect(nodeOnTypeScriptReason("node src/app.mts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node --test with .ts file", () => {
    expect(nodeOnTypeScriptReason("node --test src/test.ts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should allow node with .js file", () => {
    expect(nodeOnTypeScriptReason("node src/app.js")).toBeNull();
  });

  it("should allow node with .mjs file", () => {
    expect(nodeOnTypeScriptReason("node src/app.mjs")).toBeNull();
  });

  it("should allow node with no file arguments", () => {
    expect(nodeOnTypeScriptReason("node --version")).toBeNull();
  });

  it("should allow npx tsx", () => {
    expect(nodeOnTypeScriptReason("npx tsx src/app.ts")).toBeNull();
  });

  it("should allow node -e with simple code", () => {
    expect(nodeOnTypeScriptReason("node -e \"console.log(1)\"")).toBeNull();
  });

  it("should deny node -e with require of src", () => {
    expect(nodeOnTypeScriptReason("node -e \"require('./src/app.js')\"")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node -e with import of src", () => {
    expect(nodeOnTypeScriptReason("node -e \"import('./src/app.js')\"")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node -e with from import of src", () => {
    expect(nodeOnTypeScriptReason("node -e \"from './src/app.js'\"")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should allow node -e with no src import", () => {
    expect(nodeOnTypeScriptReason("node -e \"require('fs')\"")).toBeNull();
  });

  // Regression: worker 20261117-022500-23088 (AIBroker) denied 2026-11-17T01:25:38Z for its own test-runner form.
  const aibrokerTestScript = "tsx --experimental-test-module-mocks --import ./test/home-guard.ts --test test/*.test.ts";
  it("allows the full reproduced AIBroker command (with the repo's tsx test script)", () => {
    const denied = `git stash push -q -m w1 -- src/transport/sync-facade.ts; npx tsx --import ./test/home-guard.ts --test test/sync-facade-refresh.test.ts 2>&1 | grep -E "^# (pass|fail)|RangeError" | head -3; git stash pop -q; git diff --stat | tail -1
npm run build 2>&1 | tail -2; npx tsc --noEmit && echo tscok; npm test 2>&1 | grep -E "^# (tests|pass|fail)"
AIBROKER_TRANSPORT=tmux node --import ./test/home-guard.ts --test dist/../test/sync-facade-refresh.test.ts >/dev/null 2>&1; ls dist/transport/sync-facade.js`;
    expect(nodeOnTypeScriptReason(denied, aibrokerTestScript)).toBeNull();
  });

  it("allows npx tsx with --experimental-test-module-mocks and .ts args", () => {
    expect(nodeOnTypeScriptReason("npx tsx --experimental-test-module-mocks --import ./test/home-guard.ts --test test/a.test.ts")).toBeNull();
  });

  it("denies node --test on a .ts file without a tsx loader", () => {
    expect(nodeOnTypeScriptReason("node --test test/a.test.ts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("allows every tsx invocation form with --test and .ts args", () => {
    for (const c of [
      "tsx src/app.ts",
      "node --import tsx --test test/a.test.ts",
      "node --loader tsx test/a.test.ts",
      "node --import=tsx test/a.test.ts",
      "node -r tsx/cjs test/a.test.ts",
      "node --import tsx --import ./test/home-guard.ts --test test/a.test.ts",
    ]) expect(nodeOnTypeScriptReason(c)).toBeNull();
  });

  it("allows the npx tsx segment alone (its .ts flag values are preload scripts)", () => {
    expect(nodeOnTypeScriptReason("npx tsx --import ./test/home-guard.ts --test test/sync-facade-refresh.test.ts")).toBeNull();
  });

  it("denies a bare node --import <script>.ts run without the repo's tsx test script", () => {
    expect(nodeOnTypeScriptReason("AIBROKER_TRANSPORT=tmux node --import ./test/home-guard.ts --test dist/../test/sync-facade-refresh.test.ts >/dev/null 2>&1")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("allows that same node segment when the repo's test script runs tsx", () => {
    expect(nodeOnTypeScriptReason("AIBROKER_TRANSPORT=tmux node --import ./test/home-guard.ts --test dist/../test/sync-facade-refresh.test.ts >/dev/null 2>&1", aibrokerTestScript)).toBeNull();
  });

  it("denies plain node on .ts even when the repo's test script runs tsx", () => {
    expect(nodeOnTypeScriptReason("node src/app.ts", aibrokerTestScript)).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("allows git stash push with .ts pathspecs in any command", () => {
    expect(nodeOnTypeScriptReason("git stash push -q -m w1 -- src/transport/sync-facade.ts")).toBeNull();
  });
});

describe("tscFileArgReason", () => {
  it("should deny tsc with .ts file", () => {
    expect(tscFileArgReason("tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny tsc with .tsx file", () => {
    expect(tscFileArgReason("tsc src/app.tsx")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny tsc with .mts file", () => {
    expect(tscFileArgReason("tsc src/app.mts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should allow tsc with --noEmit", () => {
    expect(tscFileArgReason("tsc --noEmit")).toBeNull();
  });

  it("should allow tsc with -p", () => {
    expect(tscFileArgReason("tsc -p tsconfig.json")).toBeNull();
  });

  it("should allow tsc with --noEmit -p", () => {
    expect(tscFileArgReason("tsc --noEmit -p tsconfig.json")).toBeNull();
  });

  it("should allow tsc with no file arguments", () => {
    expect(tscFileArgReason("tsc")).toBeNull();
  });

  it("should deny npx tsc with .ts file", () => {
    expect(tscFileArgReason("npx tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny npx --no-install tsc with .ts file", () => {
    expect(tscFileArgReason("npx --no-install tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny ./node_modules/.bin/tsc with .ts file", () => {
    expect(tscFileArgReason("./node_modules/.bin/tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny cd x && npx tsc --noEmit src/a.ts", () => {
    expect(tscFileArgReason("cd x && npx tsc --noEmit src/a.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });
});

describe("forceAddReason", () => {
  // forceAddReason hands isIgnored the path resolved against the add's dir, so
  // the fake matches a resolved Notes/ path as well as a relative one.
  const isIgnored = (path: string) => path.startsWith("Notes/") || path.startsWith("/w/Notes/");
  const reason = "Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)";

  it("should deny git add -f", () => {
    expect(forceAddReason("git add -f Notes/x.md", isIgnored, "/w")).toBe(reason);
  });

  it("should deny git add --force", () => {
    expect(forceAddReason("git add --force Notes/x.md", isIgnored, "/w")).toBe(reason);
  });

  it("should deny git add -fA", () => {
    expect(forceAddReason("git add -fA Notes/x.md", isIgnored, "/w")).toBe(reason);
  });

  it("should deny git add with ignored path", () => {
    expect(forceAddReason("git add Notes/x.md", isIgnored, "/w")).toBe(reason);
  });

  it("should allow git add with non-ignored path", () => {
    expect(forceAddReason("git add src/a.ts", isIgnored, "/w")).toBeNull();
  });

  it("should allow git add -A", () => {
    expect(forceAddReason("git add -A", isIgnored, "/w")).toBeNull();
  });

  it("should allow git add with no ignored paths", () => {
    expect(forceAddReason("git add src/a.ts src/b.ts", isIgnored, "/w")).toBeNull();
  });

  // Test for .pai-scratch paths
  it("should deny git add .pai-scratch/x.ts with isIgnored always false", () => {
    const alwaysFalse = () => false;
    expect(forceAddReason("git add .pai-scratch/x.ts", alwaysFalse, "/w")).toBe(reason);
  });

  it("should deny git add ./.pai-scratch/a/b.ts with isIgnored always false", () => {
    const alwaysFalse = () => false;
    expect(forceAddReason("git add ./.pai-scratch/a/b.ts", alwaysFalse, "/w")).toBe(reason);
  });

  it("should deny git add /w/t/.pai-scratch/c.ts with isIgnored always false", () => {
    const alwaysFalse = () => false;
    expect(forceAddReason("git add /w/t/.pai-scratch/c.ts", alwaysFalse, "/w")).toBe(reason);
  });

  it("passes the cd-tracked dir and the resolved path to isIgnored", () => {
    const seen: [string, string][] = [];
    forceAddReason("cd sub && git add src/a.ts", (p, d) => { seen.push([p, d]); return false; }, "/w");
    expect(seen).toEqual([["/w/sub/src/a.ts", "/w/sub"]]);
  });

  it("passes the git -C dir to isIgnored", () => {
    const dirs: string[] = [];
    forceAddReason("git -C /other add src/a.ts", (p, d) => { dirs.push(d); return false; }, "/w");
    expect(dirs).toEqual(["/other"]);
  });

  it("git -C wins over a preceding cd", () => {
    const dirs: string[] = [];
    forceAddReason("cd sub && git -C /other add src/a.ts", (p, d) => { dirs.push(d); return false; }, "/w");
    expect(dirs).toEqual(["/other"]);
  });
});

describe("gitAddPaths", () => {
  it("should return resolved paths for git add", () => {
    expect(gitAddPaths("git add src/a.ts src/b.ts", "/w")).toEqual([
      { path: "/w/src/a.ts", dir: "/w" },
      { path: "/w/src/b.ts", dir: "/w" },
    ]);
  });

  it("should return resolved paths for git add with flags", () => {
    expect(gitAddPaths("git add -f src/a.ts src/b.ts", "/w")).toEqual([
      { path: "/w/src/a.ts", dir: "/w" },
      { path: "/w/src/b.ts", dir: "/w" },
    ]);
  });

  it("should return resolved paths for git add with ignored paths", () => {
    expect(gitAddPaths("git add Notes/x.md src/a.ts", "/w")).toEqual([
      { path: "/w/Notes/x.md", dir: "/w" },
      { path: "/w/src/a.ts", dir: "/w" },
    ]);
  });

  it("should return empty array for git add -A", () => {
    expect(gitAddPaths("git add -A", "/w")).toEqual([]);
  });

  it("should return empty array for git add with no paths", () => {
    expect(gitAddPaths("git add", "/w")).toEqual([]);
  });

  it("should return the resolved path with the cd-tracked dir for cd && git add", () => {
    expect(gitAddPaths("cd x && git add src/a.ts", "/w")).toEqual([{ path: "/w/x/src/a.ts", dir: "/w/x" }]);
  });

  it("should return the resolved path with the git -C dir", () => {
    expect(gitAddPaths("git -C /r add src/a.ts", "/w")).toEqual([{ path: "/r/src/a.ts", dir: "/r" }]);
  });
});
describe("maskedProofReason", () => {
  const masked = [
    "npx tsc --noEmit > /dev/null",
    "npx tsc --noEmit 2>/dev/null",
    "npx vitest run src/x || echo failed",
    "npm test || true",
    "npm run test; true",
    "npx tsc --noEmit || :",
    "pai worker merge abc --verify 'x' &>/dev/null",
    "cd x && npx vitest run || true",
  ];
  for (const c of masked) it(`denies ${c}`, () => expect(maskedProofReason(c)).toContain("run it bare"));
  const fine = [
    "npx tsc --noEmit",
    "npx tsc --noEmit 2>&1 | tail -20",
    "npx vitest run src/x && echo ok",
    "npm test; echo done",
    "ls > /dev/null || true",
    "cat <<'EOF'\nnpx tsc > /dev/null || true\nEOF",
  ];
  for (const c of fine) it(`allows ${c.split("\n")[0]}`, () => expect(maskedProofReason(c)).toBeNull());
});

describe("worker guard heredoc bodies", () => {
  const ctx = (): WorkerGuardContext => ({
    cwd: "/repo/.workers/worktrees/abc",
    home: "/home/u",
    worktreeRoot: "/repo/.workers/worktrees/abc",
    inWorktree: true,
    mainCheckout: "/repo",
    testScript: () => null,
  });
  const denied = (command: string) =>
    JSON.stringify(
      decideWorkerGuard({ tool_name: "Bash", tool_input: { command } } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" }, ctx)
    ).includes("deny");
  it("allows a heredoc script write whose body mentions kill/pkill/xargs", () => {
    expect(denied(`cat > "$TMPDIR/p6.pl" <<'EOF'\nundef $/; s/timedOut = true; child\\.kill\\("SIGTERM"\\)/x/;\npkill -f foo; ls | xargs kill\nEOF`)).toBe(false);
  });
  it("allows a heredoc body containing sed -i", () => {
    expect(denied("cat > x <<'EOF'\nsed -i s/a/b/ f\nEOF")).toBe(false);
  });
  it("denies a bare pkill and one after the terminator", () => {
    expect(denied("pkill -f foo")).toBe(true);
    expect(denied("cat > x <<EOF\nhello\nEOF\npkill foo")).toBe(true);
    expect(denied("cat > x <<EOF; pkill foo\nhello\nEOF")).toBe(true);
  });
});

describe("dbWriteReason (live-database write rule)", () => {
  const ctx: DbWriteContext = { cwd: "/w", home: "/h", worktreeRoot: "/w" };
  const env = {} as Record<string, string | undefined>;
  // the evidence command of 2026-11-18 (worker 20261118-072922-72328): a worker INSERTed into a project's LIVE index through docker exec psql; neutral names here
  const EVIDENCE = 'docker exec app-pgvector psql -U appuser -d appdb -c "INSERT INTO session (id) VALUES (1)"';

  it("denies the exact evidence command", () => {
    const r = dbWriteReason(EVIDENCE, env, ctx);
    expect(r).toContain("live database write blocked");
    expect(r).toContain("INSERT");
    // the message names the rule and all three ways to allow it
    expect(r).toContain("SET default_transaction_read_only = on");
    expect(r).toContain("guard.dbWriteAllow");
    expect(r).toContain("--allow-db-writes");
  });

  it("allows the same command with SET default_transaction_read_only = on first", () => {
    expect(dbWriteReason('docker exec app-pgvector psql -U appuser -d appdb -c "SET default_transaction_read_only = on; INSERT INTO session (id) VALUES (1)"', env, ctx)).toBeNull();
  });

  it("allows a SELECT whose string literal contains the word insert", () => {
    expect(dbWriteReason(`psql -d appdb -c "SELECT 'please insert the row manually' FROM t"`, env, ctx)).toBeNull();
  });

  it("allows sqlite3 on a file in the scratch dir", () => {
    const e = { TMPDIR: "/tmp/pai-scratch/w1" };
    expect(dbWriteReason('sqlite3 /tmp/pai-scratch/w1/x.db "INSERT INTO t VALUES (1)"', e, ctx)).toBeNull();
  });

  it("denies docker compose exec mysql -e \"DROP TABLE x\"", () => {
    expect(dbWriteReason('docker compose exec mysql -e "DROP TABLE x"', env, ctx)).toContain("live database write blocked");
  });

  it("allows a worker started with the --allow-db-writes flag (PAI_ALLOW_DB_WRITES=1)", () => {
    expect(dbWriteReason(EVIDENCE, { PAI_ALLOW_DB_WRITES: "1" }, ctx)).toBeNull();
  });

  it("same db name: the trial container is allowed, the live container denied", () => {
    const allow = { containers: ["*trial-pgvector"], databases: ["*_test", "*_scratch"] };
    const c = { ...ctx, dbWriteAllow: allow };
    expect(dbWriteReason('docker exec apptrial-pgvector psql -U appuser -d appdb -c "INSERT INTO session (id) VALUES (1)"', env, c)).toBeNull();
    expect(dbWriteReason(EVIDENCE, env, c)).toContain("live database write blocked");
  });

  it("allows a *_test / *_scratch db name by default", () => {
    expect(dbWriteReason('docker exec app-pgvector psql -d appdb_test -c "DROP TABLE t"', env, ctx)).toBeNull();
    expect(dbWriteReason('psql -d scratch_index -c "DELETE FROM t"', env, ctx)).toContain("live database write blocked"); // a name merely containing "scratch" is not *_scratch
  });

  it("denies every write form: heredoc, <<<, piped echo/cat, kubectl exec, ssh, mongosh", () => {
    expect(dbWriteReason("psql -d appdb <<'EOF'\nUPDATE t SET a = 1\nEOF", env, ctx)).toContain("blocked");
    expect(dbWriteReason("psql -d appdb <<< 'TRUNCATE t'", env, ctx)).toContain("blocked");
    expect(dbWriteReason("echo 'DELETE FROM t' | psql -d appdb", env, ctx)).toContain("blocked");
    expect(dbWriteReason('kubectl exec db-0 -- psql -c "DROP TABLE t"', env, ctx)).toContain("blocked");
    expect(dbWriteReason("ssh dbhost pg_restore -d proddb dump.gz", env, ctx)).toContain("blocked");
    expect(dbWriteReason('mongosh appdb --eval "db.users.insertOne({a: 1})"', env, ctx)).toContain("blocked");
  });

  it("allows reads and comment-only SQL", () => {
    expect(dbWriteReason("psql -d appdb -c 'SELECT count(*) FROM t'", env, ctx)).toBeNull();
    expect(dbWriteReason('psql -d appdb -c "-- an INSERT would follow in prose\\nSELECT 1"', env, ctx)).toBeNull();
    expect(dbWriteReason("docker exec pg pg_dump appdb > dump.sql", env, ctx)).toBeNull();
  });

  it("denies through the worker guard end to end, and allows the read-only form", () => {
    const gctx = (): WorkerGuardContext => ({
      cwd: "/repo/.workers/worktrees/abc",
      home: "/home/u",
      worktreeRoot: "/repo/.workers/worktrees/abc",
      inWorktree: true,
      mainCheckout: "/repo",
      testScript: () => null,
    });
    const denied = (command: string, env2: Record<string, string | undefined> = { PAI_WORKER: "1" }) =>
      JSON.stringify(decideWorkerGuard({ tool_name: "Bash", tool_input: { command } } as never, { PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir", ...env2 }, gctx)).includes("deny");
    expect(denied(EVIDENCE)).toBe(true);
    expect(denied('docker exec app-pgvector psql -d appdb -c "SET default_transaction_read_only = on; SELECT 1"')).toBe(false);
    expect(denied(EVIDENCE, { PAI_WORKER: "1", PAI_ALLOW_DB_WRITES: "1" })).toBe(false);
  });
});

describe("worker guard backgrounded busy loops", () => {
  const ctx = (): WorkerGuardContext => ({
    cwd: "/repo/.workers/worktrees/abc",
    home: "/home/u",
    worktreeRoot: "/repo/.workers/worktrees/abc",
    inWorktree: true,
    mainCheckout: "/repo",
    testScript: () => null,
  });
  const denied = (command: string) =>
    JSON.stringify(
      decideWorkerGuard({ tool_name: "Bash", tool_input: { command } } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" }, ctx)
    ).includes("deny");
  for (const c of ["( while :; do :; done ) &", "setsid sh -c 'while :; do :; done' &", "yes > /dev/null &", "for i in 1 2; do (while :; do :; done) & done"])
    it(`denies ${c}`, () => expect(denied(c)).toBe(true));
  for (const c of ["timeout 20 sh -c 'while :; do :; done' &", "while read l; do echo $l; done < f", "timeout 5 yes > /dev/null &"])
    it(`allows ${c}`, () => expect(denied(c)).toBe(false));
});

describe("liveContainerReason (live-container rule)", () => {
  const ctx: DbWriteContext = { cwd: "/w", home: "/h", worktreeRoot: "/w", liveContainers: ["app-live", "app-jobs", "app-pgvector"], dbWriteAllow: { containers: ["apptrial-*"], databases: [] } };
  const env = {} as Record<string, string | undefined>;
  const r = (c: string, e = env) => liveContainerReason(c, e, ctx);

  it("denies docker cp into a live container, names container, rule and routes", () => {
    const m = r("docker cp x.py app-live:/tmp/x.py");
    expect(m).toContain("app-live");
    expect(m).toContain("guard.liveContainers");
    expect(m).toContain("trial container");
    expect(m).toContain("--allow-db-writes");
  });
  it("allows docker cp out of a live container", () => {
    expect(r("docker cp app-live:/data/x.csv ./x.csv")).toBeNull();
  });
  it("denies docker exec of an interpreter in a live container", () => {
    expect(r("docker exec app-live python x.py")).toContain("app-live");
    expect(r("docker exec -i app-jobs sh -c 'rm -rf /data'")).toContain("app-jobs");
    expect(r("docker compose exec app-live python x.py")).toContain("app-live");
  });
  it("allows read-only commands and SQL clients in a live container", () => {
    expect(r("docker exec app-live ls /data")).toBeNull();
    expect(r("docker exec app-live find /data -name x")).toBeNull();
    expect(r("docker exec app-live find /data -delete")).toContain("blocked");
    expect(r('docker exec app-pgvector psql -c "SELECT 1"')).toBeNull();
  });
  it("allows the trial container", () => {
    expect(r("docker exec apptrial-app python x.py")).toBeNull();
    expect(r("docker cp x.py apptrial-app:/tmp/x.py")).toBeNull();
  });
  it("denies docker run --volumes-from a live container", () => {
    expect(r("docker run --rm --volumes-from app-live alpine sh")).toContain("app-live");
  });
  it("allows everything on a --allow-db-writes run", () => {
    expect(r("docker exec app-live python x.py", { PAI_ALLOW_DB_WRITES: "1" })).toBeNull();
  });
});

describe("headless-browser automation is denied (operator rule)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ba-"));
  writeFileSync(join(dir, "pw.mjs"), `import { chromium } from "playwright";\n`);
  writeFileSync(join(dir, "pp.js"), `const p = require('puppeteer');\n`);
  writeFileSync(join(dir, "sel.py"), `from selenium import webdriver\n`);
  writeFileSync(join(dir, "ok.mjs"), `console.log("hi");\n`);
  mkdirSync(join(dir, "dep"));
  writeFileSync(join(dir, "dep", "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "^1" } }));
  const gctx = (): WorkerGuardContext => ({ cwd: dir, home: "/home/u", worktreeRoot: dir, inWorktree: true, mainCheckout: "/repo", testScript: () => null });
  const call = (tool_name: string, tool_input: unknown) =>
    decideWorkerGuard({ tool_name, tool_input } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" }, gctx);
  const bash = (command: string) => call("Bash", { command });
  const denied = (command: string) => bash(command).decision === "deny";
  const forms = [
    "npx playwright test", "playwright test", "npx -y playwright codegen", "npm install playwright", "npm i -D @playwright/test",
    "pnpm add puppeteer-core", "yarn add selenium-webdriver", "bun add playwright-core", "pip install playwright", "uv pip install selenium",
    "pip3 install pyppeteer", "python -m playwright install", "python3 -m playwright codegen", "playwright install chromium", "npx @puppeteer/browsers install chrome",
    "node pw.mjs", "tsx pw.mjs", "npx tsx pw.mjs", "node pp.js", "python sel.py",
    `cd /x && node ${dir}/pw.mjs`, `python - <<'EOF'\nfrom playwright.sync_api import sync_playwright\nEOF`, `node -e "require('puppeteer')"`,
  ];
  for (const f of forms) it(`denies: ${f.split("\n")[0]}`, () => expect(denied(f)).toBe(true));
  it("uses the operator message", () => {
    expect(JSON.stringify(bash("npx playwright test"))).toContain("Playwright/Puppeteer/Selenium are not used here (operator rule). For web pages use the claude-in-chrome MCP tools, for apps clickr; plain `chrome --headless` (dump-dom, print-to-pdf, screenshot) is allowed.");
  });
  it("allows reading and unrelated commands", () => {
    for (const c of ["grep playwright package.json", "node ok.mjs", "npm install vitest", "pip install requests", "npx tsc --noEmit", "git log --grep=puppeteer", "chromium --headless --use-mock-keychain --password-store=basic --dump-dom x", "google-chrome --headless=new --use-mock-keychain --password-store=basic --screenshot x"]) expect(denied(c)).toBe(false);
  });
  it("denies an Edit/Write that adds an import, allows it in a repo that already depends on one", () => {
    const imp = `import { test } from "@playwright/test";\n`;
    expect(call("Write", { file_path: join(dir, "a.ts"), content: imp }).decision).toBe("deny");
    expect(call("Edit", { file_path: join(dir, "a.py"), new_string: "from selenium import webdriver" }).decision).toBe("deny");
    expect(call("Write", { file_path: join(dir, "a.ts"), content: "export const x = 1;\n" }).decision).not.toBe("deny");
    expect(call("Write", { file_path: join(dir, "dep", "e2e.spec.ts"), content: imp }).decision).not.toBe("deny");
  });
});

describe("worker guard GNU sed X,+N range", () => {
  const ctx = (): WorkerGuardContext => ({
    cwd: "/repo/.workers/worktrees/abc",
    home: "/home/u",
    worktreeRoot: "/repo/.workers/worktrees/abc",
    inWorktree: true,
    mainCheckout: "/repo",
    testScript: () => null,
  });
  const run = (command: string) =>
    decideWorkerGuard({ tool_name: "Bash", tool_input: { command } } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" }, ctx) as { decision: string; updatedInput?: { command: string }; context?: string };
  it.skipIf(process.platform !== "darwin")("rewrites a single-quoted range", () => {
    const d = run("sed -n '120,+40p' f.ts");
    expect(d.decision).toBe("allow");
    expect(d.updatedInput?.command).toBe("sed -n '120,160p' f.ts");
    expect(d.context).toContain("rewrote sed X,+N to BSD form");
  });
  it.skipIf(process.platform !== "darwin")("rewrites a double-quoted range with two files", () => {
    expect(run('sed -n "5,+3p" a b').updatedInput?.command).toBe('sed -n "5,8p" a b');
  });
  it.skipIf(process.platform !== "darwin")("rewrites GNU sed -i (no suffix) to sed -i ''", () => {
    const cases: Array<[string, string]> = [
      ["sed -i 's/a/b/' f", "sed -i '' 's/a/b/' f"],
      ['sed -i "s/a/b/g" f', `sed -i '' "s/a/b/g" f`],
      ["sed -i -e 's/a/b/' f", "sed -i '' -e 's/a/b/' f"],
      ["sed -i -E 's/(a)/\\1/' f", "sed -i '' -E 's/(a)/\\1/' f"],
      ["sed -i '5d' f", "sed -i '' '5d' f"],
      ["cd x && sed -i 's/a/b/' f && echo ok", "cd x && sed -i '' 's/a/b/' f && echo ok"],
      ["sed -i 's/a/b/' f; sed -i -e 's/c/d/' g | cat", "sed -i '' 's/a/b/' f; sed -i '' -e 's/c/d/' g | cat"],
    ];
    for (const [cmd, want] of cases) {
      const d = run(cmd);
      expect(d.decision, cmd).toBe("allow");
      expect(d.updatedInput?.command, cmd).toBe(want);
      expect(d.context).toContain("rewrote sed -i to sed -i '' for BSD sed");
    }
    const json = JSON.parse(renderDecision(run("sed -i 's/a/b/' f") as never));
    expect(json.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(json.hookSpecificOutput.updatedInput.command).toBe("sed -i '' 's/a/b/' f");
    expect(json.hookSpecificOutput.additionalContext).toContain("rewrote sed -i");
  });
  it.skipIf(process.platform !== "darwin")("leaves BSD sed -i forms untouched", () => {
    for (const cmd of ["sed -i '' 's/a/b/' f", "sed -i.bak 's/a/b/' f", "sed -i -- '' 's/a/b/' f", "sed -i '' -e 's/a/b/' f"]) {
      const d = run(cmd);
      expect(d.decision, cmd).toBe("allow");
      expect(d.updatedInput, cmd).toBeUndefined();
    }
  });
  it.skipIf(process.platform !== "darwin")("keeps denying an ambiguous sed -i", () => {
    for (const cmd of ["sed -i 's' f", "sed -i /tmp/x f"]) expect(run(cmd).decision, cmd).toBe("deny");
  });
  it.skipIf(process.platform !== "darwin")("still denies a non-numeric start", () => {
    expect(run("sed -n '/foo/,+3p' f").decision).toBe("deny");
  });

  // the two denials of 2026-11-18 (worker 20261118-211912-48686): a computed start `$(grep …),+Np` is rewritten to
  // `X,$p | head -n N+1`, which prints the same lines on BSD sed as GNU sed's `X,+Np` would.
  const fixture = (lines: number, hitAt: number): string => {
    const dir = mkdtempSync(join(tmpdir(), "sed-range-"));
    const f = join(dir, "fixture.txt");
    const body = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(f, body.replace(`line ${hitAt}\n`, `target line ${hitAt} export async function detectSession export function isFrozen\n`));
    return f;
  };
  it.skipIf(process.platform !== "darwin")("rewrites a computed start to X,$p | head -n N+1", () => {
    const f = fixture(40, 5);
    const d = run(`sed -n "$(grep -n 'export async function detectSession' ${f} | cut -d: -f1),+30p" ${f}`);
    expect(d.decision).toBe("allow");
    expect(d.updatedInput?.command).toBe(`sed -n "$(grep -n 'export async function detectSession' ${f} | cut -d: -f1),\\$p" ${f} | head -n 31`);
    // the rewritten command runs on BSD sed and prints the same lines GNU sed's `,+N` would (start line, then N more)
    const out = execSync(d.updatedInput!.command, { shell: "/bin/bash", encoding: "utf8" });
    expect(out.split("\n").slice(0, -1)).toEqual(Array.from({ length: 31 }, (_, i) => `line ${5 + i}`).map((l, i) => (i === 0 ? "target line 5 export async function detectSession export function isFrozen" : l)));
  });
  it.skipIf(process.platform !== "darwin")("rewrites a computed start with a short file and keeps the quoting", () => {
    const f = fixture(12, 3);
    const d = run(`sed -n "$(grep -n 'export function isFrozen' ${f} | cut -d: -f1),+20p" ${f}`);
    expect(d.decision).toBe("allow");
    expect(d.updatedInput?.command).toContain(',\\$p" ');
    expect(d.updatedInput?.command).toContain("| head -n 21");
    const out = execSync(d.updatedInput!.command, { shell: "/bin/bash", encoding: "utf8" });
    expect(out.split("\n").slice(0, -1)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${3 + i}`).map((l, i) => (i === 0 ? "target line 3 export async function detectSession export function isFrozen" : l)));
  });
  it.skipIf(process.platform !== "darwin")("keeps a following pipeline and command intact", () => {
    const f = fixture(40, 5);
    const d = run(`sed -n "$(grep -n 'export function isFrozen' ${f} | cut -d: -f1),+8p" ${f} | grep target; echo done`);
    expect(d.decision).toBe("allow");
    // the cap lands between the sed call and the worker's own pipeline/command, both untouched
    expect(d.updatedInput?.command).toContain(`${f} | head -n 9`);
    expect(d.updatedInput?.command.endsWith("| grep target; echo done")).toBe(true);
    const out = execSync(d.updatedInput!.command, { shell: "/bin/bash", encoding: "utf8" });
    expect(out).toBe("target line 5 export async function detectSession export function isFrozen\ndone\n");
  });
  it.skipIf(process.platform !== "darwin")("still denies a computed start with a mutating command", () => {
    expect(run(`sed -n "$(grep -n x f),+8d" f`).decision).toBe("deny");
  });
});

// the worktree write fence (2026-11-19: worker 20261119-191808-81967 edited another repo's files from its PAI worktree)
describe("worker guard Edit/Write stays inside the worktree and scratch dirs", () => {
  const base = mkdtempSync(join(tmpdir(), "fence-"));
  // <base>/wt is the worker's git worktree; <base>/other is a sibling repo; <base>/scratch/pai-scratch/<id> is its scratch dir
  const wt = join(base, "wt");
  const other = join(base, "other");
  const scratchRoot = join(base, "scratch", "pai-scratch");
  const scratchId = join(scratchRoot, "w1");
  mkdirSync(join(wt, ".pai-scratch"), { recursive: true });
  mkdirSync(other, { recursive: true });
  mkdirSync(scratchId, { recursive: true });
  writeFileSync(join(other, "cli.ts"), "export const x = 1;\n");
  symlinkSync(other, join(wt, "link-out"));
  const gctx = (): WorkerGuardContext => ({
    cwd: wt,
    home: "/home/u",
    worktreeRoot: wt,
    inWorktree: true,
    mainCheckout: join(base, "main"),
    testScript: () => null,
    scratchDirs: [scratchId],
  });
  const call = (tool_name: string, tool_input: unknown) =>
    decideWorkerGuard({ tool_name, tool_input } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" }, gctx);
  it("allows an Edit inside the worktree", () => {
    expect(call("Edit", { file_path: join(wt, "src", "a.ts"), old_string: "a", new_string: "b" }).decision).not.toBe("deny");
  });
  it("denies an Edit into a sibling repo (the 2026-11-19 incident)", () => {
    const d = call("Edit", { file_path: join(other, "cli.ts"), old_string: "x = 1", new_string: "x = 2" });
    expect(d.decision).toBe("deny");
    expect((d as { reason?: string }).reason).toContain("file writes outside your worktree are blocked");
    expect((d as { reason?: string }).reason).toContain("L0 can hand it over");
  });
  it("allows a Write to .pai-scratch inside the worktree", () => {
    expect(call("Write", { file_path: join(wt, ".pai-scratch", "probe.ts"), content: "1\n" }).decision).not.toBe("deny");
  });
  it("allows a Write to the run's $TMPDIR scratch dir (the pai-scratch/<id> path)", () => {
    expect(call("Write", { file_path: join(scratchId, "x.txt"), content: "1\n" }).decision).not.toBe("deny");
    // and the env form: TMPDIR set to the run's scratch dir allows anywhere under it
    const d = decideWorkerGuard({ tool_name: "Write", tool_input: { file_path: join(scratchId, "y.txt"), content: "1\n" } } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir", TMPDIR: scratchId }, () => ({ ...gctx(), scratchDirs: undefined }));
    expect(d.decision).not.toBe("deny");
  });
  it("denies a Write to another pai-scratch worker's dir", () => {
    expect(call("Write", { file_path: join(scratchRoot, "w2", "x.txt"), content: "1\n" }).decision).toBe("deny");
  });
  it("denies a ../ path escaping the worktree", () => {
    expect(call("Write", { file_path: join(wt, "..", "other", "cli.ts"), content: "x" }).decision).toBe("deny");
  });
  it("denies a symlink inside the worktree pointing outside", () => {
    expect(call("Edit", { file_path: join(wt, "link-out", "cli.ts"), old_string: "x = 1", new_string: "x = 2" }).decision).toBe("deny");
  });
  it("denies a Bash redirect into another repo (the parser already has write targets)", () => {
    const bash = (command: string) => decideWorkerGuard({ tool_name: "Bash", tool_input: { command } } as never, { PAI_WORKER: "1", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" }, gctx);
    expect(bash(`echo hi > ${join(other, "cli.ts")}`).decision).toBe("deny");
    expect(bash(`echo hi | tee ${join(other, "cli.ts")}`).decision).toBe("deny");
    expect(bash(`echo hi > ${join(wt, "src", "ok.txt")}`).decision).not.toBe("deny");
    expect(bash("echo hi > /dev/null").decision).not.toBe("deny"); // /dev writes are exempt
  });
});

// the local-worker tracked-file delete rule and its `pai tests prune --apply` exception (2026-11-20: worker 20261120-224741-74918 was blocked from git rm-ing its plan's file and rewrote 91 lines of tests/KEPT.md instead)
describe("worker guard local tracked-file delete and the prune-plan exception", () => {
  const base = mkdtempSync(join(tmpdir(), "rmrule-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "src", "bench"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "src", "bench", "onboarding.test.ts"), "test(1);\n");
  writeFileSync(join(repo, "tests", "KEPT.md"), "# kept\n");
  writeFileSync(join(repo, "src", "bench", "onboarding.test.ts.bak"), "stale copy, still tracked\n"); // prefix of the plan path: must not match it
  const g = (a: string) => execSync(`git -C ${repo} ${a}`, { encoding: "utf8" });
  g("init -q");
  g("config user.email t@t.local");
  g("config user.name test");
  g("add src/bench/onboarding.test.ts tests/KEPT.md src/bench/onboarding.test.ts.bak");
  g("commit -qm init"); // a HEAD: addedByBranch sees both files as tracked from the branch start
  const gctx = (): WorkerGuardContext => ({
    cwd: repo,
    home: "/home/u",
    worktreeRoot: repo,
    inWorktree: true,
    mainCheckout: repo,
    testScript: () => null,
  });
  const localEnv = (extra: Record<string, string | undefined> = {}) => ({ PAI_WORKER: "1", PAI_WORKER_PROVIDER: "local-model", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir", ...extra });
  const denied = (command: string, env: Record<string, string | undefined>) =>
    decideWorkerGuard({ tool_name: "Bash", tool_input: { command } } as never, env, gctx).decision === "deny";
  const PLAN = "src/bench/onboarding.test.ts";
  it("a normal local worker is blocked from git rm of a tracked file", () => {
    expect(denied(`git rm ${PLAN}`, localEnv())).toBe(true);
    expect(denied(`rm ${PLAN}`, localEnv())).toBe(true);
  });
  it("a prune worker deletes exactly its plan's file", () => {
    expect(denied(`git rm ${PLAN}`, localEnv({ PAI_WORKER_PRUNE_FILES: PLAN }))).toBe(false);
    expect(denied(`rm ${PLAN}`, localEnv({ PAI_WORKER_PRUNE_FILES: PLAN }))).toBe(false);
  });
  it("a prune worker is still blocked on an unplanned tracked file", () => {
    expect(denied("git rm tests/KEPT.md", localEnv({ PAI_WORKER_PRUNE_FILES: PLAN }))).toBe(true);
    // a prefix path does not sneak through the plan match
    expect(denied("git rm src/bench/onboarding.test.ts.bak", localEnv({ PAI_WORKER_PRUNE_FILES: PLAN }))).toBe(true);
  });
  it("an anthropic (non-local) worker is never touched by this rule", () => {
    expect(denied("git rm tests/KEPT.md", { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "anthropic", PAI_WORKER_LOOP_DIR: "/nonexistent-loop-dir" })).toBe(false);
  });
});

// the new-test-file denial names the existing test files to extend (same directory first, then parents, bounded at the repo root)
describe("test-governance denial names existing test files to extend", () => {
  let base: string;
  let repo: string;
  beforeEach(() => {
    // a bare /tmp base: tmpdir() here is the worker's pai-scratch dir, which the guard treats as scratch;
    // the fixture paths are not, so the guard governs them with cwd/repo root pointed at the fixture
    base = mkdtempSync(join("/tmp", "gov-"));
    repo = join(base, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    execSync(`git -C ${repo} init -q`);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const denyReason = (filePath: string, cwd = repo) => {
    const d = decideTestGovernance({ tool: "Write", filePath, cwd });
    expect(d.decision).toBe("deny");
    return (d as { reason?: string }).reason ?? "";
  };
  it("names the same-directory existing *.test.ts files in the denial reason", () => {
    writeFileSync(join(repo, "src", "a.test.ts"), "test(1);\n");
    writeFileSync(join(repo, "src", "b.test.ts"), "test(2);\n");
    const reason = denyReason(join(repo, "src", "new.test.ts"));
    expect(reason).toContain("Extend one of: src/a.test.ts, src/b.test.ts");
  });
  it("walks up to the repo root but no further (a test file above the root is not named)", () => {
    writeFileSync(join(base, "outer.test.ts"), "test(1);\n"); // above the repo root: never named
    writeFileSync(join(repo, "root.test.ts"), "test(2);\n"); // in the repo root itself: named
    const reason = denyReason(join(repo, "src", "deep", "new.test.ts"));
    expect(reason).toContain("Extend one of: root.test.ts");
    expect(reason).not.toContain("outer.test.ts");
  });
  it("caps the hint list and keeps same-directory files first", () => {
    for (const n of ["a", "b", "c", "d"]) writeFileSync(join(repo, "src", `${n}.test.ts`), "test();\n");
    writeFileSync(join(repo, "m1.test.ts"), "test();\n");
    writeFileSync(join(repo, "m2.test.ts"), "test();\n");
    const listed = denyReason(join(repo, "src", "sub", "new.test.ts")).match(/Extend one of: (.*?)\.?$/m)?.[1].split(", ") ?? [];
    expect(listed).toEqual(["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts", "m1.test.ts"]);
  });
  it("says no existing test file was found when the walk names none", () => {
    const reason = denyReason(join(repo, "src", "new.test.ts"));
    expect(reason).not.toContain("Extend one of:");
    expect(reason).toContain("No existing test file found near it to extend.");
  });
  it("names the nearby files on a Bash write denial too", () => {
    writeFileSync(join(repo, "src", "a.test.ts"), "test(1);\n");
    const d = decideTestGovernance({ tool: "Bash", command: `echo x > ${join(repo, "src", "new.test.ts")}`, cwd: repo });
    expect(d.decision).toBe("deny");
    expect((d as { reason?: string }).reason).toContain("Extend one of: src/a.test.ts");
  });
  it("names `pai tests keep` as the way to add the ledger entry", () => {
    const reason = denyReason(join(repo, "src", "new.test.ts"));
    expect(reason).toContain('`pai tests keep <file> --kind <a|b|c> --evidence "<why>"`');
  });
});
