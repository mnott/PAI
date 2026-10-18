// Child process fixture for exit.test.ts: writes N bytes then awaits drainStdio at top level.
import { drainStdio } from "./exit.ts";

const n = Number(process.argv[2]);
process.stdout.write("x".repeat(n - 1) + "\n");
await drainStdio();
