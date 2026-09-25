import { assertEquals } from "@std/assert";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app/app.ts";
import { getDatabaseUrl } from "../../db/url.ts";
import { createDenoDb, endDbConnection } from "../../db/connection.ts";
import {
  account,
  passkey,
  session,
  twoFactor,
  user,
  verification,
} from "../../db/schema.ts";
import { CLIENT_API_PREFIX } from "../../app/surfaces.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from "./auth-rate-limit.ts";
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from "./crypto.ts";
import { registerAuthRoutes } from "./http.ts";
import { hashPassword } from "../../lib/secrets/password.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from "../../lib/secrets/secrets.ts";
import { createSession } from "./session-store.ts";
import { decodeBase32, generateTotp, TOTP_STEP_SECONDS } from "./totp.ts";
import {
  BACKUP_CODE_VERIFIER_PURPOSE,
  disableTwoFactor,
  enrollTotp,
  getTwoFactorStatus,
  issueTwoFactorChallenge,
  MAX_2FA_ATTEMPTS,
  TWO_FACTOR_CHALLENGE_PURPOSE,
  TWO_FACTOR_LOCKOUT_WINDOW_MS,
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
    // Enrol on the previous step: a step is accepted once, and the sign-in
    // below uses the current one.
    const code = await generateTotp(decodeBase32(enrolled.secret), {
      unixSeconds: Math.floor(Date.now() / 1000) - TOTP_STEP_SECONDS,
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
      unixSeconds: Math.floor(Date.now() / 1000) - TOTP_STEP_SECONDS,
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

// --- Hostile cases (audit A1, A5, A6) — real Postgres, real routes, real limiter.

type EnrolledUser = {
  db: ReturnType<typeof createDenoDb>;
  userId: string;
  password: string;
  secret: Uint8Array;
  backupCodes: string[];
  secrets: {
    session: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    dataEncryptionSecrets: Awaited<
      ReturnType<typeof deriveEncryptionSecretsConfig>
    >;
    backupCodeVerifierSecrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    twoFactorChallengeSecrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
  };
};

/**
 * One enrolled 2FA user on the real database. Enrolment uses the code for the
 * previous time step so every sign-in in the test body owns the current one.
 */
async function withEnrolledUser(
  label: string,
  fn: (ctx: EnrolledUser) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(`Skipping ${label}: TURBOPANEL_DATABASE_URL not set`);
    return;
  }
  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const secrets = {
    session: await deriveSecretsConfig(config, "session-signing"),
    dataEncryptionSecrets: await deriveEncryptionSecretsConfig(
      config,
      "data-encryption",
    ),
    backupCodeVerifierSecrets: await deriveSecretsConfig(
      config,
      BACKUP_CODE_VERIFIER_PURPOSE,
    ),
    twoFactorChallengeSecrets: await deriveSecretsConfig(
      config,
      TWO_FACTOR_CHALLENGE_PURPOSE,
    ),
  };
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomUUID();
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
      dataEncryptionSecrets: secrets.dataEncryptionSecrets,
    });
    const secret = decodeBase32(enrolled.secret);
    const verified = await verifyTotpEnrollment(db, {
      userId,
      code: await totpAt(secret, Date.now() - TOTP_STEP_SECONDS * 1000),
      dataEncryptionSecrets: secrets.dataEncryptionSecrets,
      backupCodeVerifierSecrets: secrets.backupCodeVerifierSecrets,
    });
    await fn({
      db,
      userId,
      password,
      secret,
      backupCodes: verified.backupCodes,
      secrets,
    });
  } finally {
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(verification).where(
      like(verification.identifier, `2fa-%:${userId}`),
    );
    await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await db.delete(account).where(eq(account.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await endDbConnection(db);
  }
}

function totpAt(secret: Uint8Array, ms: number): Promise<string> {
  return generateTotp(secret, { unixSeconds: Math.floor(ms / 1000) });
}

/** A 6-digit code that is not valid anywhere in the ±1-step window at `ms`. */
async function wrongCodeAt(secret: Uint8Array, ms: number): Promise<string> {
  const valid = new Set<string>();
  for (const delta of [-1, 0, 1]) {
    valid.add(await totpAt(secret, ms + delta * TOTP_STEP_SECONDS * 1000));
  }
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}

function signIn(
  ctx: EnrolledUser,
  params: {
    challenge: string;
    code?: string;
    backupCode?: string;
    nowMs?: number;
  },
) {
  return verifyTwoFactorSignIn(ctx.db, {
    ...params,
    twoFactorChallengeSecrets: ctx.secrets.twoFactorChallengeSecrets,
    dataEncryptionSecrets: ctx.secrets.dataEncryptionSecrets,
    backupCodeVerifierSecrets: ctx.secrets.backupCodeVerifierSecrets,
  });
}

test("A1: signing in again does not reset the 2FA attempt counter", async () => {
  await withEnrolledUser("2fa-a1", async (ctx) => {
    const now = Date.now();
    const first = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now,
    );
    const wrong = await wrongCodeAt(ctx.secret, now);
    let last = "";
    for (let i = 0; i < MAX_2FA_ATTEMPTS; i += 1) {
      last = (await signIn(ctx, { challenge: first, code: wrong, nowMs: now }))
        .status;
    }
    assertEquals(last, "too_many_attempts");

    // The attacker holds the password, so they can mint a fresh challenge at
    // will. That must not buy another five guesses — not even a right one.
    const second = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now,
    );
    const right = await signIn(ctx, {
      challenge: second,
      code: await totpAt(ctx.secret, now),
      nowMs: now,
    });
    assertEquals(right.status, "too_many_attempts");

    // Once the lockout window has passed, the owner can sign in again.
    const later = now + TWO_FACTOR_LOCKOUT_WINDOW_MS + 60_000;
    const third = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      later,
    );
    const afterWindow = await signIn(ctx, {
      challenge: third,
      code: await totpAt(ctx.secret, later),
      nowMs: later,
    });
    assertEquals(afterWindow.status, "ok");
  });
});

test("A5: a TOTP code is accepted once, even under a new challenge", async () => {
  await withEnrolledUser("2fa-a5-code", async (ctx) => {
    const now = Date.now();
    const code = await totpAt(ctx.secret, now);
    const firstChallenge = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now,
    );
    assertEquals(
      (await signIn(ctx, { challenge: firstChallenge, code, nowMs: now }))
        .status,
      "ok",
    );
    const replayChallenge = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now + 1,
    );
    const replay = await signIn(ctx, {
      challenge: replayChallenge,
      code,
      nowMs: now + 1,
    });
    assertEquals(replay.status, "invalid");
  });
});

test("A5: an older in-window TOTP step is refused after a newer one was used", async () => {
  await withEnrolledUser("2fa-a5-step", async (ctx) => {
    // Enrolment consumed step N-1; use step N+1 (still in the ±1 window at
    // N) and then offer the unused step N — older than the last accepted.
    const now = Date.now();
    const next = now + TOTP_STEP_SECONDS * 1000;
    const first = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now,
    );
    assertEquals(
      (await signIn(ctx, {
        challenge: first,
        code: await totpAt(ctx.secret, next),
        nowMs: now,
      })).status,
      "ok",
    );
    const second = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now + 1,
    );
    const older = await signIn(ctx, {
      challenge: second,
      code: await totpAt(ctx.secret, now),
      nowMs: now + 1,
    });
    assertEquals(older.status, "invalid");
  });
});

test("A5: a challenge that completed a sign-in cannot complete another", async () => {
  await withEnrolledUser("2fa-a5-challenge", async (ctx) => {
    const now = Date.now();
    const challenge = await issueTwoFactorChallenge(
      ctx.db,
      ctx.secrets.twoFactorChallengeSecrets,
      ctx.userId,
      now,
    );
    assertEquals(
      (await signIn(ctx, {
        challenge,
        code: await totpAt(ctx.secret, now),
        nowMs: now,
      })).status,
      "ok",
    );
    // Someone who captured the challenge (it rides in a URL after OAuth) and
    // one unused backup code must not get a second session from it.
    const reused = await signIn(ctx, {
      challenge,
      backupCode: ctx.backupCodes[0]!,
      nowMs: now + 1,
    });
    assertEquals(reused.status, "invalid");
    assertEquals(
      (await getTwoFactorStatus(ctx.db, ctx.userId)).backupCodesRemaining,
      ctx.backupCodes.length,
    );
  });
});

test("A6: password step-up is rate limited per user, across IPs", async () => {
  await withEnrolledUser("2fa-a6", async (ctx) => {
    setSharedAuthRateLimiterForTests(undefined); // the shipped policies
    try {
      const { token } = await createSession(ctx.db, ctx.userId, {});
      const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
        token,
        ctx.secrets.session,
      )}`;
      const app = new Hono<AppEnv>();
      app.use("*", (c, next) => {
        c.set("db", ctx.db);
        c.set("dataEncryptionSecrets", ctx.secrets.dataEncryptionSecrets);
        return next();
      });
      const client = new Hono<AppEnv>();
      registerAuthRoutes(client, {
        secrets: ctx.secrets.session,
        twoFactorChallengeSecrets: ctx.secrets.twoFactorChallengeSecrets,
        backupCodeVerifierSecrets: ctx.secrets.backupCodeVerifierSecrets,
        runtime: "deno",
        signupEnvOverride: undefined,
      });
      app.route(CLIENT_API_PREFIX, client);

      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await app.request(
          `${CLIENT_API_PREFIX}/auth/2fa/disable`,
          {
            method: "POST",
            headers: {
              cookie,
              "content-type": "application/json",
              // A new source address every time: only a per-user bucket can trip.
              "X-Real-IP": `198.51.100.${10 + i}`,
            },
            body: JSON.stringify({ password: `guess-${i}` }),
          },
        );
        statuses.push(res.status);
      }
      assertEquals(statuses.includes(429), true, `statuses: ${statuses}`);
      assertEquals(statuses.at(-1), 429);
      // 2FA must still be on: no guess went through.
      assertEquals((await getTwoFactorStatus(ctx.db, ctx.userId)).enabled, true);
    } finally {
      setSharedAuthRateLimiterForTests(undefined);
    }
  });
});
