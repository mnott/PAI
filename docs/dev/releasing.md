# Releasing: the npm publish credential

`npm publish` authenticates with a granular token in `~/.npmrc` (`_authToken` line). npm caps these at 90 days and can invalidate them earlier. A dead token shows up as `E404` on the PUT and `401` from `npm whoami`.

PAI checks it for you:

- `prepublishOnly` runs `pai build npm-auth` and stops the publish with the renewal steps when npm rejects the credential. A timeout or network error is reported but does not block.
- `pai build doctor` prints `npm publish auth: ok (<user>)` or `npm publish auth: REJECTED — see the renewal steps` for any non-private package. The token is never printed.

## Renewing the token

1. Open `https://www.npmjs.com/settings/<user>/tokens`.
2. Generate New Token (granular): Bypass 2FA, Read and write, All packages, 90 days, named by date.
3. Replace the `_authToken` line in `~/.npmrc` with the new token.
4. Check: `pai build npm-auth`.

## Forge push mirror to GitHub

Forge-first repos (origin = Gitea/Forgejo, a push mirror to GitHub) publish with `pai build mirror-sync [--repo DIR] [--json]` instead of a hand-written curl to `push_mirrors-sync`. It derives the forge URL and owner/repo from `origin`, reads the token from the env var named by config `release.forgeTokenEnv` (default `AIBROKER_FORGE_TOKEN`; never printed), triggers the sync and polls `push_mirrors` (60 s, every 3 s) until `last_update` changes. One line per mirror: `github: ok (main at <sha8>)` or `github: REJECTED — push protection: <reason>; unblock: <url>` when GitHub refuses with GH013. Exit 0 only when every mirror is ok.

## Publishing with npm Trusted Publishing (OIDC)

Pushing a tag `v*` to GitHub runs `.github/workflows/publish.yml`, which builds, type-checks and runs `npm publish` with an OIDC token (`id-token: write`); no token in `~/.npmrc` or in GitHub secrets. In CI (`CI=true` or `GITHUB_ACTIONS=true`) the `prepublishOnly` steps `worker pending --gate` and `build npm-auth` are no-ops.

One-time setup by the operator: npmjs.com → package `@tekmidian/pai` → Settings → Trusted Publisher → GitHub Actions → owner and repository of the GitHub mirror, workflow file `publish.yml`, no environment.

Tags only reach GitHub through the forge push mirror, so the mirror must not be blocked by GitHub push protection (`pai build mirror-sync` reports GH013 with the unblock URL).
