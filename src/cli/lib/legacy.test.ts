import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { rawSource, runCommander } from "./legacy.js";

const register = (seen: string[][]) => (g: Command) => {
  g.command("echo <word>").option("--loud", "shout").action((word: string, o: { loud?: boolean }) => void seen.push([word, String(!!o.loud)]));
  g.command("fail").action(() => {
    throw new Error("Project not found: x");
  });
  g.command("need <a>").action(() => undefined);
};

describe("runCommander", () => {
  it("forwards the typed tokens to the Commander implementation unchanged", async () => {
    const seen: string[][] = [];
    expect(await runCommander("grp", register(seen), ["echo", "hi", "--loud"])).toBe(0);
    expect(seen).toEqual([["hi", "true"]]);
  });
  it("turns a thrown error into the old one-line message and exit 1", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCommander("grp", register([]), ["fail"])).toBe(1);
    expect(String(spy.mock.calls[0][0])).toContain("Project not found: x");
    spy.mockRestore();
  });
  it("returns Commander's own exit code for usage errors", async () => {
    const w = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runCommander("grp", register([]), ["need"])).toBe(1);
    w.mockRestore();
  });
  it("reads the raw tokens from process.argv by default", () => {
    expect(rawSource.argv()).toEqual(process.argv.slice(2));
  });
});
