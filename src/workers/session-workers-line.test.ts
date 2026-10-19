import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localModelHint } from "../hooks/ts/lib/local-model-hint.js";

const home = mkdtempSync(join(tmpdir(), "swl-"));
process.env.PAI_CONFIG_FILE = join(home, "config.yaml");
process.env.PAI_WORKERS_YAML = join(home, "workers.yaml");
writeFileSync(
  process.env.PAI_WORKERS_YAML,
  ["active: glm", "providers:", "  glm:", "    url: https://glm.example.invalid", "    models:", "      default: glm-big",
   "  loc1:", "    url: http://127.0.0.1:45992", "    models:", "      default: flash-a", ""].join("\n")
);

const { sessionWorkersLine } = await import("./session-profile.js");
const { SESSION_WORKER_PROVIDER_ENV } = await import("./session-provider.js");

describe("sessionWorkersLine", () => {
  it("names the session's provider, not the global active one", async () => {
    const line = await sessionWorkersLine({ PAI_SESSION_NAME: "s1", [SESSION_WORKER_PROVIDER_ENV]: "loc1" });
    expect(line).toBe("this session's workers: loc1 (setup launch)");
  });

  it("the hint carries the line", () => {
    expect(localModelHint("local model?", "local: x running", "this session's workers: loc1 (setup launch)")).toContain(
      "this session's workers: loc1 (setup launch)\nlocal: x running"
    );
  });
});
