/**
 * generateSystemdUnit is the systemd-user-unit analogue of the launchd plist:
 * a pure function so the unit's shape (ExecStart, Restart=on-failure) is
 * pinned without touching a real systemd instance.
 */

import { describe, it, expect } from "vitest";
import { generateSystemdUnit } from "./daemon.js";

describe("generateSystemdUnit", () => {
  it("runs the resolved daemon entry via the given node binary with the serve subcommand", () => {
    const unit = generateSystemdUnit("/repo/dist/daemon/index.mjs", "/usr/bin/node");
    expect(unit).toContain("ExecStart=/usr/bin/node /repo/dist/daemon/index.mjs serve");
  });

  it("restarts on failure so it behaves like the launchd KeepAlive plist", () => {
    const unit = generateSystemdUnit("/repo/dist/daemon/index.mjs", "/usr/bin/node");
    expect(unit).toContain("Restart=on-failure");
  });

  it("is a user-scoped unit wanted by the default target", () => {
    const unit = generateSystemdUnit("/repo/dist/daemon/index.mjs", "/usr/bin/node");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });
});
