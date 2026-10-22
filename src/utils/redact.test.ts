import { describe, expect, it } from "vitest";
import { REDACT_RULES, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  const cases: Array<[string, string]> = [
    // key=value / key: value / "key": "value" — label kept, value gone
    ["token=abc123", "token=[REDACTED]"],
    ["API_KEY: 'abc123'", "API_KEY: [REDACTED]"],
    ["GITHUB_TOKEN=abc123", "GITHUB_TOKEN=[REDACTED]"],
    ["DB_PASSWORD=abc123", "DB_PASSWORD=[REDACTED]"],
    ["password: hunter2", "password: [REDACTED]"],
    ["api_key: abc123", "api_key: [REDACTED]"],
    ["DB_PASSWORD = hunter2", "DB_PASSWORD = [REDACTED]"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_access_key = [REDACTED]"],
    // env style
    ["export FOO_TOKEN=abc123", "export FOO_TOKEN=[REDACTED]"],
    ["MY_APP_KEY=xyz", "MY_APP_KEY=[REDACTED]"],
    ["APP_SECRET=abc123", "APP_SECRET=[REDACTED]"],
    // Authorization keeps the scheme
    ["Authorization: Bearer eyJhbGciOi.abcdef.ghi", "Authorization: Bearer [REDACTED]"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [REDACTED]"],
    // CLI long flags
    ["mysql --password=hunter2 db", "mysql --password=[REDACTED] db"],
    ["run --token=abc123 --verbose", "run --token=[REDACTED] --verbose"],
    ["tool --api-key=abc123", "tool --api-key=[REDACTED]"],
    ["tool --secret=abc123", "tool --secret=[REDACTED]"],
    ["tool --passwd=abc123", "tool --passwd=[REDACTED]"],
    // URL credentials: user and host survive
    ["DATABASE_URL=postgres://u:[REDACTED]@db/x", "DATABASE_URL=postgres://u:[REDACTED]@db/x"],
    ["see https://user:hunter2@example.com/repo.git", "see https://user:[REDACTED]@example.com/repo.git"],
    // token prefixes
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwx", "key [REDACTED]"],
    ["key sk-abcdefghijklmnopqrstuvwx", "key [REDACTED]"],
    ["origin ghp_abcdefghijklmnopqrstuvwxyz0123456789", "origin [REDACTED]"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "[REDACTED]"],
    ["github_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz0123456789", "[REDACTED]"],
    ["glpat-abcdefghijklmnopqrstuvwx", "[REDACTED]"],
    ["xoxb-123456789012-abcdefghijklmnopqrstuvwx", "[REDACTED]"],
    ["xoxp-123456789012-abcdefghijklmnopqrstuvwx", "[REDACTED]"],
    ["xoxa-2-123456789012-abcdefghijklmnopqrstuvwx", "[REDACTED]"],
    ["AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AWS_ACCESS_KEY_ID=[REDACTED]"],
    ["found AKIAIOSFODNN7EXAMPLE in env", "found [REDACTED] in env"],
    ["ASIAIOSFODNN7EXAMPLE", "[REDACTED]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt [REDACTED]"],
    ["AIzaSyAabcdefghijklmnopqrstuvwxyz012345", "[REDACTED]"],
    // PEM block, complete and truncated
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY----- [REDACTED]"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef", "-----BEGIN PRIVATE KEY----- [REDACTED]"],
    // long opaque run on a key-ish line
    ["GITHUB_TOKEN=abc123", "GITHUB_TOKEN=[REDACTED]"],
    ["api_key: " + "A".repeat(48), "api_key: [REDACTED]"],
    // negatives
    ["the token budget is high", "the token budget is high"],
    ["see https://example.com/a:b@c", "see https://example.com/a:b@c"],
    ["ssh://git@host/repo.git", "ssh://git@host/repo.git"],
    ["plain text", "plain text"],
    ["commit 0123456789012345678901234567890123456789", "commit 0123456789012345678901234567890123456789"],
    ["merged " + "B".repeat(64) + " branch", "merged " + "B".repeat(64) + " branch"],
    ["monkeys=12345", "monkeys=12345"],
    ["mysql --password hunter2 db", "mysql --password [REDACTED] db"],
    ["pip install sk-learn", "pip install sk-learn"],
    ["token for 0123456789012345678901234567890123456789", "token for 0123456789012345678901234567890123456789"],
    ["token=0123456789012345678901234567890123456789", "token=[REDACTED]"],
    ["-p hunter2 db", "-p hunter2 db"],
  ];
  for (const [input, expected] of cases) {
    it(`redacts: ${input.slice(0, 40)}`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }
  it("keeps surrounding lines untouched", () => {
    expect(redactSecrets("before\ntoken=abc123\nafter")).toBe("before\ntoken=[REDACTED]\nafter");
  });
  it("redacts a PEM block between other lines", () => {
    const t = "ok\n-----BEGIN EC PRIVATE KEY-----\nabc\ndef\n-----END EC PRIVATE KEY-----\nok";
    expect(redactSecrets(t)).toBe("ok\n-----BEGIN PRIVATE KEY----- [REDACTED]\nok");
  });
  it("the rule table is exported with ids", () => {
    expect(REDACT_RULES.length).toBeGreaterThanOrEqual(7);
    for (const r of REDACT_RULES) expect(r.id).toBeTruthy();
  });
});
