Bug report (operator): the mirror-sync step cannot find the forge token. `release.forgeTokenEnv` holds the NAME of an environment variable, but the default config reader in src/builds/mirror-sync.ts obtains it through a config accessor that masks secret-looking values, so the name comes back masked and the env var lookup fails.
Expected: the default config reader returns the real, unmasked value of release.forgeTokenEnv (shipped defaults merged under the user's main config), so the token env var is found.
Look at: src/builds/mirror-sync.ts (defaultConfigReader), src/config/shipped-defaults.ts, src/daemon/config.ts, and src/builds/mirror-sync.test.ts.
Rule: tests must pass (`npx vitest run src/builds/mirror-sync.test.ts`); never use bun test. Do not commit.
