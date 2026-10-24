import { describe, it, expect } from "vitest";
import { WIN_SYSTEM_JS } from "./cockpit-page/win/cards-system.js";

describe("system cards registry (source level, no browser)", () => {
  it("registers the battery, charger, power-in, battery-w, gpu-freq and mem-pressure cards", () => {
    const names = [...WIN_SYSTEM_JS.matchAll(/\["([a-z-]+)","[^"]+","[^"]+"\]/g)].map((m) => m[1]);
    for (const n of ["battery", "charger", "power-in", "battery-w", "gpu-freq", "mem-pressure"]) expect(names).toContain(n);
    expect(WIN_SYSTEM_JS).toContain('SYS_DEFAULT_EXTRA=["battery","charger","power-in"]');
    expect(WIN_SYSTEM_JS).toContain("no reading");
  });
  it("parses as script", () => {
    expect(() => new Function(WIN_SYSTEM_JS)).not.toThrow();
  });
});
