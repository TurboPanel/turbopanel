import { assertEquals, assertRejects } from "@std/assert";
import { parseTestSecretsConfig } from "../../../test-fixtures/secrets.ts";
import {
  isSafeRedirectPath,
  OAUTH_STATE_PURPOSE,
  OAUTH_STATE_TTL_MS,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state.ts";
import { parseSecretsEnv } from "../secrets.ts";
import { ENVELOPE_SCHEME_OAUTH_STATE } from "../envelope.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW_MS = Date.parse("2026-01-15T12:00:00.000Z");
const CLAIMS = {
  provider: "github" as const,
  nonce: "n0nce",
  redirectTo: "/welcome",
};

test("sign/verify round-trips oauth state including optional linkUserId", async () => {
  const secrets = parseTestSecretsConfig();
  const signed = await signOAuthState(secrets, CLAIMS, NOW_MS);
  assertEquals(signed.startsWith(`${ENVELOPE_SCHEME_OAUTH_STATE}.v1.`), true);
  assertEquals(await verifyOAuthState(secrets, signed, NOW_MS), CLAIMS);

  const linked = await signOAuthState(secrets, {
    ...CLAIMS,
    linkUserId: "11111111-1111-4111-8111-111111111111",
  }, NOW_MS);
  assertEquals(await verifyOAuthState(secrets, linked, NOW_MS), {
    ...CLAIMS,
    linkUserId: "11111111-1111-4111-8111-111111111111",
  });
});

test("verifyOAuthState rejects tampered signatures and expired state", async () => {
  const secrets = parseTestSecretsConfig();
  const signed = await signOAuthState(secrets, CLAIMS, NOW_MS);

  assertEquals(
    await verifyOAuthState(secrets, signed, NOW_MS + OAUTH_STATE_TTL_MS + 1),
    null,
  );
  assertEquals(
    await verifyOAuthState(secrets, "not-an-envelope", NOW_MS),
    null,
  );

  const parts = signed.split(".");
  parts[3] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assertEquals(await verifyOAuthState(secrets, parts.join("."), NOW_MS), null);
});

test("oauth state is isolated from a different root secret", async () => {
  const secrets = parseTestSecretsConfig();
  const signed = await signOAuthState(secrets, CLAIMS, NOW_MS);
  const other = parseSecretsEnv(
    "1:Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8_Nn7Mm6Ll5Kk4",
    "deno",
  );
  assertEquals(OAUTH_STATE_PURPOSE, "oauth-sign-in-state");
  assertEquals(await verifyOAuthState(other, signed, NOW_MS), null);
  assertEquals(
    await verifyOAuthState(secrets, "tpinstall.v1.payload.sig", NOW_MS),
    null,
  );
});

test("signOAuthState rejects an open-redirect redirectTo and verify repeats the check", async () => {
  const secrets = parseTestSecretsConfig();
  await assertRejects(
    () =>
      signOAuthState(secrets, {
        ...CLAIMS,
        redirectTo: "https://evil.example",
      }),
    TypeError,
  );
  await assertRejects(
    () => signOAuthState(secrets, { ...CLAIMS, redirectTo: "//evil.example" }),
    TypeError,
  );
  assertEquals(isSafeRedirectPath("/welcome"), true);
  assertEquals(isSafeRedirectPath("//evil"), false);
  assertEquals(isSafeRedirectPath("/ok?next=/x"), true);
});
