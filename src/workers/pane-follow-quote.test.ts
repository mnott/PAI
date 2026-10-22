import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { followCommand } from "./pane.js";

const argv1 = process.argv[1];
afterEach(() => {
  process.argv[1] = argv1;
});

describe("followCommand quoting", () => {
  it("keeps a CLI path with a space as one argument", () => {
    process.argv[1] = "/opt/my tools/it's/pai";
    const cmd = followCommand("w1");
    const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${cmd}`], { encoding: "utf8" }).split("\n");
    expect(out.slice(1, 5)).toEqual(["/opt/my tools/it's/pai", "worker", "follow", "w1"]);
  });

  it("leaves safe paths bare", () => {
    process.argv[1] = "/usr/local/bin/pai";
    expect(followCommand("w1")).toBe(`${process.execPath} /usr/local/bin/pai worker follow w1`);
  });
});
