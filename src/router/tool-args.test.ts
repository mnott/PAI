import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_TOOL_SCHEMAS, claudeCodeToolsArray } from "./tool-args-schemas.js";
import { declaredToolSchemas, parseToolCallText, repairJsonReplyArgs, repairToolInput, ToolArgsSse } from "./tool-args.js";
import { activeRules, loadRules, shippedRulesPath } from "./tool-call-rules.js";

const rules = activeRules(loadRules(shippedRulesPath()));
const schemas = declaredToolSchemas(JSON.stringify({ tools: claudeCodeToolsArray() }));
const fix = (tool: string, input: Record<string, unknown>) => repairToolInput(input, CLAUDE_CODE_TOOL_SCHEMAS[tool], rules);
const P = "/repo/prune-dist-rerun/scripts/prune-dist.mjs";

// emitted_tool_calls arguments from the Strata raw logs (paths shortened) and what the model meant
describe("repairToolInput: forms seen in the Strata raw logs", () => {
  const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>, string[]]> = [
    ["a value that swallowed the next parameter (-n/-C)", "Grep", { "-n": "true\n</parameter\n<parameter=-C>\n15", output_mode: "content", pattern: "workersYamlDataOf", path: P }, { "-n": true, "-C": 15, output_mode: "content", pattern: "workersYamlDataOf", path: P }, ["open-parameter-eq", "close-parameter", "bool-true"]],
    ["swallowed parameter, junk between", "Grep", { "-n": "true\n</parameter\n</end_of_turn>\n<parameter=head_limit>\n60", pattern: "x" }, { "-n": true, head_limit: 60, pattern: "x" }, ["open-parameter-eq", "close-parameter", "bool-true"]],
    ["swallowed output_mode after </parameter", "Grep", { "-n": "true\n</parameter\n<parameter=output_mode>\ncontent", pattern: "x" }, { "-n": true, output_mode: "content", pattern: "x" }, ["open-parameter-eq"]],
    ["swallowed -n after </head> (junk closer, then opener)", "Grep", { "-n": "true\n</parameter>\n</head>\n<parameter=path>\n/repo/gate.ts", pattern: "x" }, { "-n": true, path: "/repo/gate.ts", pattern: "x" }, ["open-parameter-eq"]],
    ["junk tail after </parameter></end_parameter></invoke>…", "Grep", { pattern: "pruneDist|prune-dist", path: "/repo", output_mode: "files_with_matches\n</parameter>\n</end_parameter>\n</invoke>\n</invoke>\n</invoke\n" }, { pattern: "pruneDist|prune-dist", path: "/repo", output_mode: "files_with_matches" }, ["close-parameter"]],
    ["tail \\n</parameter>\\n<", "Grep", { pattern: "effectiveMainConfig", path: "/repo/src", output_mode: "content\n</parameter>\n<" }, { pattern: "effectiveMainConfig", path: "/repo/src", output_mode: "content" }, ["close-parameter"]],
    ["timeout as string with </parameter>", "Bash", { command: "ps -eo lstart=", description: "Count ps lines", timeout: "60000\n</parameter>" }, { command: "ps -eo lstart=", description: "Count ps lines", timeout: 60000 }, ["close-parameter", "coerce:number"]],
    ["timeout with </parameter> and </", "Bash", { command: "npx vitest run", description: "Run tests", timeout: "120000\n</parameter>\n</" }, { command: "npx vitest run", description: "Run tests", timeout: 120000 }, ["close-parameter"]],
    ["True capitalised with junk closers", "Grep", { pattern: "WORKER_CONFIG_COMMANDS", output_mode: "content", "-n": "True\n</parameter>\n</output_mode>\n</output>" }, { pattern: "WORKER_CONFIG_COMMANDS", output_mode: "content", "-n": true }, ["bool-true"]],
    ["number behind a stray >", "Grep", { pattern: "identify the build", path: P, output_mode: "content", "-C": ">\n2" }, { pattern: "identify the build", path: P, output_mode: "content", "-C": 2 }, ["junk-lone-gt"]],
    ["<=NAME> opener", "Grep", { pattern: "pruneDist|prune-dist\n</parameter>\n<=output_mode>\nfiles_with_matches\n</parameter>\n</head_after>\n" }, { pattern: "pruneDist|prune-dist", output_mode: "files_with_matches" }, ["open-eq-only"]],
    ["</=-n> opener", "Grep", { pattern: "resolveSessionArg", path: "/repo/c.ts", output_mode: "content\n</parameter>\n</=-n>\ntrue" }, { pattern: "resolveSessionArg", path: "/repo/c.ts", output_mode: "content", "-n": true }, ["open-slash-eq"]],
    ["<parameter name=\"path\"> opener across a newline", "Grep", { pattern: "pruneDist|prune-dist\n</parameter>\n<\nparameter name=\"path\">/repo/prune-dist-rerun" }, { pattern: "pruneDist|prune-dist", path: "/repo/prune-dist-rerun" }, ["open-parameter-name-attr"]],
    ["<⏎description> opener and a run of </ > junk", "Bash", { command: "sed -n 120,135p src/config/defaults/workers.yaml\n</parameter>\n<\n</\n>\n</parameter>\n<\ndescription>\nRe\n</\n>\n</\n</\n>\n</\n>\n</\n>\n</\n>\n</\n>\n" }, { command: "sed -n 120,135p src/config/defaults/workers.yaml", description: "Re" }, ["open-lt-newline-name"]],
    ["description closed with </⏎description", "Bash", { command: "ls -la x.ts", description: "Verify test file location\n</parameter>\n</\ndescription" }, { command: "ls -la x.ts", description: "Verify test file location" }, ["close-parameter"]],
    ["self-opener at the start of command", "Bash", { command: "<parameter=command>\ngrep -rln \"pruneDist\" scripts/ 2>/dev/null; ls scripts/\n</parameter>", description: "List scripts dir" }, { command: "grep -rln \"pruneDist\" scripts/ 2>/dev/null; ls scripts/", description: "List scripts dir" }, ["open-parameter-eq", "close-parameter"]],
    ["file_path with </parameter>\\n<=", "Read", { file_path: "/repo/prune-dist.mjs\n</parameter>\n<=" }, { file_path: "/repo/prune-dist.mjs" }, ["close-parameter"]],
    ["glob with </end_of_turn>", "Grep", { pattern: "salvaged", output_mode: "content", "-n": true, glob: "*.ts\n</parameter>\n</end_of_turn>" }, { pattern: "salvaged", output_mode: "content", "-n": true, glob: "*.ts" }, ["close-parameter"]],
    ["new_string ending in </parameter></max_attempts></invoke>", "Edit", { file_path: "/repo/a.mjs", old_string: "const a = 1;", new_string: "const a = now();\n</parameter>\n</max_attempts>\n</invoke>" }, { file_path: "/repo/a.mjs", old_string: "const a = 1;", new_string: "const a = now();" }, ["close-parameter"]],
    ["parameter name that swallowed markup", "Bash", { "command </parameter": "ls", description: "x" }, { command: "ls", description: "x" }, ["name-cut-markup"]],
    ["undeclared name cut at markup is dropped", "Bash", { command: "ls", "bogus </parameter": "x" }, { command: "ls" }, ["name-cut-markup"]],
    ["timeout string, no markup", "Bash", { command: "ls", timeout: "120000" }, { command: "ls", timeout: 120000 }, ["coerce:number"]],
    ["boolean spellings", "Edit", { file_path: "/a", old_string: "a", new_string: "b", replace_all: "False" }, { file_path: "/a", old_string: "a", new_string: "b", replace_all: false }, ["bool-false"]],
  ];
  for (const [name, tool, input, expected, ids] of cases) {
    it(name, () => {
      const r = fix(tool, input);
      expect(r.input).toEqual(expected);
      for (const id of ids) expect(r.hits).toContain(id);
    });
  }
});

describe("repairToolInput: nothing without a rule hit", () => {
  it("returns the very same input object for clean calls", () => {
    const input = { command: "echo hi", timeout: 5000, run_in_background: false };
    const r = fix("Bash", input);
    expect(r.input).toBe(input);
    expect(r.hits).toEqual([]);
  });
  it("a string number for a string parameter, and file content, stay verbatim", () => {
    const content = "<div>\n  <p>hi</p>\n</div>\n>\n";
    const input = { file_path: "/a.html", content };
    expect(fix("Write", input).input).toBe(input);
    expect(fix("Bash", { command: "true" }).input).toEqual({ command: "true" });
  });
  it("a Write whose content mentions another parameter's opener only splits for declared, unset names", () => {
    const input = { file_path: "/a.md", content: "use <parameter=bogus>\nvalue" };
    expect(fix("Write", input).input).toBe(input);
  });
  it("does not split into a parameter that is already set", () => {
    const input = { "-n": "true\n</parameter>\n<parameter=pattern>\nother", pattern: "real" };
    expect(fix("Grep", input).input).toEqual({ "-n": true, pattern: "real" });
  });
  it("without a schema the input is untouched", () => {
    const input = { x: "1\n</parameter>" };
    expect(repairToolInput(input, undefined, rules).input).toBe(input);
  });
  it("disabled rules do not fire", () => {
    const off = activeRules({ ...loadRules(shippedRulesPath()), rules: loadRules(shippedRulesPath()).rules.map((r) => ({ ...r, disabled: r.id === "close-parameter" || r.disabled })) });
    expect(repairToolInput({ command: "ls", timeout: "5\n</parameter>" }, CLAUDE_CODE_TOOL_SCHEMAS.Bash, off).input.timeout).toBe("5\n</parameter>");
  });
});

describe("parseToolCallText: markup an engine left as text", () => {
  const parse = (t: string) => parseToolCallText(t, schemas, rules);
  it("the canonical form", () => {
    const r = parse("I'll look.\n\n<tool_call>\n<function=Bash>\n<parameter=command>\nls -la\n</parameter>\n<parameter=description>\nList\n</parameter>\n</function>\n</tool_call><|im_end|>");
    expect(r?.before).toBe("I'll look.");
    expect(r?.calls).toMatchObject([{ name: "Bash", input: { command: "ls -la", description: "List" } }]);
  });
  it("typed values, False, and a bare <Read> tool tag", () => {
    const r = parse("<tool_call>\n<Read>\n<parameter=file_path>\n/a.ts\n</parameter>\n<offset>\n1\n</parameter>\n<limit>\n20\n</parameter>\n</function>\n</tool_call>");
    expect(r?.calls[0]).toMatchObject({ name: "Read", input: { file_path: "/a.ts", offset: 1, limit: 20 } });
    const e = parse("<tool_call>\n<function=Edit>\n<parameter=replace_all>\nFalse\n</parameter>\n<parameter=file_path>\n/a\n</parameter>\n<old_string>\nx\n</parameter>\n<parameter=new_string>\ny\n</parameter>\n</function>\n</tool_call><|im_end|>");
    expect(e?.calls[0].input).toEqual({ replace_all: false, file_path: "/a", old_string: "x", new_string: "y" });
  });
  it("a stub opener <file_path> and a bare stub before the real opener", () => {
    expect(parse("<tool_call>\n<function=Read>\n<file_path>\n/a/b.mjs\n</parameter>\n</function>\n</tool_call><|im_end|>")?.calls[0].input).toEqual({ file_path: "/a/b.mjs" });
    expect(parse("<tool_call>\n<function=Read>\n<file_path\n<parameter=file_path>\n/a/b.mjs\n</parameter>\n</function>\n</tool_call><|im_end|>")?.calls[0].input).toEqual({ file_path: "/a/b.mjs" });
  });
  it("the <=name> and stray > forms", () => {
    const r = parse("<tool_call>\n<function=Grep>\n<parameter=pattern>\nidentify the build\n</parameter>\n<=path>\n/a.mjs\n</parameter>\n<=output_mode>\ncontent\n</parameter>\n<=-C>\n>\n2\n</parameter>\n</function>\n</tool_call><|im_end|>");
    expect(r?.calls[0].input).toEqual({ pattern: "identify the build", path: "/a.mjs", output_mode: "content", "-C": 2 });
  });
  it("the Anthropic invoke form and JSON arguments", () => {
    expect(parse('<function_calls>\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>')?.calls[0]).toMatchObject({ name: "Bash", input: { command: "ls" } });
    expect(parse('<tool_call>\n{"name": "Bash", "arguments": {"command": "ls", "timeout": "5000"}}\n</tool_call>')?.calls[0]).toMatchObject({ name: "Bash", input: { command: "ls", timeout: 5000 } });
    expect(parse("<tool_call>\n<function=Read>\n<arguments>\n{\"file_path\": \"/a\"}\n</arguments>\n</function>\n</tool_call>")?.calls[0].input).toEqual({ file_path: "/a" });
  });
  it("two calls, and a second <tool_call> opened before the first was closed", () => {
    const r = parse("<tool_call>\n<function=Read>\n<parameter=file_path>\n/a\n</parameter>\n<tool_call>\n<function=Read>\n<parameter=file_path>\n/b\n</parameter>\n</function>\n</tool_call>");
    expect(r?.calls.map((c) => c.input.file_path)).toEqual(["/a", "/b"]);
  });
  it("a wrong-case tool name is corrected", () => {
    expect(parse("<tool_call>\n<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>")?.calls[0].name).toBe("Bash");
  });
  it("null when the call cannot be made whole: unknown tool, missing required argument, nothing parsable", () => {
    expect(parse("<tool_call>\n<function=Nope>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>")).toBeNull();
    expect(parse("<tool_call>\n<function=Bash>\n<parameter=description>\nonly this\n</parameter>\n</function>\n</tool_call>")).toBeNull();
    expect(parse("<tool_call>\n<=<|im_end|>")).toBeNull();
    expect(parse("plain answer")).toBeNull();
  });
});

describe("wiring", () => {
  const body = JSON.stringify({ tools: claudeCodeToolsArray() });
  const sse = (events: Array<[string, object]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  const run = async (input: string, chunk = 17): Promise<string> => {
    const t = new ToolArgsSse(declaredToolSchemas(body), () => rules, () => {});
    const parts: string[] = [];
    t.on("data", (c: Buffer) => parts.push(c.toString()));
    for (let i = 0; i < input.length; i += chunk) t.write(input.slice(i, i + chunk));
    t.end();
    await new Promise((r) => t.on("end", r));
    return parts.join("");
  };
  const stream = (json: string[]) =>
    sse([
      ["message_start", { type: "message_start", message: { id: "m" } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Grep", input: {} } }],
      ...json.map((j): [string, object] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: j } }]),
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_stop", { type: "message_stop" }],
    ]);
  const inputOf = (out: string): unknown => {
    const deltas = out.split("\n\n").filter((m) => m.includes("input_json_delta")).map((m) => JSON.parse(m.split("\n").find((l) => l.startsWith("data:"))!.slice(5)).delta.partial_json);
    return JSON.parse(deltas.join(""));
  };

  it("SSE: a split tool_use input is reassembled per block and emitted repaired", async () => {
    const full = JSON.stringify({ "-n": "true\n</parameter\n<parameter=-C>\n15", pattern: "x" });
    const out = await run(stream([full.slice(0, 11), full.slice(11, 30), full.slice(30)]));
    expect(inputOf(out)).toEqual({ "-n": true, "-C": 15, pattern: "x" });
    expect(out.indexOf("content_block_delta")).toBeLessThan(out.indexOf("content_block_stop"));
    expect(out).toContain("message_stop");
  });
  it("SSE: a clean call and unrelated events pass through byte for byte", async () => {
    const text = sse([["message_start", { type: "message_start" }], ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }], ["content_block_stop", { type: "content_block_stop", index: 0 }]]);
    expect(await run(text)).toBe(text);
    const clean = JSON.stringify({ pattern: "x", "-n": true });
    expect(inputOf(await run(stream([clean])))).toEqual({ pattern: "x", "-n": true });
  });
  it("JSON reply: tool_use inputs repaired, other replies unchanged", () => {
    const reply = JSON.stringify({ content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "ls", timeout: "60000\n</parameter>" } }] });
    const logged: string[][] = [];
    const out = JSON.parse(repairJsonReplyArgs(reply, declaredToolSchemas(body), () => rules, (i) => logged.push(i.rules)));
    expect(out.content[1].input).toEqual({ command: "ls", timeout: 60000 });
    expect(logged[0]).toContain("close-parameter");
    const clean = JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] });
    expect(repairJsonReplyArgs(clean, declaredToolSchemas(body), () => rules, () => {})).toBe(clean);
  });
  void Readable;
});
