import { describe, it, expect } from "vitest";
import { nodeOnTypeScriptReason, tscFileArgReason, forceAddReason, gitAddPaths } from "./worker-bash-rules.js";

describe("nodeOnTypeScriptReason", () => {
  it("should deny node with .ts file", () => {
    expect(nodeOnTypeScriptReason("node src/app.ts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node with .tsx file", () => {
    expect(nodeOnTypeScriptReason("node src/app.tsx")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node with .mts file", () => {
    expect(nodeOnTypeScriptReason("node src/app.mts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node --test with .ts file", () => {
    expect(nodeOnTypeScriptReason("node --test src/test.ts")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should allow node with .js file", () => {
    expect(nodeOnTypeScriptReason("node src/app.js")).toBeNull();
  });

  it("should allow node with .mjs file", () => {
    expect(nodeOnTypeScriptReason("node src/app.mjs")).toBeNull();
  });

  it("should allow node with no file arguments", () => {
    expect(nodeOnTypeScriptReason("node --version")).toBeNull();
  });

  it("should allow npx tsx", () => {
    expect(nodeOnTypeScriptReason("npx tsx src/app.ts")).toBeNull();
  });

  it("should allow node -e with simple code", () => {
    expect(nodeOnTypeScriptReason("node -e \"console.log(1)\"")).toBeNull();
  });

  it("should deny node -e with require of src", () => {
    expect(nodeOnTypeScriptReason("node -e \"require('./src/app.js')\"")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node -e with import of src", () => {
    expect(nodeOnTypeScriptReason("node -e \"import('./src/app.js')\"")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should deny node -e with from import of src", () => {
    expect(nodeOnTypeScriptReason("node -e \"from './src/app.js'\"")).toBe("node cannot load TypeScript source. Write a vitest test and run `npx vitest run <file>`, or run `npx tsx <file>.ts`.");
  });

  it("should allow node -e with no src import", () => {
    expect(nodeOnTypeScriptReason("node -e \"require('fs')\"")).toBeNull();
  });
});

describe("tscFileArgReason", () => {
  it("should deny tsc with .ts file", () => {
    expect(tscFileArgReason("tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny tsc with .tsx file", () => {
    expect(tscFileArgReason("tsc src/app.tsx")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny tsc with .mts file", () => {
    expect(tscFileArgReason("tsc src/app.mts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should allow tsc with --noEmit", () => {
    expect(tscFileArgReason("tsc --noEmit")).toBeNull();
  });

  it("should allow tsc with -p", () => {
    expect(tscFileArgReason("tsc -p tsconfig.json")).toBeNull();
  });

  it("should allow tsc with --noEmit -p", () => {
    expect(tscFileArgReason("tsc --noEmit -p tsconfig.json")).toBeNull();
  });

  it("should allow tsc with no file arguments", () => {
    expect(tscFileArgReason("tsc")).toBeNull();
  });

  it("should deny npx tsc with .ts file", () => {
    expect(tscFileArgReason("npx tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny npx --no-install tsc with .ts file", () => {
    expect(tscFileArgReason("npx --no-install tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny ./node_modules/.bin/tsc with .ts file", () => {
    expect(tscFileArgReason("./node_modules/.bin/tsc src/app.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });

  it("should deny cd x && npx tsc --noEmit src/a.ts", () => {
    expect(tscFileArgReason("cd x && npx tsc --noEmit src/a.ts")).toBe("tsc with a file argument ignores tsconfig.json; run `npx tsc --noEmit` and grep its output for your file");
  });
});

describe("forceAddReason", () => {
  const isIgnored = (path: string) => path.startsWith("Notes/");

  it("should deny git add -f", () => {
    expect(forceAddReason("git add -f Notes/x.md", isIgnored)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });

  it("should deny git add --force", () => {
    expect(forceAddReason("git add --force Notes/x.md", isIgnored)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });

  it("should deny git add -fA", () => {
    expect(forceAddReason("git add -fA Notes/x.md", isIgnored)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });

  it("should deny git add with ignored path", () => {
    expect(forceAddReason("git add Notes/x.md", isIgnored)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });

  it("should allow git add with non-ignored path", () => {
    expect(forceAddReason("git add src/a.ts", isIgnored)).toBeNull();
  });

  it("should allow git add -A", () => {
    expect(forceAddReason("git add -A", isIgnored)).toBeNull();
  });

  it("should allow git add with no ignored paths", () => {
    expect(forceAddReason("git add src/a.ts src/b.ts", isIgnored)).toBeNull();
  });

  // Test for .pai-scratch paths
  it("should deny git add .pai-scratch/x.ts with isIgnored always false", () => {
    const alwaysFalse = (path: string) => false;
    expect(forceAddReason("git add .pai-scratch/x.ts", alwaysFalse)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });

  it("should deny git add ./.pai-scratch/a/b.ts with isIgnored always false", () => {
    const alwaysFalse = (path: string) => false;
    expect(forceAddReason("git add ./.pai-scratch/a/b.ts", alwaysFalse)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });

  it("should deny git add /w/t/.pai-scratch/c.ts with isIgnored always false", () => {
    const alwaysFalse = (path: string) => false;
    expect(forceAddReason("git add /w/t/.pai-scratch/c.ts", alwaysFalse)).toBe("Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)");
  });
});

describe("gitAddPaths", () => {
  it("should return paths for git add", () => {
    expect(gitAddPaths("git add src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("should return paths for git add with flags", () => {
    expect(gitAddPaths("git add -f src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("should return paths for git add with ignored paths", () => {
    expect(gitAddPaths("git add Notes/x.md src/a.ts")).toEqual(["Notes/x.md", "src/a.ts"]);
  });

  it("should return empty array for git add -A", () => {
    expect(gitAddPaths("git add -A")).toEqual([]);
  });

  it("should return empty array for git add with no paths", () => {
    expect(gitAddPaths("git add")).toEqual([]);
  });

  it("should return paths for cd && git add", () => {
    expect(gitAddPaths("cd x && git add src/a.ts")).toEqual(["src/a.ts"]);
  });
});