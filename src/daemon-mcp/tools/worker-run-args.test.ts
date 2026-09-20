/**
 * Tests for worker_run's input schema and prompt resolution — extracted from
 * daemon-mcp/index.ts so they are testable without starting the shim's
 * stdio transport (see worker-run-args.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveWorkerRunPrompt, workerRunShape } from "./worker-run-args.js";

const schema = z.object(workerRunShape);

describe("worker_run schema: label", () => {
  it("rejects a call with no label", () => {
    const r = schema.safeParse({ prompt: "do it" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty label", () => {
    const r = schema.safeParse({ prompt: "do it", label: "" });
    expect(r.success).toBe(false);
  });

  it("accepts a call with prompt + label", () => {
    const r = schema.safeParse({ prompt: "do it", label: "the goal" });
    expect(r.success).toBe(true);
  });

  it("accepts specPath in place of prompt", () => {
    const r = schema.safeParse({ specPath: "/tmp/spec.txt", label: "the goal" });
    expect(r.success).toBe(true);
  });

  it("accepts an optional capability, any string", () => {
    const r = schema.safeParse({ prompt: "a red circle", label: "paint", capability: "image" });
    expect(r.success).toBe(true);
  });
});

describe("resolveWorkerRunPrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-mcp-worker-run-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses prompt directly when specPath is absent", () => {
    const r = resolveWorkerRunPrompt({ prompt: "do it" }, dir);
    expect(r).toEqual({ promptText: "do it" });
  });

  it("reads the spec file and resolves its path when specPath is given", () => {
    const path = join(dir, "spec.txt");
    writeFileSync(path, "the full spec\n", "utf8");
    const r = resolveWorkerRunPrompt({ specPath: "spec.txt" }, dir);
    expect(r.promptText).toBe("the full spec\n");
    expect(r.specPath).toBe(path);
  });

  it("throws when both prompt and specPath are given", () => {
    expect(() => resolveWorkerRunPrompt({ prompt: "x", specPath: "spec.txt" }, dir)).toThrow(
      "mutually exclusive"
    );
  });

  it("throws when neither prompt nor specPath is given", () => {
    expect(() => resolveWorkerRunPrompt({}, dir)).toThrow("mutually exclusive");
  });
});
