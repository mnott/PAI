/**
 * Summary daemon label per platform; step 17 answering y (or --yes) leaves
 * workers on with the built-in anthropic provider. HOME is a temp dir and
 * modules are re-imported so nothing resolves under the real home.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let out: string[];

// A readline stand-in answering every question with `answer`.
const answering = (answer: string) =>
  ({ question: (_q: string, cb: (a: string) => void) => cb(answer) }) as never;

async function load() {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_DIR", "");
  vi.stubEnv("PAI_HOME", "");
  vi.stubEnv("ADAPTER_DIR", "");
  const utils = await import("./utils.js");
  const { stepWorkers } = await import("./steps/17-workers.js");
  const { stepSummary } = await import("./steps/15-verify.js");
  const { readWorkersSection } = await import("../../../workers/config.js");
  return { ...utils, stepWorkers, stepSummary, readWorkersSection };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-setup-workers-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function summary(m: Awaited<ReturnType<typeof load>>, installed: boolean, plat: NodeJS.Platform) {
  m.stepSummary({}, false, false, false, false, false, false, false, "PAI", installed, false, plat);
  return out.find((l) => l.includes("Daemon:")) ?? "";
}

describe("summary daemon line", () => {
  it("names the systemd unit on linux", async () => {
    expect(summary(await load(), true, "linux")).toMatch(/pai-daemon\.service \(installed\)/);
  });
  it("names the launchd label on darwin", async () => {
    expect(summary(await load(), true, "darwin")).toMatch(/com\.pai\.pai-daemon \(installed\)/);
  });
  it("says so when the daemon step skipped", async () => {
    const l = summary(await load(), false, "linux");
    expect(l).toMatch(/not installed by setup/);
    expect(l).not.toMatch(/pai-daemon/);
  });
});

describe("step 17", () => {
  it("y turns workers on with the built-in anthropic provider and says so", async () => {
    const m = await load();
    expect(await m.stepWorkers(answering("y"))).toEqual({});
    const { workers } = m.readWorkersSection();
    expect(workers.enabled).toBe(true);
    expect(Object.keys(workers.providers)).toEqual([]); // built-in: nothing written, no secrets
    expect(out.join("\n")).toMatch(/Workers on — provider: anthropic/);
    expect(out.join("\n")).toMatch(/anthropic\s+\[built-in\]/);
  });

  it("--yes leaves workers on", async () => {
    const m = await load();
    m.setupOptions.yes = true;
    await m.stepWorkers({} as never);
    expect(m.readWorkersSection().workers.enabled).toBe(true);
  });

  it("n leaves workers off", async () => {
    const m = await load();
    const upd = await m.stepWorkers(answering("n"));
    expect(upd).toEqual({ workers: { enabled: false, providers: {}, classes: {} } });
  });
});
