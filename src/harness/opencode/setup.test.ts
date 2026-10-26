import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOpenCodeSetup, planOpenCodeSetup } from "./setup.js";

const repo = new URL("../../../", import.meta.url).pathname;
let root: string;
let input: Parameters<typeof planOpenCodeSetup>[0];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-oc-setup-"));
  const home = join(root, "home");
  const pkg = join(root, "pkg");
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "End"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "End", "SKILL.md"), "x");
  writeFileSync(join(home, ".claude", "commands", "pa.md"), "---\ndescription: Pa\n---\nDo pa");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { pai: { command: "node", args: ["/p/index.mjs"] }, other: { command: "o" } } }));
  cpSync(join(repo, "templates", "claude-md.template.md"), join(pkg, "templates", "claude-md.template.md"));
  cpSync(join(repo, "templates", "opencode"), join(pkg, "templates", "opencode"), { recursive: true });
  mkdirSync(join(pkg, "dist", "hooks"), { recursive: true });
  for (const h of ["route-agents-to-worker", "route-edits-to-worker", "block-sleep-poll", "security-validator"]) writeFileSync(join(pkg, "dist", "hooks", `${h}.mjs`), "");
  input = { home, configDir: join(root, "cfg", "opencode"), packageRoot: pkg, stamp: "T1" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("planOpenCodeSetup", () => {
  it("registers only the pai server by default, with the command Claude Code has", () => {
    const plan = planOpenCodeSetup(input);
    expect(plan.mcpServers).toEqual(["pai"]);
    const cfg = JSON.parse(plan.files[0]!.content);
    expect(cfg.mcp.pai).toEqual({ type: "local", command: ["node", "/p/index.mjs"], enabled: true });
    expect(cfg.command.pa).toEqual({ description: "Pa", template: "Do pa" });
    expect(cfg.instructions).toEqual([join(input.configDir, "pai", "AGENTS.md")]);
    expect(plan.skills).toEqual(["End"]);
    expect(planOpenCodeSetup({ ...input, allMcp: true }).mcpServers).toEqual(["pai", "other"]);
  });

  it("renders the instructions file for OpenCode from the shared source", () => {
    const doc = planOpenCodeSetup(input).files[1]!.content;
    expect(doc).toContain("# AGENTS.md - PAI Global Configuration");
    expect(doc).toContain("### Harness: OpenCode");
    expect(doc).not.toContain("### Harness: Claude Code");
  });

  it("points OpenCode's model at the PAI router when asked", () => {
    const cfg = JSON.parse(planOpenCodeSetup({ ...input, routerProvider: { name: "glm", model: "m1", routerBase: "http://r" } }).files[0]!.content);
    expect(cfg.model).toBe("pai/m1");
    expect(cfg.provider.pai.options.baseURL).toBe("http://r/p/glm/v1");
  });

  it("skips a guard whose hook is not built and says so", () => {
    rmSync(join(input.packageRoot, "dist", "hooks", "block-sleep-poll.mjs"));
    const plan = planOpenCodeSetup(input);
    expect(plan.hooks.map((h) => h.hook)).not.toContain("block-sleep-poll");
    expect(plan.warnings.join("\n")).toContain("block-sleep-poll");
  });

  it("refuses an existing opencode.json it cannot parse", () => {
    mkdirSync(input.configDir, { recursive: true });
    writeFileSync(join(input.configDir, "opencode.json"), "{ nope");
    expect(() => planOpenCodeSetup(input)).toThrow(/not valid JSON/);
  });
});

describe("applyOpenCodeSetup", () => {
  it("planning writes nothing; applying writes the three files", () => {
    const plan = planOpenCodeSetup(input);
    expect(existsSync(input.configDir)).toBe(false);
    const { written, backups } = applyOpenCodeSetup(plan, "T1");
    expect(written).toHaveLength(3);
    expect(backups).toEqual([]);
    expect(existsSync(join(input.configDir, "pai", "pai-bridge.mjs"))).toBe(true);
  });

  it("backs up a changed file, keeps the user's keys, and a second run changes nothing", () => {
    mkdirSync(input.configDir, { recursive: true });
    const cfgPath = join(input.configDir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify({ theme: "mine" }));
    const first = applyOpenCodeSetup(planOpenCodeSetup(input), "T1");
    expect(first.backups).toEqual([`${cfgPath}.bak-T1`]);
    expect(JSON.parse(readFileSync(`${cfgPath}.bak-T1`, "utf8"))).toEqual({ theme: "mine" });
    expect(JSON.parse(readFileSync(cfgPath, "utf8")).theme).toBe("mine");
    const second = applyOpenCodeSetup(planOpenCodeSetup(input), "T2");
    expect(second).toEqual({ written: [], backups: [] });
    expect(readdirSync(input.configDir).filter((f) => f.includes(".bak-"))).toEqual(["opencode.json.bak-T1"]);
  });

  it("leaves opencode.jsonc alone", () => {
    mkdirSync(input.configDir, { recursive: true });
    writeFileSync(join(input.configDir, "opencode.jsonc"), "// mine\n{}");
    applyOpenCodeSetup(planOpenCodeSetup(input), "T1");
    expect(readFileSync(join(input.configDir, "opencode.jsonc"), "utf8")).toBe("// mine\n{}");
  });
});

describe("pai-bridge plugin", () => {
  const load = async () => (await import(join(repo, "templates", "opencode", "pai-bridge.mjs"))).default;
  const hook = (body: string): string => {
    const p = join(root, `h${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };
  const run = async (command: string[], tool = "bash", args: unknown = { command: "x", filePath: "/a" }) => {
    const plugin = await load();
    const h = await plugin.server({ directory: "/w" }, { hooks: [{ tools: ["bash"], command }] });
    return h["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, { args });
  };

  it("denies on exit 2 and on a permissionDecision deny, passing Claude-shaped input", async () => {
    const echo = hook(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.error(j.tool_name+":"+j.tool_input.file_path+":"+j.cwd);process.exit(2)})`);
    await expect(run(["node", echo])).rejects.toThrow("Bash:/a:/w");
    const json = hook(`console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:"PAI guard: no"}}))`);
    await expect(run(["node", json])).rejects.toThrow("PAI guard: no");
  });

  it("allows when the hook allows, crashes, is missing, or guards another tool", async () => {
    await expect(run(["node", hook(`console.log("{}")`)])).resolves.toBeUndefined();
    await expect(run(["node", hook(`process.exit(1)`)])).resolves.toBeUndefined();
    await expect(run(["/no/such/binary"])).resolves.toBeUndefined();
    const deny = hook(`process.exit(2)`);
    await expect(run(["node", deny], "read")).resolves.toBeUndefined();
  });
});
