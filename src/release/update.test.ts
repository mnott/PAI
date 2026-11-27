import { describe, expect, it } from "vitest";
import { formatCompanion, updateCompanion } from "./update.js";

const rel = (v: string) => JSON.stringify({ tag_name: `v${v}`, assets: [{ name: "aibroker.tgz", browser_download_url: `https://x/${v}/aibroker.tgz` }] });
const pkg = (version: string) => async () => ({ name: "aibroker", version, repository: "github:mnott/AIBroker" });

function fakes(latest: string, installed: string | null) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      http: async () => ({ status: 200, text: rel(latest) }),
      installed: installed ? pkg(installed) : async () => null,
      run: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(" "));
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("updateCompanion", () => {
  it("upgrades an older AIBroker from the release tgz and restarts the daemon", async () => {
    const f = fakes("0.62.32", "0.62.31");
    const c = await updateCompanion({}, f.deps);
    expect(f.calls).toEqual(["npm i -g https://x/0.62.32/aibroker.tgz", "aibroker restart"]);
    expect(c.restart).toBe("restarted");
    expect(formatCompanion(c)).toContain("0.62.31 -> 0.62.32");
  });
  it("--check reports without installing", async () => {
    const f = fakes("0.62.32", "0.62.31");
    const c = await updateCompanion({ check: true }, f.deps);
    expect(f.calls).toEqual([]);
    expect(formatCompanion(c)).toContain("update available");
  });
  it("up to date does nothing; not installed is skipped", async () => {
    const a = fakes("0.62.32", "0.62.32");
    expect((await updateCompanion({}, a.deps)).report?.newer).toBe(false);
    expect(a.calls).toEqual([]);
    expect(formatCompanion((await updateCompanion({}, fakes("1.0.0", null).deps)))).toBeNull();
  });
});
