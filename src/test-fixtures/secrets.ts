import type { SecretsConfig, SecretsRuntime } from "../client/authn/secrets.ts";
import { parseSecretsEnv } from "../client/authn/secrets.ts";

/** Non-production test fixture — never use outside unit tests. */
export const TEST_ONLY_TURBOPANEL_SECRET =
  "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6" as const;

/** Keyring line for {@link TEST_ONLY_TURBOPANEL_SECRET} at version 1. */
export function testSecretsEnvLine(): string {
  return `1:${TEST_ONLY_TURBOPANEL_SECRET}`;
}

/** Parse the canonical test keyring for unit suites. */
export function parseTestSecretsConfig(
  runtime: SecretsRuntime = "deno",
): SecretsConfig {
  return parseSecretsEnv(testSecretsEnvLine(), runtime);
}
