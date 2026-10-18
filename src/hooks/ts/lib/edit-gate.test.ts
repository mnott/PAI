import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  isProseEdit,
  decideEditGate,
  decideOrchestratorEdit,
  decideOrchestratorBash,
  isOrchestratorScratch,
  type EditGateContext,
} from "./edit-gate.js";

describe("isProseEdit", () => {
  it.each([
    ["Notes/TODO.md", true],
    ["notes/x.md", true],
    ["README.md", true],
    ["docs/commands/worker.md", true],
    ["src/workers/run.ts", false],
    ["package.json", false],
    ["scripts/build-hooks.mjs", false],
    ["src/foo.md", true],
  ])("%s -> %s", (filePath, expected) => {
    expect(isProseEdit(filePath)).toBe(expected);
  });
});

describe("isOrchestratorScratch", () => {
  it.each([
    [".pai-scratch/a.ts", true],
    ["/w/t/.pai-scratch/zz-chk.test.ts", true],
    ["src/.pai-scratch-x/a.ts", false],
    ["src/a.ts", false],
  ])("%s -> %s", (filePath, expected) => {
    expect(isOrchestratorScratch(filePath)).toBe(expected);
  });
});

describe("decideOrchestratorEdit", () => {
  it.each([
    ["/repo/Notes/three-tier-log.md", "allow"],
    ["/repo/README.md", "allow"],
    ["/tmp/spec-1.txt", "allow"],
    ["/private/tmp/x/spec.json", "allow"],
    ["/w/t/.pai-scratch/zz-chk.test.ts", "allow"],
    ["/repo/src/workers/run.ts", "block"],
    ["/repo/package.json", "block"],
  ])("filePath %s should be %s", (filePath, expected) => {
    const result = decideOrchestratorEdit(filePath);
    expect(result.decision).toBe(expected);
    if (result.decision === "block") {
      expect(result.reason).not.toContain("local30x8");
      expect(result.reason).toContain("pai worker run --provider <the local provider named in your brief> --class implement");
      expect(result.reason).toContain(filePath);
      expect(result.reason).toContain(".pai-scratch");
    }
  });
});

describe("decideOrchestratorBash", () => {
  it.each([
    ["sed -i 's/a/b/' src/x.ts", "block"],
    ["perl -pi -e 's/a/b/' src/x.ts", "block"],
    ["perl -0pi -e 's/a/b/' src/x.ts", "block"],
    ["cat > src/a.ts", "block"],
    ["echo x >> lib/b.py", "block"],
    ["printf x | tee src/c.js", "block"],
    ["cd /w/t/.pai-scratch; sed -i '' 's/^--- unit ---$/.../' u5.txt u5.unit shared.txt", "allow"],
    ["cd .pai-scratch; sed -i '' 's/a/b/' *.txt", "allow"],
    ["sed -i '' 's/a/b/' .pai-scratch/*.txt", "allow"],
    ["sed -n '/^--- shared ---/,/^--- unit ---/p' /tmp/ab3c1u-u6-backend.txt > /tmp/ab3c1u-u6-backend2.txt | sed -i 's/Do not touch src\\/cli\\/program.ts\\./Only touch the files named in the unit./' /tmp/ab3c1u-u6-backend2.txt", "allow"],
    ["sed -i 's/x/src\\/y.ts/' /tmp/a.txt", "allow"],
    ["sed -i -e 's/a/b/' src/x.ts", "block"],
    ["sed -i --expression='s/a/b/' src/x.ts", "block"],
    ["sed -i --expression='s/a/src\\/y.ts/' /tmp/a.txt", "allow"],
    ["sed -i '' 's/a/b/' src/x.ts", "block"],
    ["perl -i -pe 's/a/b/' src/x.ts", "block"],
    ["sed -i 's/a/b/' src/foo.ts", "block"],
    ["sed -i 's/a/b/' src/*", "block"],
    ["sed -i 's/a/b/' $FILES", "block"],
    ["perl -pi -e 's/a/b/' notes.md", "allow"],
    ["sed -i 's/a/b/' notes.md src/x.ts", "block"],
    ["git mv src/a.ts src/b.ts", "allow"],
    ["git rm src/a.ts", "allow"],
    ["git merge worker/abc", "allow"],
    ["npx vitest run src/workers", "allow"],
    ["cat src/a.ts", "allow"],
    ["echo hi > /tmp/spec.ts", "allow"],
    ["echo hi > Notes/log.md", "allow"],
    ["ls 2>&1", "allow"],
    ["cat > .pai-scratch/dump.ts", "allow"],
    ["echo hi > .pai-scratch/a.ts", "allow"],
    ["echo hi > src/a.ts", "block"],
    ["python3 -c \"open('src/a.ts','w').write('x')\"", "block"],
    ["node -e \"require('fs').writeFileSync('src/a.ts','x')\"", "block"],
    ["python3 -c \"open('/tmp/x.txt','w').write('x')\"", "allow"],
    ["python3 -c \"print(1)\"", "allow"],
    ["node scripts/build-hooks.mjs", "allow"],
    ["D=/tmp/u2-66894; mkdir -p $D && cp /tmp/u2/{shared,A,B,C1}.txt $D/ && cd $D && for u in A B C1; do cat shared.txt $u.txt > spec-$u.txt; done", "allow"],
    ["for u in A B; do cat x > spec-$u.md; done", "allow"],
    ["for u in A B; do cat x > out-$u.json; done", "allow"],
    ["D=/tmp/x; cat x > $D/foo.ts", "allow"],
    ["D=src; cat x > $D/foo.ts", "block"],
    ["cat x > $D/foo.ts", "block"],
    ["for u in A; do cat x > src/$u.ts; done", "block"],
    ["cat x > $F", "block"],
    ["cat x | tee $F", "block"],
    ["cat x > /dev/null 2>&1", "allow"],
  ])("command %s should be %s", (command, expected) => {
    const result = decideOrchestratorBash(command);
    expect(result.decision).toBe(expected);
    if (result.decision === "block") {
      expect(result.reason).toContain("Bash may not write code files in place");
      expect(result.reason).not.toContain("local30x8");
      expect(result.reason).toContain("pai worker run --provider <the local provider named in your brief> --class implement");
    }
  });
});

it("the block reason names the scratch dir", () => {
  const r = decideOrchestratorBash("echo hi > src/a.ts");
  expect(r.decision).toBe("block");
  expect((r as { reason: string }).reason).toContain(".pai-scratch/");
});

describe("decideEditGate", () => {
  function ctx(overrides: Partial<EditGateContext>): EditGateContext {
    return {
      filePath: "/repo/src/workers/run.ts",
      isPaiWorker: false,
      isExemptPrefix: false,
      isGitWorkTree: true,
      ...overrides,
    };
  }

  it("allows a prose path even inside a git work tree", () => {
    expect(decideEditGate(ctx({ filePath: "/repo/Notes/TODO.md" }))).toEqual({ decision: "allow" });
  });

  it("blocks a code path inside a git work tree with the standing message", () => {
    const out = decideEditGate(ctx({}));
    expect(out.decision).toBe("block");
    expect((out as { reason: string }).reason).toContain("main session does not edit code");
    expect((out as { reason: string }).reason).toContain("pai worker run");
  });

  it("tells the session this is a standing policy, not a one-off error, and names the next step", () => {
    const out = decideEditGate(ctx({}));
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("standing policy for the whole session");
    expect(reason).toContain("retrying Edit/Write");
    expect(reason).toContain("--provider anthropic");
    expect(reason).toContain(ctx({}).filePath);
  });

  it("allows worker sessions regardless of path", () => {
    expect(decideEditGate(ctx({ isPaiWorker: true }))).toEqual({ decision: "allow" });
  });

  it("allows exempt prefixes regardless of path", () => {
    expect(decideEditGate(ctx({ isExemptPrefix: true }))).toEqual({ decision: "allow" });
  });

  it("allows paths outside any git work tree", () => {
    expect(decideEditGate(ctx({ isGitWorkTree: false }))).toEqual({ decision: "allow" });
  });
});

describe("decideOrchestratorBash heredocs", () => {
  const body = "Edit src/cli/foo.ts then run sed -i s/a/b/ src/x.ts\nrun: echo hi > src/x.ts";
  it.each([
    [`cat > /tmp/spec.txt <<'EOF'\n${body}\nEOF`, "allow"],
    [`cat > /tmp/spec.txt <<EOF\n${body}\nEOF`, "allow"],
    [`cat > /tmp/spec.txt <<-EOF\n\t${body}\n\tEOF`, "allow"],
    ["cat > src/x.ts <<'EOF'\nhello\nEOF", "block"],
    ["cat > /tmp/a.txt <<'EOF'\nx\nEOF\ncat > src/x.ts <<'EOF'\ny\nEOF", "block"],
    ["cd /tmp/d && cat > a.txt", "allow"],
    ["cd /tmp/d && cat > a.ts", "allow"],
    ["cd src && cat > a.ts", "block"],
    ["cd /tmp/d && cd ../repo && cat > a.ts", "block"],
  ])("command %j should be %s", (command, expected) => {
    expect(decideOrchestratorBash(command).decision).toBe(expected);
  });

  it("allows the saved denied spec-writing command", () => {
    const f = `${process.env.HOME}/ab-run3/specs-archive/denied-heredoc-c1u-u3.txt`;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      return;
    }
    expect(decideOrchestratorBash(text).decision).toBe("allow");
  });
});
