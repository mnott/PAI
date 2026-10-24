import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInstances, readLiveInstances, writeInstances } from "./local-instances.js";
import { syncRuntimeInstance, type RuntimeInstanceDeps } from "./runtime-instances.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = (providerUrl?: string): RuntimeInstanceDeps => {
  const dir = mkdtempSync(join(tmpdir(), "rt-inst-"));
  dirs.push(dir);
  return { logDir: dir, home: dir, providerUrl, listenerPid: () => 4242, now: () => 1000 };
};

describe("runtime start/stop keep the managed-instance registry in step", () => {
  it("a successful start writes the runtime's row with the listener pid", () => {
    const d = setup("http://127.0.0.1:8035");
    syncRuntimeInstance("coder-l", "start", true, d);
    const rows = readInstances(d.logDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "coder-l#1", model: "coder-l", provider: "coder-l", url: "http://127.0.0.1:8035", origin: "managed", port: 8035, pid: 4242, state: "ready" });
  });

  it("a failed start writes nothing", () => {
    const d = setup("http://127.0.0.1:8035");
    syncRuntimeInstance("coder-l", "start", false, d);
    expect(readInstances(d.logDir)).toEqual([]);
  });

  it("stop removes the runtime's row and keeps others", () => {
    const d = setup("http://127.0.0.1:8035");
    syncRuntimeInstance("coder-l", "start", true, d);
    syncRuntimeInstance("other", "start", true, { ...d, providerUrl: "http://127.0.0.1:8040" });
    syncRuntimeInstance("coder-l", "stop", true, d);
    expect(readInstances(d.logDir).map((r) => r.id)).toEqual(["other#1"]);
  });

  it("start of runtime B on runtime A's port replaces A's row", () => {
    const d = setup("http://127.0.0.1:8035");
    syncRuntimeInstance("gyro-m", "start", true, d);
    syncRuntimeInstance("coder-l", "start", true, d);
    expect(readInstances(d.logDir).map((r) => r.id)).toEqual(["coder-l#1"]);
  });

  it("a runtime that is no loopback provider is not an endpoint", () => {
    const d = setup(undefined);
    syncRuntimeInstance("ollama", "start", true, d);
    syncRuntimeInstance("remote", "start", true, { ...d, providerUrl: "http://10.0.0.5:8035" });
    expect(readInstances(d.logDir)).toEqual([]);
  });

  it("a stale ready row with no live listener is dropped on read", () => {
    const d = setup("http://127.0.0.1:8035");
    syncRuntimeInstance("coder-l", "start", true, d);
    writeInstances(d.logDir, readInstances(d.logDir).map((r) => ({ ...r, pid: undefined })));
    expect(readLiveInstances(d.logDir, () => true)).toHaveLength(1);
    expect(readLiveInstances(d.logDir, () => false)).toHaveLength(0);
  });
});
