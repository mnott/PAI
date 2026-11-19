import { describe, expect, it } from "vitest";
import { lastCommand } from "./tool-errors.js";

describe("lastCommand", () => {
  it("strips quoted spans", () => {
    expect(lastCommand(`echo "a | b" && grep 'x;y' f`)).toMatchObject({ name: "grep", compound: true });
  });
  it("is linear on a 200 KB command with a heredoc and an unmatched quote", () => {
    const cmd = `python3 - <<'PY'\n${"print(\"it's\")\n".repeat(8000)}PY\necho "oops ${"x \\\" ' ".repeat(25000)}`;
    expect(cmd.length).toBeGreaterThan(200_000);
    const t = Date.now();
    lastCommand(cmd);
    expect(Date.now() - t).toBeLessThan(50);
  });
});
