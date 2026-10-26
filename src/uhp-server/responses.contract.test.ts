import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultWorkersConfig } from "../workers/config.js";
import { createToken } from "./auth.js";
import { createUhpServer } from "./server.js";

// Fake workers: a sleeping process stands in for `pai worker run`; the test writes the status and .jsonl it would.
let dir: string;
let logDir: string;
let base: string;
let closeServer: () => void;
let token: string;
let harness: string;
const sleepers: ChildProcess[] = [];
const spawned: string[][] = [];
const savedHome = process.env.PAI_HOME;

const init = { type: "system", subtype: "init", model: "m" };
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const call = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } };
const out = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } };

function fakeStart(_bin: string, args: string[]): number {
  spawned.push(args);
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  sleepers.push(child);
  return child.pid!;
}

const idOf = (pid: number) => `20260101-000000-${pid}`;
const status = (pid: number, state: string, extra: object = {}) =>
  writeFileSync(join(logDir, `${idOf(pid)}.status`), JSON.stringify({ id: idOf(pid), pid, state, model: "m", claudeSession: "s", rc: state === "done" ? 0 : null, ...extra }));
const lines = (pid: number, ...l: object[]) => appendFileSync(join(logDir, `${idOf(pid)}.jsonl`), l.map((x) => JSON.stringify(x) + "\n").join(""));

const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { ...auth(), ...headers }, body: JSON.stringify(body) });
const get = (path: string) => fetch(base + path, { headers: auth() });
const sse = async (res: Response) =>
  (await res.text()).split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uhp-resp-"));
  process.env.PAI_HOME = join(dir, "home");
  logDir = join(dir, "logs");
  mkdirSync(logDir, { recursive: true });
  const tokensPath = join(dir, "tokens.json");
  token = createToken(tokensPath, "t").token;
  const server = createUhpServer({ tokensPath, loadWorkers: defaultWorkersConfig, probe: async () => true, runs: { logDir, cwd: dir, start: fakeStart } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => server.close();
  harness = (await (await get("/v1/harnesses")).json()).harnesses[0].id;
});

afterAll(() => {
  closeServer();
  for (const c of sleepers) c.kill("SIGKILL");
  if (savedHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

/** Start a response, let the fake worker produce a run, return the pending request and its pid. */
async function started(body: object, headers: Record<string, string> = {}) {
  const before = sleepers.length;
  const pending = post("/v1/responses", { input: "hi", metadata: { harness_id: harness }, ...body }, headers);
  while (sleepers.length === before) await new Promise((r) => setTimeout(r, 20));
  return { pending, pid: sleepers[sleepers.length - 1].pid! };
}

describe("UHP task contract (2026-10-19)", () => {
  it("assembles identical output for stream and non-stream, with gapless sequence numbers and one terminal event", async () => {
    const run = async (stream: boolean) => {
      const { pending, pid } = await started({ stream });
      status(pid, "running");
      lines(pid, init, { type: "assistant", message: { content: [{ type: "thinking", thinking: "hm" }] } }, call, out, text("R\ni=x\nr=+\nz=done"));
      status(pid, "done");
      return pending;
    };
    const events = await sse(await run(true));
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events[0].type).toBe("response.created");
    const terminals = events.filter((e) => /^response\.(completed|incomplete|failed)$/.test(e.type));
    expect(terminals).toHaveLength(1);
    expect(events[events.length - 1]).toBe(terminals[0]);
    const plain = await (await run(false)).json();
    expect(plain.status).toBe("completed");
    expect(terminals[0].response.output).toEqual(plain.output);
    expect(plain.output.map((i: { type: string }) => i.type)).toEqual(["reasoning", "function_call", "function_call_output", "message"]);
    expect(plain.id).toMatch(/^resp_/);
    expect(plain.usage).toBeNull();
    expect(plain.metadata.session_id).toMatch(/^hsess/);
  });

  it("maps the AG2 outcome to the UHP status and names ignored request fields", async () => {
    const { pending, pid } = await started({ tools: [], include: [], bogus: 1 });
    lines(pid, init, text("R\ni=x\nr=~\nz=cut short"));
    status(pid, "done");
    const r = await (await pending).json();
    expect(r.status).toBe("incomplete");
    expect(r.metadata.ignored_fields.sort()).toEqual(["bogus", "include", "tools"]);
    const clean = await started({});
    lines(clean.pid, init, text("R\ni=x\nr=+\nz=ok"));
    status(clean.pid, "done");
    expect((await (await clean.pending).json()).metadata.ignored_fields).toBeUndefined();
  });

  it("returns in_progress for background, runs one worker per Idempotency-Key and refuses a different body", async () => {
    const n = spawned.length;
    const key = { "idempotency-key": "k1" };
    const a = await started({ background: true }, key);
    status(a.pid, "running");
    const first = await (await a.pending).json();
    expect(first.status).toBe("in_progress");
    const second = await (await post("/v1/responses", { input: "hi", metadata: { harness_id: harness }, background: true }, key)).json();
    expect(second.id).toBe(first.id);
    expect(spawned.length).toBe(n + 1);
    const other = await post("/v1/responses", { input: "different", metadata: { harness_id: harness } }, key);
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe("invalid_input");
    expect((await (await get(`/v1/responses/${first.id}`)).json()).status).toBe("in_progress");
  });

  it("answers cancel at once with status cancelled, keeps the output and treats a second cancel as a no-op", async () => {
    const { pending, pid } = await started({ background: true });
    status(pid, "running");
    lines(pid, init, text("partial"));
    const id = (await (await pending).json()).id;
    const t0 = Date.now();
    const c = await (await post(`/v1/responses/${id}/cancel`, {})).json();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.status).toBe("cancelled");
    expect(c.output).toHaveLength(1);
    const again = await (await post(`/v1/responses/${id}/cancel`, {})).json();
    expect(again).toEqual(c);
    expect((await (await get(`/v1/responses/${id}`)).json()).status).toBe("cancelled");
  });

  it("refuses a second task in a running session and a mismatched harness, and 404s unknown ids", async () => {
    const a = await started({ background: true });
    status(a.pid, "running");
    const first = await (await a.pending).json();
    const busy = await post("/v1/responses", { input: "more", previous_response_id: first.id });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("session_busy");
    const mismatch = await post("/v1/responses", { input: "more", previous_response_id: first.id, metadata: { harness_id: "chrn_other" } });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error.code).toBe("harness_mismatch");
    const gone = await post("/v1/responses", { input: "more", previous_response_id: "resp_00" });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error.code).toBe("response_not_found");
    const unknownModel = await post("/v1/responses", { input: "x", model: "no-such-model", metadata: { harness_id: harness } });
    expect(unknownModel.status).toBe(422);
    expect((await unknownModel.json()).error.code).toBe("model_unavailable");
    await post(`/v1/responses/${first.id}/cancel`, {});
  });
});
