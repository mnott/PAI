import { emptyLoopState, stepLoopGuard, recordLoopResult, callKey } from "./src/hooks/ts/lib/loop-guard.ts";
const input = { file_path: "/tmp/verify_all.py", content: "print(1)\n" };
let s = emptyLoopState();
for (let i = 0; i < 7; i++) {
  const r = stepLoopGuard(s, "Write", input, "fp");
  s = r.state;
  console.log(i, "deny=", r.deny, "window=", JSON.stringify(s.window), "outs=", JSON.stringify(s.outs));
  if (!r.deny) { s = recordLoopResult(s, "Write", input, "ok"); console.log("   after record: window=", JSON.stringify(s.window), "outs=", JSON.stringify(s.outs)); }
}
