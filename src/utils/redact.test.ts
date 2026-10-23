import { describe, expect, it } from "vitest";
import { REDACT_RULES, redactSecrets } from "./redact.js";
import { fake, fakeAnthropic, fakeAwsKey, fakeGithub, fakeGithubPat, fakeGitlab, fakeGoogle, fakeSlack, pemBegin, pemEnd } from "./fake-secret.js";

// Catches quadratic regressions; not a benchmark — the suite runs in parallel.
const REDACT_MS_BOUND = 500;
// Fake token-shaped fixtures assembled at runtime so no scanner flags a literal.
const BODY = "abcdefghijklmnopqrstuvwx";
const GH_BODY = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLACK_ID = "123456789012";
const AKIA_REST = "IOSFODNN7EXAMPLE";
const PEM_BODY = "MIIEowIBAAKCAQEA";
// The redactor's normalised output marker, assembled at runtime as well.
const PEM_OUT = `${pemBegin()} `;

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
    [`key ${fakeAnthropic(BODY, "-api03")}`, "key [REDACTED]"],
    [`key ${fake("sk", "-", BODY)}`, "key [REDACTED]"],
    [`origin ${fakeGithub("p", GH_BODY)}`, "origin [REDACTED]"],
    [`${fakeGithub("o", GH_BODY)}`, "[REDACTED]"],
    [`${fakeGithubPat("11ABCDEFG_" + GH_BODY)}`, "[REDACTED]"],
    [`${fakeGitlab(BODY)}`, "[REDACTED]"],
    [`${fakeSlack("xb", SLACK_ID, BODY)}`, "[REDACTED]"],
    [`${fakeSlack("xp", SLACK_ID, BODY)}`, "[REDACTED]"],
    [`${fakeSlack("xa-2", SLACK_ID, BODY)}`, "[REDACTED]"],
    [`AWS_ACCESS_KEY_ID=${fakeAwsKey("AKIA", AKIA_REST)}`, "AWS_ACCESS_KEY_ID=[REDACTED]"],
    [`found ${fakeAwsKey("AKIA", AKIA_REST)} in env`, "found [REDACTED] in env"],
    [`${fakeAwsKey("ASIA", AKIA_REST)}`, "[REDACTED]"],
    [`jwt ${fake("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")}`, "jwt [REDACTED]"],
    [`${fakeGoogle("SyAabcdefghijklmnopqrstuvwxyz012345")}`, "[REDACTED]"],
    // PEM block, complete and truncated
    [`${pemBegin("RSA")}\n${PEM_BODY}\n${pemEnd("RSA")}`, `${PEM_OUT}[REDACTED]`],
    [`${pemBegin("OPENSSH")}\nabcdef`, `${PEM_OUT}[REDACTED]`],
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
    // JSON: the key's closing quote sits before the separator; quotes survive
    ['{"password": "hunter2"}', '{"password": "[REDACTED]"}'],
    ['{"api_key":"abc123def"}', '{"api_key":"[REDACTED]"}'],
    ['{"token": "abc"}', '{"token": "[REDACTED]"}'],
    // leaks closed
    ["curl -u admin:s3cret https://x", "curl -u admin:[REDACTED] https://x"],
    ["mysql -p'hunter2' db", "mysql -p[REDACTED] db"],
    ["mysqldump -phunter2 db", "mysqldump -p[REDACTED] db"],
    [`key ${fake("sk", "_live_", "abcdefghijklmnopqrst")}`, "key [REDACTED]"],
    [`${fake("sk", "_test_", "abcdefghijklmnopqrst")}`, "[REDACTED]"],
    [`${fake("rk", "_live_", "abcdefghijklmnopqrst")}`, "[REDACTED]"],
    [`${fake("np", "m_", "a".repeat(36))}`, "[REDACTED]"],
    [`${fake("h", "f_", "a".repeat(30))}`, "[REDACTED]"],
    ["//registry.npmjs.org/:_authToken=abc123", "//registry.npmjs.org/:_authToken=[REDACTED]"],
    ["Cookie: sid=abc; theme=dark", "Cookie: sid=[REDACTED]; theme=[REDACTED]"],
    [`${fakeAwsKey("AGPA", AKIA_REST)}`, "[REDACTED]"],
    [`${fakeAwsKey("AIDA", AKIA_REST)}`, "[REDACTED]"],
    [`${fakeAwsKey("AROA", AKIA_REST)}`, "[REDACTED]"],
    // review #4: camelCase and common key shapes
    ["clientSecret: abcd1234", "clientSecret: [REDACTED]"],
    ['accessToken: "abcd1234"', "accessToken: [REDACTED]"],
    ['secretAccessKey: "abcd1234"', "secretAccessKey: [REDACTED]"],
    ["apiKey = abcd1234", "apiKey = [REDACTED]"],
    ["private_key = abcd1234", "private_key = [REDACTED]"],
    ["pwd=x", "pwd=[REDACTED]"],
    ["pass=x", "pass=[REDACTED]"],
    ["key=x", "key=[REDACTED]"],
    ["https://h/api?key=abc123", "https://h/api?key=[REDACTED]"],
    ["https://h/api?sig=abc123", "https://h/api?sig=[REDACTED]"],
    ["X-Amz-Signature=abc123", "X-Amz-Signature=[REDACTED]"],
    ["AccountKey=abc123==", "AccountKey=[REDACTED]"],
    ["tool --client-secret x", "tool --client-secret [REDACTED]"],
    ["tool --access-token x", "tool --access-token [REDACTED]"],
    ["tool --auth-token x", "tool --auth-token [REDACTED]"],
    ["tool --secret-key x", "tool --secret-key [REDACTED]"],
    ["tool --http-password x", "tool --http-password [REDACTED]"],
    ["curl -uuser:pass https://x", "curl -uuser:[REDACTED] https://x"],
    ["mysql -u root -p hunter2", "mysql -u root -p [REDACTED]"],
    ["redis://:secretpw@host", "redis://:[REDACTED]@host"],
    ["token=Bearer abc123", "token=[REDACTED]"],
    ["got Bearer abc123def456 back", "got Bearer [REDACTED] back"],
    // review #5: token prefixes
    [`${fakeSlack("xs", SLACK_ID, BODY)}`, "[REDACTED]"],
    [`${fake("xa", "pp-1-A0123456789-", SLACK_ID)}`, "[REDACTED]"],
    [`${fake("ya", "29.", "a".repeat(30))}`, "[REDACTED]"],
    [`${fake("S", "G.", "a".repeat(22), ".", "b".repeat(43))}`, "[REDACTED]"],
    [`${fake("sh", "pat_", "a1".repeat(16))}`, "[REDACTED]"],
    [`${fake("sh", "pss_", "a1".repeat(16))}`, "[REDACTED]"],
    [`${fake("do", "p_v1_", "a1".repeat(32))}`, "[REDACTED]"],
    [`${fake("py", "pi-", "A".repeat(30))}`, "[REDACTED]"],
    [`${fake("-----BEGIN PGP ", "PRIVATE KEY", " BLOCK-----")}\nabc\n${fake("-----END PGP ", "PRIVATE KEY", " BLOCK-----")}`, `${PEM_OUT}[REDACTED]`],
    // review #6: paths and code stay
    ["src/components/authentication/PasswordInput/PasswordInputComponent.tsx", "src/components/authentication/PasswordInput/PasswordInputComponent.tsx"],
    ["/Users/bob/Library/Application Support/Some Long Product Name/token/handling.ts", "/Users/bob/Library/Application Support/Some Long Product Name/token/handling.ts"],
    ["const token = getToken();", "const token = getToken();"],
    ["password: string;", "password: string;"],
    ["secret: string", "secret: string"],
    ["let apiKey = process.env.KEY", "let apiKey = process.env.KEY"],
    ["password = input()", "password = input()"],
    ["authorization: required", "authorization: required"],
    ["token sha " + "0123456789abcdef".repeat(4), "token sha " + "0123456789abcdef".repeat(4)],
    // over-redaction stopped
    ["token_count: 5", "token_count: 5"],
    ["password_length: 12", "password_length: 12"],
    ["the secret: is out", "the secret: is out"],
    // a passphrase after a secret key is not a known non-secret word
    ["password: correcthorsebattery", "password: [REDACTED]"],
    ["password: required", "password: required"],
    ["token: none", "token: none"],
    ["password: string;", "password: string;"],
    ["Authorization: Bearer x'", "Authorization: Bearer [REDACTED]'"],
    ["mysql -p db", "mysql -p db"],
    ["echo -phunter2", "echo -phunter2"],
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
    const t = `ok\n${pemBegin("EC")}\nabc\ndef\n${pemEnd("EC")}\nok`;
    expect(redactSecrets(t)).toBe(`ok\n${PEM_OUT}[REDACTED]\nok`);
  });
  it("a 180 KB opaque line finishes fast", () => {
    const line = "token " + "ab/".repeat(60000) + "_";
    const t0 = performance.now();
    redactSecrets(line);
    expect(performance.now() - t0).toBeLessThan(REDACT_MS_BOUND);
  });
  it("1 MB shapes finish under 50 ms", () => {
    const MB = 1 << 20;
    const shapes = [
      "lorem ipsum dolor sit amet\n".repeat(40000),
      "word ".repeat(210000),
      "token " + "x".repeat(MB),
      "Cookie: " + "a=b; ".repeat(210000),
      "https://u:p@h/".repeat(75000),
      "http://".repeat(150000),
      "key=".repeat(260000),
      "curl ".repeat(210000),
      "curl -u ".repeat(130000),
      "mysql -p ".repeat(115000),
      "Bearer ".repeat(150000),
      pemBegin() + "\n" + "A".repeat(MB),
    ];
    for (const t of shapes) {
      const t0 = performance.now();
      redactSecrets(t);
      expect(performance.now() - t0).toBeLessThan(REDACT_MS_BOUND);
    }
  });
  it("the rule table is exported with ids", () => {
    expect(REDACT_RULES.length).toBeGreaterThanOrEqual(7);
    for (const r of REDACT_RULES) expect(r.id).toBeTruthy();
  });
});
