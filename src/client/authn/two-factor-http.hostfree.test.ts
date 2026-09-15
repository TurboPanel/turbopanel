import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { CLIENT_API_PREFIX } from "../../surfaces.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from "./auth-rate-limit.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  readJsonBody,
  seedMockCredentialUser,
  withMockLogin,
} from "./authn-hostfree-doubles.ts";
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from "./crypto.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from "./secrets.ts";
import { registerAuthRoutes } from "./http.ts";
import { hashPassword } from "./password.ts";
import { createSession } from "./session-store.ts";
import { decodeBase32, generateTotp } from "./totp.ts";
import {
  BACKUP_CODE_VERIFIER_PURPOSE,
  MAX_2FA_ATTEMPTS,
  signTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_PURPOSE,
} from "./two-factor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const AUTH = `${CLIENT_API_PREFIX}/auth`;
const PASSWORD = "Sup3r-secret!";

async function buildTwoFactorApp() {
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const twoFactorChallengeSecrets = await deriveSecretsConfig(
    config,
    TWO_FACTOR_CHALLENGE_PURPOSE,
  );
  const backupCodeVerifierSecrets = await deriveSecretsConfig(
    config,
    BACKUP_CODE_VERIFIER_PURPOSE,
  );
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    config,
    "data-encryption",
  );
  const state = createEmptyMockAuthState();
  const email = `2fa-${crypto.randomUUID()}@example.com`;
  const userId = crypto.randomUUID();
  seedMockCredentialUser(state, {
    id: userId,
    email,
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  const db = createMockAuthDb(withMockLogin(state, email));
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);

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

  return {
    app,
    db,
    state,
    secrets,
    twoFactorChallengeSecrets,
    userId,
    email,
  };
}

async function sessionCookie(
  db: ReturnType<typeof createMockAuthDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  const signed = await buildSignedCookie(token, secrets);
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
}

async function enrollAndVerify() {
  const ctx = await buildTwoFactorApp();
  const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId);

  const enrollRes = await ctx.app.request(`${AUTH}/2fa/totp/enroll`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assertEquals(enrollRes.status, 200);
  const enrolled = await readJsonBody<{ secret: string; otpauthUri: string }>(
    enrollRes,
  );
  const code = await generateTotp(decodeBase32(enrolled.secret), {
    unixSeconds: Math.floor(Date.now() / 1000),
  });

  const verifyRes = await ctx.app.request(`${AUTH}/2fa/totp/verify`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  assertEquals(verifyRes.status, 200);
  const verified = await readJsonBody<{ backupCodes: string[] }>(verifyRes);
  return {
    ...ctx,
    cookie,
    secret: enrolled.secret,
    backupCodes: verified.backupCodes,
  };
}

test("enrol → verify → challenge → TOTP code issues a session", async () => {
  const ctx = await enrollAndVerify();

  const statusRes = await ctx.app.request(`${AUTH}/2fa`, {
    headers: { cookie: ctx.cookie },
  });
  assertEquals(statusRes.status, 200);
  const status = await readJsonBody<{
    enabled: boolean;
    method: string | null;
    backupCodesRemaining: number;
    linkedProviders: string[];
  }>(statusRes);
  assertEquals(status.enabled, true);
  assertEquals(status.method, "totp");
  assertEquals(status.backupCodesRemaining, 10);
  assertEquals(status.linkedProviders, []);

  ctx.state.passkeys.push({
    id: crypto.randomUUID(),
    userId: ctx.userId,
    name: "Laptop",
    createdAt: new Date().toISOString(),
    credentialId: `2fa-status-${ctx.userId}`,
    publicKey: "{}",
    counter: 0,
    deviceType: "multiDevice",
    isBackedUp: true,
    aaguid: null,
    transports: null,
  });
  const passkeyStatusRes = await ctx.app.request(`${AUTH}/2fa`, {
    headers: { cookie: ctx.cookie },
  });
  assertEquals(passkeyStatusRes.status, 200);
  const passkeyStatus = await readJsonBody<{
    passkeys: Array<{
      id: string;
      deviceType?: string;
      isBackedUp?: boolean;
    }>;
  }>(passkeyStatusRes);
  assertEquals(passkeyStatus.passkeys.length, 1);
  assertEquals(passkeyStatus.passkeys[0]?.deviceType, "multiDevice");
  assertEquals(passkeyStatus.passkeys[0]?.isBackedUp, true);
  if (
    !("deviceType" in (passkeyStatus.passkeys[0] ?? {})) ||
    !("isBackedUp" in (passkeyStatus.passkeys[0] ?? {}))
  ) {
    throw new TypeError("GET /2fa passkeys omit deviceType or isBackedUp");
  }

  ctx.state.accounts.push({
    userId: ctx.userId,
    password: null,
    providerId: "github",
    providerUserId: `gh-${ctx.userId}`,
  });
  const linkedRes = await ctx.app.request(`${AUTH}/2fa`, {
    headers: { cookie: ctx.cookie },
  });
  assertEquals(linkedRes.status, 200);
  const linked = await readJsonBody<{ linkedProviders: string[] }>(linkedRes);
  assertEquals(linked.linkedProviders, ["github"]);

  const signIn = await ctx.app.request(`${AUTH}/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.40",
    },
    body: JSON.stringify({ email: ctx.email, password: PASSWORD }),
  });
  assertEquals(signIn.status, 200);
  const challenged = await readJsonBody<{
    ok: boolean;
    requires2fa: boolean;
    challenge: string;
  }>(signIn);
  assertEquals(challenged.ok, true);
  assertEquals(challenged.requires2fa, true);
  assertEquals(signIn.headers.get("set-cookie"), null);

  const totp = await generateTotp(decodeBase32(ctx.secret), {
    unixSeconds: Math.floor(Date.now() / 1000),
  });
  const complete = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.41",
    },
    body: JSON.stringify({ challenge: challenged.challenge, code: totp }),
  });
  assertEquals(complete.status, 200);
  const session = await readJsonBody<{ ok: boolean; is2faEnabled: boolean }>(
    complete,
  );
  assertEquals(session.ok, true);
  assertEquals(session.is2faEnabled, true);
  assertEquals(complete.headers.get("set-cookie") !== null, true);
});

test("five wrong TOTP codes kill the challenge", async () => {
  const ctx = await enrollAndVerify();
  const signIn = await ctx.app.request(`${AUTH}/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.42",
    },
    body: JSON.stringify({ email: ctx.email, password: PASSWORD }),
  });
  const challenged = await readJsonBody<{ challenge: string }>(signIn);

  let lastStatus = 0;
  for (let i = 0; i < MAX_2FA_ATTEMPTS; i += 1) {
    const res = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Real-IP": "203.0.113.43",
      },
      body: JSON.stringify({ challenge: challenged.challenge, code: "000000" }),
    });
    lastStatus = res.status;
  }
  assertEquals(lastStatus, 429);
  const dead = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.44",
    },
    body: JSON.stringify({ challenge: challenged.challenge, code: "000000" }),
  });
  assertEquals(dead.status, 429);
});

test("expired challenge is rejected without consuming a code", async () => {
  const ctx = await enrollAndVerify();
  const expired = await signTwoFactorChallenge(
    ctx.twoFactorChallengeSecrets,
    ctx.userId,
    Date.now() - 10 * 60 * 1000,
  );
  const res = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.45",
    },
    body: JSON.stringify({ challenge: expired, code: "123456" }),
  });
  assertEquals(res.status, 400);
  const body = await readJsonBody<{ error: string }>(res);
  assertEquals(body.error, "Invalid or expired challenge");
});

test("a backup code is accepted once then removed", async () => {
  const ctx = await enrollAndVerify();
  const signIn = await ctx.app.request(`${AUTH}/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.46",
    },
    body: JSON.stringify({ email: ctx.email, password: PASSWORD }),
  });
  const challenged = await readJsonBody<{ challenge: string }>(signIn);
  const backupCode = ctx.backupCodes[0]!;

  const first = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.47",
    },
    body: JSON.stringify({ challenge: challenged.challenge, backupCode }),
  });
  assertEquals(first.status, 200);

  const signInAgain = await ctx.app.request(`${AUTH}/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.48",
    },
    body: JSON.stringify({ email: ctx.email, password: PASSWORD }),
  });
  const challengedAgain = await readJsonBody<{ challenge: string }>(
    signInAgain,
  );
  const second = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.49",
    },
    body: JSON.stringify({
      challenge: challengedAgain.challenge,
      backupCode,
    }),
  });
  assertEquals(second.status, 400);
  const body = await readJsonBody<{ error: string }>(second);
  assertEquals(body.error, "Invalid code");
});

test("disable requires reauthentication", async () => {
  const ctx = await enrollAndVerify();

  const missing = await ctx.app.request(`${AUTH}/2fa/disable`, {
    method: "POST",
    headers: {
      cookie: ctx.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assertEquals(missing.status, 403);

  const wrong = await ctx.app.request(`${AUTH}/2fa/disable`, {
    method: "POST",
    headers: {
      cookie: ctx.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assertEquals(wrong.status, 403);

  const ok = await ctx.app.request(`${AUTH}/2fa/disable`, {
    method: "POST",
    headers: {
      cookie: ctx.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assertEquals(ok.status, 200);

  const statusRes = await ctx.app.request(`${AUTH}/2fa`, {
    headers: { cookie: ctx.cookie },
  });
  const status = await readJsonBody<{ enabled: boolean }>(statusRes);
  assertEquals(status.enabled, false);
});

test("sign-in/2fa rejects a user disabled after challenge issuance", async () => {
  const ctx = await enrollAndVerify();
  const signIn = await ctx.app.request(`${AUTH}/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.50",
    },
    body: JSON.stringify({ email: ctx.email, password: PASSWORD }),
  });
  assertEquals(signIn.status, 200);
  const challenged = await readJsonBody<{ challenge: string }>(signIn);

  const userRow = ctx.state.users.find((row) => row.id === ctx.userId);
  if (!userRow) {
    throw new TypeError("expected seeded user");
  }
  userRow.isDisabled = true;
  const cred = ctx.state.credentials.get(ctx.email);
  if (cred) cred.isDisabled = true;

  const sessionsBefore = ctx.state.insertedSessions.length;
  const tokenCountBefore = ctx.state.sessions.size;

  const totp = await generateTotp(decodeBase32(ctx.secret), {
    unixSeconds: Math.floor(Date.now() / 1000),
  });
  const complete = await ctx.app.request(`${AUTH}/sign-in/2fa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.51",
    },
    body: JSON.stringify({ challenge: challenged.challenge, code: totp }),
  });
  assertEquals(complete.status, 401);
  const body = await readJsonBody<{ ok: boolean; error: string }>(complete);
  assertEquals(body.ok, false);
  assertEquals(body.error, "Invalid credentials");
  assertEquals(complete.headers.get("set-cookie"), null);
  assertEquals(ctx.state.insertedSessions.length, sessionsBefore);
  assertEquals(ctx.state.sessions.size, tokenCountBefore);
});
