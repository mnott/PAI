import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { armGuardReason, denyReason, renderDeny, repairPath } from "./path-repair.js";

const W = { PAI_WORKER: "1" } as NodeJS.ProcessEnv;
const CWD = "/private/tmp/ab-arms/view-decimals-local30-spec-221429";
const GOOD = `${CWD}/Sources/Core/Text/PDFNumber.swift`;
const TYPO = GOOD.replace("local30", "local32");
const fs = (...paths: string[]) => (p: string) => paths.includes(p);
const read = (file_path: string, cwd = CWD) => ({ tool_name: "Read", cwd, tool_input: { file_path } });

describe("repairPath", () => {
  it("repairs the exact local30/local32 case", () => {
    const r = repairPath(read(TYPO), W, fs(GOOD));
    expect(r?.new).toBe(GOOD);
    expect(r?.updatedInput).toEqual({ file_path: GOOD });
  });

  it("treats /tmp and /private/tmp as the same", () => {
    const r = repairPath(read(TYPO.replace("/private", "")), W, fs(GOOD));
    expect(r?.new).toBe(GOOD);
  });

  it("distance 4 is no near-miss; the suffix rule repairs it instead", () => {
    const far = GOOD.replace("local30-spec", "lo9999-spec");
    expect(repairPath(read(far), W, fs(GOOD))?.new).toBe(GOOD);
    expect(repairPath(read(far), W, fs())).toBeNull();
  });

  it("leaves an existing path untouched", () => {
    expect(repairPath(read(TYPO), W, fs(TYPO, GOOD))).toBeNull();
  });

  it("leaves a relative path untouched", () => {
    expect(repairPath(read("Sources/x.swift"), W, fs(GOOD))).toBeNull();
  });

  it("leaves everything untouched outside a worker", () => {
    expect(repairPath(read(TYPO), {} as NodeJS.ProcessEnv, fs(GOOD))).toBeNull();
  });

  it("does nothing when the repaired path does not exist either", () => {
    expect(repairPath(read(TYPO), W, fs())).toBeNull();
  });

  it("never touches Bash outside an arm", () => {
    const i = { tool_name: "Bash", cwd: "/Users/x/proj", tool_input: { command: `cat ${TYPO}` } };
    expect(repairPath(i, W, fs(GOOD))).toBeNull();
  });

  it("Write checks the parent dir, not the file", () => {
    const dir = `${CWD}/Sources/Core/Text`;
    const i = { tool_name: "Write", cwd: CWD, tool_input: { file_path: TYPO, content: "x" } };
    const r = repairPath(i, W, fs(dir));
    expect(r?.new).toBe(GOOD);
    expect(r?.updatedInput).toEqual({ file_path: GOOD, content: "x" });
    expect(repairPath(i, W, fs(dir, TYPO.replace(/\/[^/]+$/, "")))).toBeNull();
  });

  describe("suffix rule", () => {
    const C = "/private/tmp/ab-arms/save-model-ref-ornith-precise-041742";
    const REL = "Sources/Documents/Pages/ThreeDAppearance.swift";
    const invented = `/Users/dev/git/3DPDF/${REL}`;

    it("repairs an invented absolute path to the cwd file", () => {
      const r = repairPath(read(invented, C), W, fs(`${C}/${REL}`));
      expect(r?.new).toBe(`${C}/${REL}`);
    });

    it("Write: repairs when the parent dir exists under cwd", () => {
      const i = { tool_name: "Write", cwd: C, tool_input: { file_path: "/Users/dev/git/X/Sources/New.swift", content: "x" } };
      const r = repairPath(i, W, fs(`${C}/Sources`));
      expect(r?.new).toBe(`${C}/Sources/New.swift`);
    });

    it("leaves a one-component suffix untouched", () => {
      expect(repairPath(read("/Users/dev/git/ThreeDAppearance.swift", C), W, fs(`${C}/ThreeDAppearance.swift`))).toBeNull();
    });

    it("leaves an existing path untouched", () => {
      expect(repairPath(read(invented, C), W, fs(invented, `${C}/${REL}`))).toBeNull();
    });

    it("leaves non-workers untouched", () => {
      expect(repairPath(read(invented, C), {} as NodeJS.ProcessEnv, fs(`${C}/${REL}`))).toBeNull();
    });

    it("still repairs the near-miss prefix", () => {
      expect(repairPath(read(TYPO), W, fs(GOOD))?.new).toBe(GOOD);
    });
  });

  it("repairs Grep path", () => {
    const i = { tool_name: "Grep", cwd: CWD, tool_input: { pattern: "a", path: `${CWD.replace("30", "32")}/Sources` } };
    expect(repairPath(i, W, fs(`${CWD}/Sources`))?.new).toBe(`${CWD}/Sources`);
  });
});

describe("denyReason", () => {
  const C = "/private/tmp/ab-arms/deny-cwd";
  const H = { PAI_WORKER: "1", HOME: "/home/u" } as NodeJS.ProcessEnv;
  const i = (tool_name: string, file_path: string, cwd = C) => ({ tool_name, cwd, tool_input: { file_path } });

  it("denies an unrepairable outside path in an arm", () => {
    expect(denyReason(i("Read", "/Users/dev/git/Other/Here.swift"), H)).toContain(`working directory is ${C}`);
  });
  it("denies an existing outside path too", () => {
    expect(denyReason(i("Read", "/Users/dev/real.txt"), H)).not.toBeNull();
  });
  it("leaves allow-listed Read untouched", () => {
    expect(denyReason(i("Read", "/usr/lib/x.h"), H)).toBeNull();
    expect(denyReason(i("Read", "/home/u/.claude/CLAUDE.md"), H)).toBeNull();
  });
  it("denies Write outside even in the allow-list", () => {
    expect(denyReason(i("Write", "/usr/local/x"), H)).not.toBeNull();
  });
  it("leaves paths under cwd untouched, /tmp ≡ /private/tmp", () => {
    expect(denyReason(i("Read", `${C}/a.ts`), H)).toBeNull();
    expect(denyReason(i("Read", "/tmp/ab-arms/deny-cwd/a.ts"), H)).toBeNull();
  });
  it("allows /tmp scratch, still fences other arms", () => {
    expect(denyReason(i("Write", "/tmp/x"), H)).toBeNull();
    expect(denyReason(i("Read", "/tmp/x"), H)).toBeNull();
    expect(denyReason(i("Write", "/private/tmp/ab-arms/other-arm/x"), H)).not.toBeNull();
  });
  it("Bash: allows /tmp scratch, still fences other arms", () => {
    const b = (command: string) => ({ tool_name: "Bash", cwd: C, tool_input: { command } });
    expect(denyReason(b("cat > /tmp/recon.py"), H)).toBeNull();
    expect(denyReason(b("cat /private/tmp/ab-arms/other-arm/x"), H)).not.toBeNull();
  });
  it("Bash: deny reason names the token; inline program text is not scanned", () => {
    const b = (command: string) => ({ tool_name: "Bash", cwd: C, tool_input: { command } });
    expect(denyReason(b("cat /etc/x"), H)).toContain("Outside it: /etc/x");
    expect(denyReason(b("cd /tmp/lintest && python3 -c \"import re; re.findall(rb'(?<![0-9])(\\d+) 0 obj', open('/zz/q','rb').read())\""), H)).toBeNull();
    expect(denyReason(b("node -e 'console.log(\"/nope/x\")'"), H)).toBeNull();
    expect(denyReason(b("awk '{print \"/nope/x\"}' f"), H)).toBeNull();
  });
  it("leaves non-workers untouched", () => {
    expect(denyReason(i("Read", "/Users/dev/x"), {} as NodeJS.ProcessEnv)).toBeNull();
  });
  it("renders a deny decision", () => {
    expect(JSON.parse(renderDeny("r")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  describe("normal workers and symlinks", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-")));
    const real = join(base, "real");
    const link = join(base, "link");
    const other = join(base, "other");
    mkdirSync(real);
    mkdirSync(other);
    writeFileSync(join(real, "a.txt"), "x");
    writeFileSync(join(other, "b.txt"), "x");
    symlinkSync(real, link);
    afterAll(() => rmSync(base, { recursive: true, force: true }));

    it("symlinked cwd + file inside: untouched", () => {
      expect(denyReason(i("Read", join(real, "a.txt"), link), H)).toBeNull();
      expect(denyReason(i("Read", join(link, "a.txt"), real), H)).toBeNull();
    });
    it("normal worker reading an existing path elsewhere: untouched", () => {
      expect(denyReason(i("Read", join(other, "b.txt"), link), H)).toBeNull();
    });
    it("normal worker, invented missing path with suffix under cwd: repaired", () => {
      mkdirSync(join(real, "sub"));
      writeFileSync(join(real, "sub", "a.txt"), "x");
      const r = repairPath(i("Read", "/nope/sub/a.txt", real), H, existsSync);
      expect(r?.new).toBe(join(real, "sub", "a.txt"));
    });
    it("arm with marker is fenced, outside path denied", () => {
      mkdirSync(join(real, ".git"));
      writeFileSync(join(real, ".git", "ab-isolated"), "");
      expect(denyReason(i("Write", join(other, "b.txt"), link), H)).not.toBeNull();
      expect(denyReason(i("Read", join(real, "a.txt"), link), H)).toBeNull();
    });
  });
});

describe("armGuardReason", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arms-guardtest-")));
  const arm = join(root, "arm-a");
  mkdirSync(arm);
  const env = { PAI_WORKER: "1", PAI_AB_ARMS_ROOT: root };
  const bash = (command: string, cwd: string) => ({ tool_name: "Bash", cwd, tool_input: { command } });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("denies rm -rf via $VAR from a cwd outside the arm", () => {
    expect(armGuardReason(bash(`A=${arm}; rm -rf $A`, tmpdir()), env)).toMatch(/running A\/B arm/);
  });
  it("denies mv and redirect onto an arm", () => {
    expect(armGuardReason(bash(`mv ${arm}/x /tmp/y`, tmpdir()), env)).not.toBeNull();
    expect(armGuardReason(bash(`echo hi > ${arm}/f`, tmpdir()), env)).not.toBeNull();
  });
  it("allows rm from inside the arm on its own scratch", () => {
    expect(armGuardReason(bash(`rm -rf ${arm}/scratch`, arm), env)).toBeNull();
  });
  it("leaves non-destructive commands and non-workers alone", () => {
    expect(armGuardReason(bash(`cat ${arm}/f`, tmpdir()), env)).toBeNull();
    expect(armGuardReason(bash(`rm -rf ${arm}`, tmpdir()), { PAI_AB_ARMS_ROOT: root })).toBeNull();
  });
});
