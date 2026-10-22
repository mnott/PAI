import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Every relative specifier in a built module, resolved to an absolute path. */
export function importsOf(file) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  // `from "./x.mjs"`, `import "./x.mjs"`, and dynamic `import("./x.mjs")`.
  const re = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(resolve(dirname(file), m[1]));
  return out;
}

/** Transitive imports of the given entry files (absolute paths), entries included. Missing files are skipped. */
export function reachableFrom(entries) {
  const reachable = new Set();
  for (const entry of entries) {
    if (!existsSync(entry)) continue;
    const stack = [entry];
    while (stack.length > 0) {
      const f = stack.pop();
      if (reachable.has(f)) continue;
      reachable.add(f);
      for (const dep of importsOf(f)) if (!reachable.has(dep) && existsSync(dep)) stack.push(dep);
    }
  }
  return reachable;
}
