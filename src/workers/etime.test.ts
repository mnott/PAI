/**
 * Table test over the forms `ps -o etime=` prints, for the one parseEtime. The copies in
 * builds/reap.ts, workers/reaper.ts and daemon/leftovers.ts drifted apart on these inputs
 * ("4" read 0, junk read 0, "1-02:03:04" was only matched by some); the survivor takes the
 * union of what they all accepted and is NaN on anything they all refused.
 */

import { describe, expect, it } from "vitest";
import { parseEtime } from "./proc-start.js";

const DAY = 86_400;

describe("parseEtime", () => {
  it.each([
    // [ps etime form, seconds]
    ["00:05", 5],
    ["02:05", 125],
    ["01:02", 62],
    [" 01:02:03", 3723],
    ["1-02:03:04", DAY + 2 * 3600 + 3 * 60 + 4],
    ["2-03:04:05", 2 * DAY + 3 * 3600 + 4 * 60 + 5],
    ["10-00:00:00", 10 * DAY],
    ["4-02:10:05", 4 * DAY + 2 * 3600 + 10 * 60 + 5],
    ["00:30", 30],
    ["03:00:00", 10800],
    // a day part with no hour field: the old reap.ts copy read it, the regex copies refused it; the survivor takes the union
    ["1-02:03", 86_400 + 2 * 60 + 3],
  ])("%s", (v, secs) => expect(parseEtime(v)).toBe(secs));

  it("is NaN on the forms ps never prints", () => {
    for (const v of ["junk", "", "4", "1:2:3:4", "abc:def"]) expect(Number.isNaN(parseEtime(v))).toBe(true);
  });
});
