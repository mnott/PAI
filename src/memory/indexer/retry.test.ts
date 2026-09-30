import { describe, it, expect, vi } from "vitest";
import { retryTransient, isTransientError, TransientError } from "./retry.js";

describe("isTransientError", () => {
  it("detects connection errors", () => {
    expect(isTransientError(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("detects timeout errors", () => {
    expect(isTransientError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isTransientError(new Error("pool connect timeout"))).toBe(true);
  });

  it("detects connection terminated", () => {
    expect(isTransientError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("detects Postgres errors", () => {
    expect(isTransientError(new Error("ERROR: 57P01 admin shutdown"))).toBe(true);
    expect(isTransientError(new Error("ERROR: 40001 serialization failure"))).toBe(true);
    expect(isTransientError(new Error("ERROR: 40P01 deadlock detected"))).toBe(true);
  });

  it("rejects non-transient errors", () => {
    expect(isTransientError(new Error("Syntax error in SQL statement"))).toBe(false);
    expect(isTransientError(new Error("Table not found"))).toBe(false);
    expect(isTransientError(new Error("Column does not exist"))).toBe(false);
  });
});

describe("retryTransient", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn(async () => "result");
    const result = await retryTransient(fn);

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries 3 transient errors then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Connection timeout"))
      .mockRejectedValueOnce(new Error("Connection terminated"))
      .mockRejectedValueOnce(new Error("pool connect timeout"))
      .mockResolvedValueOnce("success");

    const result = await retryTransient(fn, {
      initialDelayMs: 1,
      maxDelayMs: 1,
      logger: vi.fn(), // silence logs
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("fails fast on non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Syntax error in SQL"));
    const logger = vi.fn();

    await expect(retryTransient(fn, { logger })).rejects.toThrow("Syntax error in SQL");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger).not.toHaveBeenCalled();
  });

  it("exhausts retry budget and fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Connection timeout"));
    const logger = vi.fn();

    await expect(
      retryTransient(fn, {
        initialDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 10, // 10ms budget
        logger,
      })
    ).rejects.toThrow("retry budget exhausted");

    // Should have attempted multiple times before budget ran out
    expect(fn.mock.calls.length).toBeGreaterThan(1);
    expect(logger.mock.calls.length).toBeGreaterThan(0);
  });

  it("logs retry attempts with correct details", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Connection timeout"))
      .mockResolvedValueOnce("ok");
    const logger = vi.fn();

    await retryTransient(fn, {
      initialDelayMs: 1,
      maxDelayMs: 100,
      logger,
    });

    expect(logger).toHaveBeenCalledWith(
      1, // attempt number
      1, // delay in ms (capped to budget)
      expect.objectContaining({ message: "Connection timeout" })
    );
  });

  it("handles postgres error codes", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ERROR: 40001 serialization failure"))
      .mockResolvedValueOnce("ok");
    const logger = vi.fn();

    const result = await retryTransient(fn, {
      initialDelayMs: 1,
      logger,
    });

    expect(result).toBe("ok");
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("doubles backoff exponentially", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Connection timeout"))
      .mockRejectedValueOnce(new Error("Connection timeout"))
      .mockResolvedValueOnce("ok");
    const logger = vi.fn();

    await retryTransient(fn, {
      initialDelayMs: 2,
      maxDelayMs: 1000,
      logger,
    });

    const calls = logger.mock.calls;
    expect(calls[0][1]).toBe(2); // First delay: 2ms
    expect(calls[1][1]).toBe(4); // Second delay: 4ms (doubled)
  });

  it("caps backoff at maxDelayMs", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 5) {
        throw new Error("Connection timeout");
      }
      return "ok";
    });
    const logger = vi.fn();

    await retryTransient(fn, {
      initialDelayMs: 2,
      maxDelayMs: 10,
      logger,
    });

    const delays = logger.mock.calls.map((c) => c[1] as number);
    // Should cap at 10ms
    expect(Math.max(...delays)).toBeLessThanOrEqual(10);
  });
});
