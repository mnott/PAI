import { describe, it, expect } from "vitest";
import { isWorkerSession } from "./worker-session.js";

describe("isWorkerSession", () => {
  it("is true only for the exact launcher mark PAI_WORKER=1", () => {
    expect(isWorkerSession({ PAI_WORKER: "1" })).toBe(true);
    expect(isWorkerSession({ PAI_WORKER: "true" })).toBe(false);
    expect(isWorkerSession({ PAI_WORKER: "" })).toBe(false);
    expect(isWorkerSession({})).toBe(false);
  });

  it("reads process.env by default", () => {
    const prev = process.env.PAI_WORKER;
    try {
      process.env.PAI_WORKER = "1";
      expect(isWorkerSession()).toBe(true);
      delete process.env.PAI_WORKER;
      expect(isWorkerSession()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PAI_WORKER;
      else process.env.PAI_WORKER = prev;
    }
  });
});
