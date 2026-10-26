import { describe, it, expect } from "vitest";
import { evaluate, type GuardContext } from "./evaluate.js";
import { loadRules, allRuleDirs } from "../hooks/ts/lib/rules/load.js";

const cwd = process.cwd();
const rules = loadRules(allRuleDirs(cwd)).rules;
const base = (): GuardContext => ({ env: {}, record: () => undefined });
const bash = (command: string) => ({ kind: "tool_call" as const, tool: "Bash", input: { command }, cwd });

describe("evaluate: heredoc bodies", () => {
  const body = "it('x', () => { run(\"rm -rf /\"); run(\"plutil -extract Key json /tmp/a.plist\"); });";
  const ctx = (): GuardContext => ({ ...base(), shellRules: rules, gates: { plutil: true } });

  it("does not scan the body of a heredoc written to a file with cat or tee", () => {
    for (const head of ["cat > src/guard/x.test.ts <<'EOF'", "cat >> notes.md <<EOF", "cat <<-EOF > out.txt", "tee out.txt <<'EOF'", "cat > f <<\"EOF\" 2>/dev/null"]) {
      const d = evaluate(bash(`${head}\n${body}\nEOF`), ctx());
      expect(d.action, head).toBe("allow");
    }
  });

  it("still scans the command line itself and what follows the terminator", () => {
    expect(evaluate(bash("cat > f.txt <<'EOF'\nhello\nEOF\nrm -rf /"), ctx()).action).toBe("deny");
    expect(evaluate(bash("rm -rf / && cat > f.txt <<'EOF'\nhello\nEOF"), ctx()).action).toBe("deny");
  });

  it("keeps the body of a heredoc that feeds a shell", () => {
    for (const head of ["bash <<'EOF'", "sh -s <<EOF", "cat > f.sh <<EOF | bash", "cat <<EOF | sh", "sudo bash <<EOF"]) {
      const d = evaluate(bash(`${head}\nrm -rf /\nEOF`), ctx());
      expect(d.action, head).toBe("deny");
    }
    expect(evaluate(bash("bash <<'EOF'\nplutil -extract Key json /tmp/a.plist\nEOF"), ctx())).toMatchObject({ action: "deny", patternId: "plutil-guard" });
  });

  it("a heredoc with no file sink (cat to stdout) keeps its body scanned", () => {
    expect(evaluate(bash("cat <<'EOF'\nrm -rf /\nEOF"), ctx()).action).toBe("deny");
  });
});
