// Probe: what does APFS store for saveStatus-style atomic rewrites?
import { mkdtempSync, writeFileSync, renameSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ns-probe-"));
const final = join(dir, "x.status");

const ident = (p: string) => {
  const st = statSync(p, { bigint: true });
  return `mtimeNs=${st.mtimeNs} ctimeNs=${st.ctimeNs} ino=${st.ino}`;
};

writeFileSync(final, "A".repeat(10));
console.log("first   ", ident(final));
for (let i = 0; i < 3; i++) {
  const tmp = join(dir, `t${i}.tmp`);
  writeFileSync(tmp, "B".repeat(10));
  renameSync(tmp, final);
  console.log(`rename${i}`, ident(final));
}
// in-place rewrite, same size
writeFileSync(final, "C".repeat(10));
console.log("inplace ", ident(final));
rmSync(dir, { recursive: true, force: true });
