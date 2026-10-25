import { describe, expect, it } from "vitest";
import { timedTask } from "./slow-task.js";

describe("timedTask", () => {
  it("logs SLOW-TASK with name and duration when over budget, sync and async", async () => {
    const lines: string[] = [];
    let t = 0;
    const clock = () => (t += 80);
    expect(timedTask("x", () => 7, 50, (l) => lines.push(l), clock)).toBe(7);
    await timedTask("y", async () => 1, 50, (l) => lines.push(l), clock);
    expect(lines[0]).toMatch(/SLOW-TASK x 80ms/);
    expect(lines[1]).toMatch(/SLOW-TASK y 80ms/);
  });
  it("stays quiet within budget and still logs when the task throws", () => {
    const lines: string[] = [];
    let t = 0;
    timedTask("fast", () => 1, 50, (l) => lines.push(l), () => (t += 10));
    expect(lines).toEqual([]);
    expect(() => timedTask("boom", () => { throw new Error("e"); }, 50, (l) => lines.push(l), () => (t += 100))).toThrow("e");
    expect(lines[0]).toMatch(/SLOW-TASK boom/);
  });
});
