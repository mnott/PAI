import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRules } from "../../router/tool-call-rules.js";
import type { ProbeAnswer } from "../../router/tool-call-rules-ops.js";
import { runRules, type RulesDeps } from "./models-rules.js";

const mk = (extra: Partial<RulesDeps> = {}): RulesDeps => ({ home: mkdtempSync(join(tmpdir(), "mr-")), cfg: undefined, staleDays: 14, ...extra });

describe("pai models rules list / test", () => {
  it("list shows every shipped rule with hits, last hit and stale", async () => {
    const d = mk();
    mkdirSync(join(d.home, "logs"));
    writeFileSync(join(d.home, "logs", "h.json"), JSON.stringify({ "close-parameter": { hits: 7, last_hit: "2026-10-24T10:00:00Z" } }));
    const r = await runRules("list", {}, { ...d, hitsFile: join(d.home, "logs", "h.json"), now: new Date("2026-10-26T00:00:00Z") });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/close-parameter\s+closer\s+active\s+7\s+2026-10-24T10:00:00Z/);
    expect(r.text).toMatch(/junk-lone-gt\s+junk_line\s+active\s+0\s+-/);
    const late = await runRules("list", { json: true }, { ...d, hitsFile: join(d.home, "logs", "h.json"), now: new Date("2026-12-01T00:00:00Z") });
    const rows = JSON.parse(late.text).rules as Array<{ id: string; stale: boolean }>;
    expect(rows.every((x) => x.stale)).toBe(true);
  });

  it("test passes on the shipped file and reports a redundant rule", async () => {
    const d = mk();
    expect((await runRules("test", {}, d)).ok).toBe(true);
    const f = join(d.home, "mine.yaml");
    writeFileSync(
      f,
      `version: 1\ninherits: default\nrules:\n  - id: dup-bool\n    kind: bool_true\n    pattern: '^(?:true|True)$'\n    added: 2026-10-25\n    example: { tool: Grep, input: { pattern: x, "-n": "True" } }\n    expect: { pattern: x, "-n": true }\n`
    );
    const r = await runRules("test", { from: f }, d);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/dup-bool\s+redundant/);
    writeFileSync(f, `version: 1\ninherits: default\nrules:\n  - id: wrong\n    kind: bool_true\n    pattern: '^zzz$'\n    added: 2026-10-25\n    example: { tool: Grep, input: { pattern: x, "-n": "zzz" } }\n    expect: { pattern: x, "-n": false }\n`);
    expect((await runRules("test", { from: f }, d)).text).toMatch(/wrong\s+fail/);
  });

  it("reload validates the files, touches the marker, and reports a bad file", async () => {
    const d = mk();
    const dir = join(d.home, "tool-call-rules");
    mkdirSync(dir);
    writeFileSync(join(dir, "good.yaml"), "version: 1\nrules: []\n");
    const ok = await runRules("reload", {}, d);
    expect(ok.ok).toBe(true);
    expect(existsSync(join(dir, ".reload"))).toBe(true);
    writeFileSync(join(dir, "bad.yaml"), "version: 1\nrules:\n  - {id: b, kind: junk_line, pattern: '([x', added: 2026-10-25}\n");
    const bad = await runRules("reload", {}, d);
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/BAD.*rule b: bad regex/);
    expect(statSync(join(dir, ".reload")).mtimeMs).toBeGreaterThan(0);
  });
});

describe("pai models rules probe (stubbed provider)", () => {
  const answer = (content: object[]): ProbeAnswer => ({ status: 200, body: { content } });

  it("reports fired / never fired per rule, writes the adapted file and the CANDIDATES", async () => {
    const d = mk();
    const sent: Array<Record<string, unknown>> = [];
    const send = () => async (body: Record<string, unknown>): Promise<ProbeAnswer> => {
      sent.push(body);
      const prompt = String(((body.messages as Array<{ content: string }>)[0] ?? {}).content);
      // the swallowed-parameter form for the open-parameter-eq probe, a form no rule knows for the open-eq-only probe, clean calls otherwise
      if (/TODO, with line numbers/.test(prompt)) return answer([{ type: "tool_use", id: "t", name: "Grep", input: { pattern: "TODO", "-n": "true\n</parameter\n<parameter=-C>\n15" } }]);
      if (/files_with_matches/.test(prompt)) return answer([{ type: "tool_use", id: "t", name: "Grep", input: { pattern: "pruneDist", output_mode: "files_with_matches ⟦weird⟧ </arguments>" } }]);
      return answer([{ type: "tool_use", id: "t", name: "Grep", input: { pattern: "x" } }]);
    };
    const out = join(d.home, "adapted.yaml");
    const r = await runRules("probe", { provider: "strata", rounds: 2, out }, { ...d, send });
    expect(r.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(2);
    expect(r.text).toMatch(/open-parameter-eq\s+fired\s+2\/2/);
    expect(r.text).toMatch(/open-eq-only\s+never-fired\s+0\/2/);
    expect(r.text).toMatch(/close-bare-lt\s+no-probe\s+-/);
    const adapted = loadRules(out);
    const by = Object.fromEntries(adapted.rules.map((x) => [x.id, x]));
    expect(by["open-parameter-eq"].unconfirmed).toBeUndefined();
    expect(by["open-eq-only"].unconfirmed).toBe(true);
    expect(by["close-bare-lt"].unconfirmed).toBeUndefined(); // no probe: not judged
    expect(adapted.rules.length).toBe(loadRules(join(__dirname, "../../config/defaults/tool-call-rules.default.yaml")).rules.length);
    const cands = readFileSync(`${out}.CANDIDATES`, "utf8");
    expect(cands).toMatch(/markup left in a value/);
    expect(cands).toMatch(/files_with_matches ⟦weird⟧ <\/arguments>/);
  });

  it("a failing provider is a candidate, not a crash; probe without --provider is a usage error", async () => {
    const d = mk();
    const out = join(d.home, "a.yaml");
    const r = await runRules("probe", { provider: "p", rounds: 1, out }, { ...d, send: () => async () => ({ status: 500, body: {} }) });
    expect(r.ok).toBe(true);
    expect(readFileSync(`${out}.CANDIDATES`, "utf8")).toMatch(/status 500/);
    await expect(runRules("probe", {}, d)).rejects.toThrow(/usage/);
    await expect(runRules("nope", {}, d)).rejects.toThrow(/usage/);
  });
});
