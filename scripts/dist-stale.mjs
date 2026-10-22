import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest mtime (ms) of any file under dir, recursively; 0 when empty. */
export function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const t = e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

/** True when the built entry is older than the newest file under srcDir. */
export function isDistStale(srcDir, distEntry) {
  return statSync(distEntry).mtimeMs < newestMtime(srcDir);
}
