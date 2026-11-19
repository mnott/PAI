/**
 * run/fake-claude.mjs — the mocked claude of start.test.ts: reads the prompt
 * line on stdin, replays the scripted stream-json events (FAKE_EVENTS) on
 * stdout, exits with FAKE_EXIT. A plain .mjs so running it never loads vitest.
 */
let input = "";
process.stdin.on("data", (d) => (input += d.toString()));
// claude answers when the prompt arrives, not when stdin closes: replay on the
// first line and exit right away — like a real one-shot claude. (The run's
// armStdinClose ends stdin ~20 s after the result anyway; waiting for it would
// make every start take 20 s.)
process.stdin.on("data", function first() {
  process.stdin.off("data", first);
  for (const e of JSON.parse(process.env.FAKE_EVENTS ?? "[]")) process.stdout.write(JSON.stringify(e) + "\n");
  setTimeout(() => process.exit(Number(process.env.FAKE_EXIT ?? "0")), 10).unref();
});
void input;
