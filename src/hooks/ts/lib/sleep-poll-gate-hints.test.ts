import { describe, expect, it } from "vitest";
import { decideSleepPollGate } from "./sleep-poll-gate.js";

const reason = (command: string, worker = true): string => {
  const d = decideSleepPollGate(
    { tool_name: "Bash", tool_input: { command } },
    worker ? { PAI_WORKER: "1" } : {}
  );
  if (d.decision !== "deny") throw new Error(`expected deny: ${command}`);
  return d.reason;
};

describe("sleep-poll gate: the deny message names the wait verb for what the command waits on", () => {
  it("child workers (pai worker ps / worker ids): wait <ids>, never wait-on", () => {
    const r = reason('sleep 58; sleep 58; ls /tmp/o4983-unit-*.rc; pai worker ps | grep -E "x"');
    expect(r).toContain("pai worker wait <id...> --max 590");
    expect(r).not.toContain("wait-on");
    const r2 = reason("sleep 90; pai worker log 20261017-152748-4983");
    expect(r2).toContain("pai worker wait 20261017-152748-4983 --max 590");
    expect(r2).not.toContain("wait-on");
  });

  it("server (curl / lsof): wait-url with the url or port from the command", () => {
    expect(reason("until curl -s http://127.0.0.1:8019/v1/models; do sleep 5; done")).toContain(
      "pai worker wait-url http://127.0.0.1:8019/v1/models --max 590"
    );
    expect(reason("sleep 90; lsof -i :8041")).toContain("pai worker wait-url http://127.0.0.1:8041/ --max 590");
    expect(reason("sleep 65; curl localhost")).toContain("pai worker wait-url <url>");
  });

  it("file (ls / test -f / grep -q FILE): wait-file with the path", () => {
    expect(reason("sleep 70; ls /tmp/job.rc")).toContain("pai worker wait-file /tmp/job.rc --max 590");
    expect(reason("sleep 90; test -f /tmp/x.out && cat /tmp/x.out")).toContain("pai worker wait-file /tmp/x.out --max 590");
    expect(reason("sleep 70; grep -q 'rc=' /tmp/d.log")).toContain("pai worker wait-file /tmp/d.log");
  });

  it("pid: wait-on with the pid or pid file", () => {
    expect(reason("sleep 90; ps -p 4242 -o etime")).toContain("pai worker wait-on 4242 --max 590");
    expect(reason("sleep 90; kill -0 $(cat /tmp/job.pid) && echo alive")).toContain(
      "pai worker wait-on $(cat /tmp/job.pid) --max 590"
    );
  });

  it("no pattern: the full verb list and the detached recipe", () => {
    const r = reason("sleep 300; echo hi");
    for (const v of ["pai worker wait ", "wait-on", "wait-url", "wait-file", "nohup sh -c"]) expect(r).toContain(v);
  });

  it("an interactive session gets no worker verbs", () => {
    expect(reason("sleep 300; curl http://x:1/", false)).not.toContain("pai worker");
  });

  it("allows a single sleep up to 60s and sums up to 60s", () => {
    for (const c of ["sleep 60", "sleep 30; sleep 30", "sleep 5", "for i in 1 2 3; do sleep 12; done"]) {
      expect(decideSleepPollGate({ tool_name: "Bash", tool_input: { command: c } }, { PAI_WORKER: "1" }).decision, c).toBe("allow");
    }
    expect(decideSleepPollGate({ tool_name: "Bash", tool_input: { command: "sleep 61" } }, { PAI_WORKER: "1" }).decision).toBe("deny");
  });
});

describe("sleep-poll gate: sleep text that is not a command", () => {
  const verdict = (command: string) =>
    decideSleepPollGate({ tool_name: "Bash", tool_input: { command } }, { PAI_WORKER: "1" }).decision;

  it("ignores sleeps inside heredoc bodies and quoted strings", () => {
    expect(verdict("node - <<'EOF'\ns=s.replace('sleep 30 && sleep 31', 'sleep 58; sleep 58; sleep 90')\nEOF")).toBe("allow");
    expect(verdict("python3 - <<PY\nx = \"sleep 188\"\nPY\nls")).toBe("allow");
    expect(verdict("echo 'sleep 500; sleep 500'")).toBe("allow");
    expect(verdict('grep "sleep 90; sleep 90" notes.md')).toBe("allow");
  });

  it("still blocks real sleeps around a heredoc or quoted text", () => {
    expect(verdict("cat <<EOF\nhi\nEOF\nsleep 90")).toBe("deny");
    expect(verdict("echo 'x'; sleep 90")).toBe("deny");
    expect(verdict("sleep 58; sleep 58")).toBe("deny");
  });
});
