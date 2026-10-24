import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildsDir } from "./builds/queue.js";
import { ensureConfigDir, paiConfigFilePath } from "./daemon/config.js";
import { WhatsAppProvider } from "./notifications/providers/whatsapp.js";
import { paiHomePath } from "./config/pai-home.js";

let root: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["PAI_HOME", "PAI_BUILD_DIR", "PAI_AIBROKER_SOCKET_PATH"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-loc-"));
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("location resolvers", () => {
  it("whatsapp provider connects to the PAI_AIBROKER_SOCKET_PATH hub, not a fixed /tmp path", async () => {
    const sock = join(root, "hub.sock");
    process.env.PAI_AIBROKER_SOCKET_PATH = sock;
    let got = "";
    const server = createServer((c) => {
      c.on("data", (d) => {
        got += d.toString();
        c.end();
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    const cfg = { mode: "text", channels: { whatsapp: { enabled: true }, voice: { enabled: false } } };
    await new WhatsAppProvider().send({ message: "hi" } as never, cfg as never);
    server.close();
    expect(got).toContain("adapter_call");
  });

  it("buildsDir follows paiHomePath, and PAI_BUILD_DIR still overrides", () => {
    process.env.PAI_HOME = root;
    delete process.env.PAI_BUILD_DIR;
    expect(buildsDir()).toBe(paiHomePath("logs", "builds"));
    expect(buildsDir()).toBe(join(root, "logs", "builds"));
    expect(buildsDir({ PAI_BUILD_DIR: "/x/y" })).toBe("/x/y");
  });

  it("generated config template does not pin socketPath", () => {
    // Fresh install: the guard's sandbox config (config.yaml) would make
    // ensureConfigDir skip writing the template. Remove it from the sandbox
    // only, then restore it.
    const file = paiConfigFilePath();
    const yaml = file.replace(/\.json$/, ".yaml");
    const savedYaml = existsSync(yaml) ? readFileSync(yaml, "utf-8") : undefined;
    rmSync(yaml, { force: true });
    rmSync(file, { force: true });
    try {
      ensureConfigDir();
      expect(readFileSync(file, "utf-8")).not.toContain("socketPath");
    } finally {
      if (savedYaml !== undefined) writeFileSync(yaml, savedYaml);
    }
  });
});
