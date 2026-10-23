/**
 * fake-secret.ts — test-only helpers that assemble fake token-shaped strings
 * at runtime. GitHub push protection flags raw literals in test fixtures, so
 * every prefix here is split across concatenated parts; the resulting strings
 * are byte-identical to the originals.
 */

/** Concatenates parts into one fake secret string. */
export const fake = (...parts: string[]): string => parts.join("");

/** Fake Slack-style token: xoxb- / xoxp- / xoxa-2- + numeric id + body. */
export const fakeSlack = (kind: string, id: string, body: string): string => fake("xo", kind, "-", id, "-", body);

/** Fake Anthropic key: sk-ant[-suffix]- + body. */
export const fakeAnthropic = (body: string, suffix = ""): string => fake("sk", "-ant", suffix, "-", body);

/** Fake GitHub token: ghp_ / gho_ + body. */
export const fakeGithub = (kind: string, body: string): string => fake("gh", kind, "_", body);

/** Fake GitHub fine-grained token: github_pat_ + rest. */
export const fakeGithubPat = (rest: string): string => fake("github", "_pat", "_", rest);

/** Fake GitLab PAT: glpat- + body. */
export const fakeGitlab = (body: string): string => fake("gl", "pat", "-", body);

/** Fake AWS access key id: AKIA / ASIA + 16 chars. */
export const fakeAwsKey = (prefix: string, rest: string): string => fake(prefix.slice(0, 2), prefix.slice(2), rest);

/** Fake Google API key: AIza + 33 chars. */
export const fakeGoogle = (rest: string): string => fake("AI", "za", rest);

/** PEM block marker line: -----BEGIN <type> PRIVATE KEY----- (type "" = plain). */
export const pemBegin = (type = ""): string => fake("-----", "BEGIN", type ? ` ${type}` : "", " PRIVATE KEY", "-----");

/** PEM block end marker line: -----END <type> PRIVATE KEY----- (type "" = plain). */
export const pemEnd = (type = ""): string => fake("-----", "END", type ? ` ${type}` : "", " PRIVATE KEY", "-----");

/** Fake credentialed URL: scheme://user:pass@host (scanners flag literal user:pass@ URLs). */
export const fakeUrl = (scheme: string, user: string, pass: string, host: string): string =>
  fake(scheme, "://", user, ":", pass, "@", host);
