# Releasing: one flow through the forge and GitHub Releases

There is no npm registry step and no credential in `~/.npmrc`. The private forge (`origin`) stays in the middle: issues and discussion live there. GitHub gets `main` and the release tags through the forge's push mirror, plus one GitHub Release per version with the installable package attached. Users install and update from GitHub.

## Cutting a release

```
pai release --dry-run                 # the plan, nothing changes
pai release [--repo PATH] [--bump patch|minor|major|X.Y.Z]
```

Run it in the repo (or give `--repo`). It refuses a dirty tree or a branch other than `main`. Then, one line per step:

1. `check`: clean tree, branch main, forge and GitHub repo read from `origin` and package.json `repository`.
2. `bump`: `npm version <v> --no-git-tag-version`, plus `scripts/sync-versions.mjs` when the repo has one.
3. `build`: `npm run build`.
4. `test`: the repo's unit tests (`test:unit`, else `vitest run` limited to the `unit` project when the config has one, else `npm test`). Never browser suites, never `bun test`.
5. `commit`: `git add -A`, one commit `chore: release <v>`.
6. `tag`: `v<v>`.
7. `push`: `git push origin main --tags` (the forge).
8. `mirror`: the forge push-mirror sync (same code and token as `pai build mirror-sync`), then waits until `git ls-remote github` shows the tag.
9. `pack`: `npm pack` locally into a temp directory; the file is also copied to the stable name `<name>.tgz` (scope removed, no version).
10. `release`: `gh release create v<v> <name>.tgz <versioned>.tgz --repo <owner>/<repo>`; notes are the CHANGELOG section for the version, else the commit subjects since the previous tag.

A failure stops at that step and prints `state:` — what is committed, tagged and pushed — so the repo is never left unexplained. Fix the cause, then finish by hand from the state line (the tag and commit are already there if the state says so; do not bump again).

Forge token: the env var named by config `release.forgeTokenEnv` (default `AIBROKER_FORGE_TOKEN`; never printed). GitHub: `gh auth login` once. The same flow serves every related package (AIBroker, Whazaa, Telex, ...): the same command in each repo.

The MCP tools `release` (with `dry_run`) and `update_check` wrap the same functions.

## Installing and updating

```
npm i -g https://github.com/<owner>/<repo>/releases/latest/download/<name>.tgz
pai update [--check] [--package <name>]
```

`pai update` reads the installed version, asks the GitHub API for the latest release of the package's repository (package.json `repository`) and runs `npm i -g <asset url>` when it is newer; `--check` only reports. Run `pai reload` afterwards.

## Forge push mirror to GitHub

`pai build mirror-sync [--repo DIR] [--json]` is the mirror step on its own. It derives the forge URL and owner/repo from `origin`, reads the token from the env var named by config `release.forgeTokenEnv`, triggers the sync and polls `push_mirrors` (60 s, every 3 s) until `last_update` changes. One line per mirror: `github: ok (main at <sha8>)` or `github: REJECTED — push protection: <reason>; unblock: <url>` when GitHub refuses with GH013. Exit 0 only when every mirror is ok.
