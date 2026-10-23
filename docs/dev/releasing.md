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
