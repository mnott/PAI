import { test, expect } from "vitest";
import { scriptWritesRepoCode } from "./orchestrator-script-writes.js";

// Helper to create a stub readFile function
const makeReadFile = (contents: Record<string, string>) => (path: string) => contents[path] ?? null;

test("deny cases", () => {
  // python3 -c "open('src/a.ts','w').write('x')"
  expect(scriptWritesRepoCode("python3 -c \"open('src/a.ts','w').write('x')\"")).toBe(true);

  // python3 -c "from pathlib import Path; Path('src/a.ts').write_text('x')"
  expect(scriptWritesRepoCode("python3 -c \"from pathlib import Path; Path('src/a.ts').write_text('x')\"")).toBe(true);

  // node -e "require('fs').writeFileSync('src/a.ts','x')"
  expect(scriptWritesRepoCode("node -e \"require('fs').writeFileSync('src/a.ts','x')\"")).toBe(true);

  // ruby -e "File.write('src/a.rb','x')"
  expect(scriptWritesRepoCode("ruby -e \"File.write('src/a.rb','x')\"")).toBe(true);

  // python3 /tmp/edit.py where the stub returns text with open('src/x.ts','w')
  const readFileWithWrite = makeReadFile({ "/tmp/edit.py": "open('src/x.ts','w')" });
  expect(scriptWritesRepoCode("python3 /tmp/edit.py", readFileWithWrite)).toBe(true);

  // cd x && python3 /tmp/e.py
  expect(scriptWritesRepoCode("cd x && python3 /tmp/e.py", readFileWithWrite)).toBe(true);
});

test("allow cases", () => {
  // python3 -c "open('/tmp/x.txt','w').write('x')"
  expect(scriptWritesRepoCode("python3 -c \"open('/tmp/x.txt','w').write('x')\"")).toBe(false);

  // node -e "require('fs').writeFileSync('.pai-scratch/a.js','x')"
  expect(scriptWritesRepoCode("node -e \"require('fs').writeFileSync('.pai-scratch/a.js','x')\"")).toBe(false);

  // python3 -c "open('Notes/log.md','a').write('x')"
  expect(scriptWritesRepoCode("python3 -c \"open('Notes/log.md','a').write('x')\"")).toBe(false);

  // python3 -c "print(1)"
  expect(scriptWritesRepoCode("python3 -c \"print(1)\"")).toBe(false);

  // node scripts/build-hooks.mjs
  expect(scriptWritesRepoCode("node scripts/build-hooks.mjs")).toBe(false);

  // python3 /tmp/ro.py (stub returns text without write)
  const readFileWithoutWrite = makeReadFile({ "/tmp/ro.py": "print('hello')" });
  expect(scriptWritesRepoCode("python3 /tmp/ro.py", readFileWithoutWrite)).toBe(false);

  // python3 /tmp/e.py when stub returns write call but only /tmp paths
  const readFileWithTmpWrite = makeReadFile({ "/tmp/e.py": "open('/tmp/x.txt','w')" });
  expect(scriptWritesRepoCode("python3 /tmp/e.py", readFileWithTmpWrite)).toBe(false);

  // ls src
  expect(scriptWritesRepoCode("ls src")).toBe(false);
});