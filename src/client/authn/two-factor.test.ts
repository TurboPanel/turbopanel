import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb, endDbConnection } from "../../db.ts";
import {
  account,
  passkey,
  session,
  twoFactor,
  user,
  verification,
} from "../../lib/db/schema.ts";
import { CLIENT_API_PREFIX } from "../../surfaces.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from "./auth-rate-limit.ts";
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from "./crypto.ts";
import { registerAuthRoutes } from "./http.ts";
import { hashPassword } from "./password.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from "./secrets.ts";
import { createSession } from "./session-store.ts";
import { decodeBase32, generateTotp } from "./totp.ts";
import {
  BACKUP_CODE_VERIFIER_PURPOSE,
  disableTwoFactor,
  enrollTotp,
  getTwoFactorStatus,
  issueTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_PURPOSE,
  verifyTotpEnrollment,
  verifyTwoFactorSignIn,
} from "./two-factor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const dbUrl = getDatabaseUrl();

test("Postgres two-factor enrol, verify, challenge, backup consume, disable", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping two-factor DB test: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    config,
    "data-encryption",
  );
  const backupCodeVerifierSecrets = await deriveSecretsConfig(
    config,
    BACKUP_CODE_VERIFIER_PURPOSE,
  );
  const twoFactorChallengeSecrets = await deriveSecretsConfig(
    config,
    TWO_FACTOR_CHALLENGE_PURPOSE,
  );

  const email = `two-factor-${crypto.randomUUID()}@example.com`;
  const password = "Sup3r-secret!";
  const [inserted] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = inserted!.id;

  try {
    await db.insert(account).values({
      userId,
      providerId: "credential",
      providerUserId: userId,
      password: await hashPassword(password),
    });

    const enrolled = await enrollTotp(db, {
      userId,
      email,
      dataEncryptionSecrets,
    });
    const code = await generateTotp(decodeBase32(enrolled.secret), {
      unixSeconds: Math.floor(Date.now() / 1000),
    });
    const verified = await verifyTotpEnrollment(db, {
      userId,
      code,
      dataEncryptionSecrets,
      backupCodeVerifierSecrets,
    });
    assertEquals(verified.backupCodes.length, 10);

    const status = await getTwoFactorStatus(db, userId);
    assertEquals(status.enabled, true);
    assertEquals(status.method, "totp");
    assertEquals(status.backupCodesRemaining, 10);
    assertEquals(status.linkedProviders, []);

    await db.insert(account).values({
      userId,
      providerId: "github",
      providerUserId: `gh-${userId}`,
    });
    const withGithub = await getTwoFactorStatus(db, userId);
    assertEquals(withGithub.linkedProviders, ["github"]);

    await db.insert(passkey).values({
      userId,
      publicKey: "two-factor-test-public-key",
      credentialId: `2fa-passkey-${userId}`,
      deviceType: "multiDevice",
      isBackedUp: true,
    });
    const withPasskey = await getTwoFactorStatus(db, userId);
    assertEquals(withPasskey.passkeys.length, 1);
    assertEquals(withPasskey.passkeys[0]?.deviceType, "multiDevice");
    assertEquals(withPasskey.passkeys[0]?.isBackedUp, true);
    if (
      withPasskey.passkeys[0]?.deviceType === undefined ||
      withPasskey.passkeys[0]?.isBackedUp === undefined
    ) {
      throw new TypeError("two-factor status passkeys omit device fields");
    }

    const challenge = await issueTwoFactorChallenge(
      db,
      twoFactorChallengeSecrets,
      userId,
    );
    const totp = await generateTotp(decodeBase32(enrolled.secret), {
      unixSeconds: Math.floor(Date.now() / 1000),
    });
    const totpResult = await verifyTwoFactorSignIn(db, {
      challenge,
      code: totp,
      twoFactorChallengeSecrets,
      dataEncryptionSecrets,
      backupCodeVerifierSecrets,
    });
    assertEquals(totpResult.status, "ok");
    assertEquals(totpResult.userId, userId);

    const backupChallenge = await issueTwoFactorChallenge(
      db,
      twoFactorChallengeSecrets,
      userId,
    );
    const backup = verified.backupCodes[0]!;
    const backupResult = await verifyTwoFactorSignIn(db, {
      challenge: backupChallenge,
      backupCode: backup,
      twoFactorChallengeSecrets,
      dataEncryptionSecrets,
      backupCodeVerifierSecrets,
    });
    assertEquals(backupResult.status, "ok");

    const afterConsume = await getTwoFactorStatus(db, userId);
    assertEquals(afterConsume.backupCodesRemaining, 9);

    const replayChallenge = await issueTwoFactorChallenge(
      db,
      twoFactorChallengeSecrets,
      userId,
    );
    const replay = await verifyTwoFactorSignIn(db, {
      challenge: replayChallenge,
      backupCode: backup,
      twoFactorChallengeSecrets,
      dataEncryptionSecrets,
      backupCodeVerifierSecrets,
    });
    assertEquals(replay.status, "invalid");

    await disableTwoFactor(db, userId);
    const disabled = await getTwoFactorStatus(db, userId);
    assertEquals(disabled.enabled, false);
    assertEquals(disabled.method, null);
  } finally {
    await db.delete(verification).where(
      eq(verification.identifier, `2fa-attempts:${userId}`),
    );
    await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await db.delete(passkey).where(eq(passkey.userId, userId));
    await db.delete(account).where(eq(account.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await endDbConnection(db);
  }
});

test("concurrent 2FA sign-in and disable do not deadlock", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping concurrent two-factor HTTP test: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    config,
    "data-encryption",
  );
  const backupCodeVerifierSecrets = await deriveSecretsConfig(
    config,
    BACKUP_CODE_VERIFIER_PURPOSE,
  );
  const twoFactorChallengeSecrets = await deriveSecretsConfig(
    config,
    TWO_FACTOR_CHALLENGE_PURPOSE,
  );

  const email = `two-factor-race-${crypto.randomUUID()}@example.com`;
  const password = "Sup3r-secret!";
  const [inserted] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: "user" })
    .returning({ id: user.id });
  const userId = inserted!.id;

  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);

  try {
    await db.insert(account).values({
      userId,
      providerId: "credential",
      providerUserId: userId,
      password: await hashPassword(password),
    });

    const enrolled = await enrollTotp(db, {
      userId,
      email,
      dataEncryptionSecrets,
    });
    const enrollCode = await generateTotp(decodeBase32(enrolled.secret), {
      unixSeconds: Math.floor(Date.now() / 1000),
    });
    await verifyTotpEnrollment(db, {
      userId,
      code: enrollCode,
      dataEncryptionSecrets,
      backupCodeVerifierSecrets,
    });

    const challenge = await issueTwoFactorChallenge(
      db,
      twoFactorChallengeSecrets,
      userId,
    );
    const totp = await generateTotp(decodeBase32(enrolled.secret), {
      unixSeconds: Math.floor(Date.now() / 1000),
    });

    const { token } = await createSession(db, userId, {});
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      token,
      secrets,
    )}`;

    const app = new Hono<AppEnv>();
    app.use("*", (c, next) => {
      c.set("db", db);
      c.set("dataEncryptionSecrets", dataEncryptionSecrets);
      c.set("authRateLimiter", limiter);
      return next();
    });
    const client = new Hono<AppEnv>();
    registerAuthRoutes(client, {
      secrets,
      twoFactorChallengeSecrets,
      backupCodeVerifierSecrets,
      runtime: "deno",
      signupEnvOverride: undefined,
    });
    app.route(CLIENT_API_PREFIX, client);

    const auth = `${CLIENT_API_PREFIX}/auth`;
    const [signInRes, disableRes] = await Promise.all([
      app.request(`${auth}/sign-in/2fa`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Real-IP": "203.0.113.60",
        },
        body: JSON.stringify({ challenge, code: totp }),
      }),
      app.request(`${auth}/2fa/disable`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "X-Real-IP": "203.0.113.61",
        },
        body: JSON.stringify({ password }),
      }),
    ]);

    assertEquals(
      signInRes.status === 500 || disableRes.status === 500,
      false,
      `deadlock or server error: sign-in=${signInRes.status} disable=${disableRes.status}`,
    );
    assertEquals(disableRes.status, 200);
    assertEquals(
      signInRes.status === 200 || signInRes.status === 400,
      true,
      `unexpected sign-in status ${signInRes.status}`,
    );

    const disabled = await getTwoFactorStatus(db, userId);
    assertEquals(disabled.enabled, false);
  } finally {
    setSharedAuthRateLimiterForTests(undefined);
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(verification).where(
      eq(verification.identifier, `2fa-attempts:${userId}`),
    );
    await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await db.delete(account).where(eq(account.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await endDbConnection(db);
  }
});
