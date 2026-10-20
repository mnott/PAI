import { describe, it, expect } from "vitest";
import { renderTable, makeColor } from "./render.js";
import { nativeAnthropicModels } from "./config.js";
import type { WorkerStatus } from "./status.js";

const workers = { providers: {}, nativeModels: nativeAnthropicModels() };
const row = (model: string | null) =>
  ({
    id: "w1", provider: "anthropic", model, state: "running", started: new Date().toISOString(), updated: new Date().toISOString(), term: "", last: "", rc: null,
    turns: 1, tools: 1, cwd: "/w", label: "x", pid: process.pid,
  }) as unknown as WorkerStatus;
const render = (model: string | null) =>
  renderTable(makeColor(false), [row(model)], "", new Date(), {}, workers);

describe("ps provider tag", () => {
  it("routed row shows the served model", () => {
    expect(render("glm-5.3")).toContain("[anthropic/glm-5.3]");
  });
  it("provider default model stays plain", () => {
    const o = render(nativeAnthropicModels().default);
    expect(o).toContain("[anthropic]");
    expect(o).not.toContain("[anthropic/");
  });
  it("missing model stays plain", () => {
    expect(render(null)).toContain("[anthropic]");
  });
});
