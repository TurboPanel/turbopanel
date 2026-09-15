import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../../../app.ts";
import { CLIENT_API_PREFIX } from "../../../surfaces.ts";
import { parseTestSecretsConfig } from "../../../test-fixtures/secrets.ts";
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from "../auth-rate-limit.ts";
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockCredentialUser,
  seedMockSignupEnabled,
  seedMockUser,
} from "../authn-hostfree-doubles.ts";
import { buildSignedCookie, HTTPS_SESSION_COOKIE_NAME } from "../crypto.ts";
import { registerAuthRoutes } from "../http.ts";
import { hashPassword } from "../password.ts";
import { deriveSecretsConfig } from "../secrets.ts";
import { createSession } from "../session-store.ts";
import { TWO_FACTOR_CHALLENGE_PURPOSE } from "../two-factor.ts";
import { OAUTH_STATE_TTL_MS, signOAuthState } from "./oauth-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const AUTH = `${CLIENT_API_PREFIX}/auth`;
const ORIGIN = "https://panel.example.com";
const PASSWORD = "Sup3r-secret!";
const GITHUB_ENV = {
  TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID: "gh-client",
  TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET: "gh-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubGithubIdentityFetch(identity?: { id?: number }): () => void {
  const githubId = identity?.id ?? 99;
  const original = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return Promise.resolve(jsonResponse({ access_token: "gho_test" }));
    }
    if (url.endsWith("/user") && !url.includes("emails")) {
      return Promise.resolve(jsonResponse({
        id: githubId,
        login: "octocat",
        name: "Octo Cat",
      }));
    }
    if (url.includes("/user/emails")) {
      return Promise.resolve(jsonResponse([
        { email: "octocat@example.com", primary: true, verified: true },
      ]));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function buildApp(opts?: {
  signupEnabled?: boolean;
  withSecrets?: boolean;
  withTwoFactorChallengeSecrets?: boolean;
}) {
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const twoFactorChallengeSecrets = await deriveSecretsConfig(
    config,
    TWO_FACTOR_CHALLENGE_PURPOSE,
  );
  const state = createEmptyMockAuthState();
  seedMockSignupEnabled(state, opts?.signupEnabled ?? false);
  const db = createMockAuthDb(state);
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);

  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("secretsConfig", config);
    c.set("platformEnv", GITHUB_ENV);
    c.set("authRateLimiter", limiter);
    return next();
  });
  const client = new Hono<AppEnv>();
  registerAuthRoutes(client, {
    ...(opts?.withSecrets === false ? {} : { secrets }),
    ...(opts?.withTwoFactorChallengeSecrets === false
      ? {}
      : { twoFactorChallengeSecrets }),
    runtime: "deno",
    signupEnvOverride: opts?.signupEnabled === true ? "1" : "0",
    baseUrl: ORIGIN,
  });
  app.route(CLIENT_API_PREFIX, client);

  return { app, db, state, secrets, config };
}

function assertRedirectNotJson(res: Response, location: string) {
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), location);
  const contentType = res.headers.get("content-type") ?? "";
  assertEquals(contentType.includes("json"), false);
}

test("unconfigured provider start returns 404", async () => {
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const state = createEmptyMockAuthState();
  const db = createMockAuthDb(state);
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("secretsConfig", config);
    c.set("platformEnv", {});
    c.set("authRateLimiter", limiter);
    return next();
  });
  const client = new Hono<AppEnv>();
  registerAuthRoutes(client, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
  });
  app.route(CLIENT_API_PREFIX, client);

  const res = await app.request(`${ORIGIN}${AUTH}/oauth/github/start`);
  assertEquals(res.status, 404);
});

test("start redirects to GitHub authorize URL with signed state", async () => {
  const { app } = await buildApp();
  const res = await app.request(`${ORIGIN}${AUTH}/oauth/github/start`);
  assertEquals(res.status, 302);
  const location = res.headers.get("location") ?? "";
  assertEquals(
    location.includes("https://github.com/login/oauth/authorize"),
    true,
  );
  assertEquals(location.includes("client_id=gh-client"), true);
  assertEquals(location.includes("state="), true);
});

test("callback with tampered or expired state redirects oauth_state_invalid", async () => {
  const { app, config } = await buildApp();
  const tampered = await app.request(
    `${ORIGIN}${AUTH}/oauth/github/callback?code=x&state=not-an-envelope`,
  );
  assertEquals(tampered.status, 302);
  assertEquals(
    tampered.headers.get("location"),
    "/sign-in?error=oauth_state_invalid",
  );

  const expiredState = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/",
  }, Date.now() - OAUTH_STATE_TTL_MS - 1_000);
  const expired = await app.request(
    `${ORIGIN}${AUTH}/oauth/github/callback?code=x&state=${
      encodeURIComponent(expiredState)
    }`,
  );
  assertEquals(expired.status, 302);
  assertEquals(
    expired.headers.get("location"),
    "/sign-in?error=oauth_state_invalid",
  );
});

test("signup-disabled with no matching account redirects oauth_signup_disabled", async () => {
  const { app, config } = await buildApp({ signupEnabled: false });
  const state = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/",
  });
  const restore = stubGithubIdentityFetch();
  try {
    const res = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(state)
      }`,
    );
    assertEquals(res.status, 302);
    assertEquals(
      res.headers.get("location"),
      "/sign-in?error=oauth_signup_disabled",
    );
  } finally {
    restore();
  }
});

test("existing match issues a session cookie and redirects to redirectTo", async () => {
  const { app, state, config } = await buildApp();
  const userId = crypto.randomUUID();
  seedMockUser(state, {
    id: userId,
    email: "octocat@example.com",
    isDisabled: false,
    isEmailVerified: true,
    is2FaEnabled: false,
    role: "user",
  });
  state.accounts.push({
    userId,
    password: null,
    providerId: "github",
    providerUserId: "99",
  });
  const oauthState = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/welcome",
  });
  const restore = stubGithubIdentityFetch();
  try {
    const res = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(oauthState)
      }`,
    );
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/welcome");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assertEquals(setCookie.includes(HTTPS_SESSION_COOKIE_NAME), true);
  } finally {
    restore();
  }
});

test("2FA user is redirected to a tp2fa challenge instead of a session", async () => {
  const { app, state, config } = await buildApp();
  const userId = crypto.randomUUID();
  seedMockUser(state, {
    id: userId,
    email: "octocat@example.com",
    isDisabled: false,
    isEmailVerified: true,
    is2FaEnabled: true,
    role: "user",
  });
  state.accounts.push({
    userId,
    password: null,
    providerId: "github",
    providerUserId: "99",
  });
  const oauthState = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/",
  });
  const restore = stubGithubIdentityFetch();
  try {
    const res = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(oauthState)
      }`,
    );
    assertEquals(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assertEquals(location.startsWith("/sign-in?challenge="), true);
    assertEquals((res.headers.get("set-cookie") ?? "").length, 0);
  } finally {
    restore();
  }
});

test("link mode success and unique-constraint conflict", async () => {
  const { app, db, state, secrets, config } = await buildApp();
  const userId = crypto.randomUUID();
  seedMockCredentialUser(state, {
    id: userId,
    email: "owner@example.com",
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  const { token } = await createSession(db, userId, {});
  const cookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;

  const restore = stubGithubIdentityFetch();
  try {
    const start = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/start?link=1`,
      { headers: { cookie } },
    );
    assertEquals(start.status, 302);
    const authorize = new URL(start.headers.get("location") ?? "");
    const signedState = authorize.searchParams.get("state") ?? "";

    const linked = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(signedState)
      }`,
      { headers: { cookie } },
    );
    assertEquals(linked.status, 302);
    assertEquals(
      linked.headers.get("location"),
      "/account/security?linked=github",
    );

    const otherUser = crypto.randomUUID();
    seedMockUser(state, {
      id: otherUser,
      email: "other@example.com",
      isDisabled: false,
      isEmailVerified: true,
      role: "user",
    });
    const { token: otherToken } = await createSession(db, otherUser, {});
    const otherCookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      otherToken,
      secrets,
    )}`;
    const conflictState = await signOAuthState(config, {
      provider: "github",
      nonce: "n2",
      redirectTo: "/",
      linkUserId: otherUser,
    });
    const conflict = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(conflictState)
      }`,
      { headers: { cookie: otherCookie } },
    );
    assertEquals(conflict.status, 302);
    assertEquals(
      conflict.headers.get("location"),
      "/account/security?linked=&error=account_conflict",
    );

    const secondState = await signOAuthState(config, {
      provider: "github",
      nonce: "n3",
      redirectTo: "/",
      linkUserId: userId,
    });
    restore();
    const restoreSecond = stubGithubIdentityFetch({ id: 100 });
    try {
      // Host-free getSession returns the newest session; remint the owner so
      // the original cookie is not shadowed by the otherUser row above.
      const { token: ownerAgain } = await createSession(db, userId, {});
      const ownerCookie =
        `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
          ownerAgain,
          secrets,
        )}`;
      const second = await app.request(
        `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
          encodeURIComponent(secondState)
        }`,
        { headers: { cookie: ownerCookie } },
      );
      assertEquals(second.status, 302);
      assertEquals(
        second.headers.get("location"),
        "/account/security?linked=&error=account_conflict",
      );
    } finally {
      restoreSecond();
    }
  } finally {
    restore();
  }
});

test("link callback after sign-out does not mutate accounts", async () => {
  const { app, db, state, secrets } = await buildApp();
  const userId = crypto.randomUUID();
  seedMockCredentialUser(state, {
    id: userId,
    email: "signed-out@example.com",
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  const { token } = await createSession(db, userId, {});
  const cookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;
  const restore = stubGithubIdentityFetch({ id: 77 });
  try {
    const start = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/start?link=1`,
      { headers: { cookie } },
    );
    assertEquals(start.status, 302);
    const authorize = new URL(start.headers.get("location") ?? "");
    const signedState = authorize.searchParams.get("state") ?? "";

    const callback = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(signedState)
      }`,
    );
    assertEquals(callback.status, 302);
    assertEquals(
      callback.headers.get("location"),
      "/account/security?linked=&error=oauth_unauthenticated",
    );
    assertEquals(
      state.accounts.some((row) => row.providerId === "github"),
      false,
    );
  } finally {
    restore();
  }
});

test("link callback rejects a different signed-in user", async () => {
  const { app, db, state, secrets } = await buildApp();
  const ownerId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  seedMockCredentialUser(state, {
    id: ownerId,
    email: "owner-switch@example.com",
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  seedMockCredentialUser(state, {
    id: otherId,
    email: "other-switch@example.com",
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  const { token: ownerToken } = await createSession(db, ownerId, {});
  const ownerCookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    ownerToken,
    secrets,
  )}`;
  const restore = stubGithubIdentityFetch({ id: 88 });
  try {
    // Host-free getSession returns the newest session. Start while the owner
    // session is newest so signed state captures ownerId, then mint the other
    // session so the callback cookie is the live session the mock will read.
    const start = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/start?link=1`,
      { headers: { cookie: ownerCookie } },
    );
    assertEquals(start.status, 302);
    const authorize = new URL(start.headers.get("location") ?? "");
    const signedState = authorize.searchParams.get("state") ?? "";

    const { token: otherToken } = await createSession(db, otherId, {});
    const otherCookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      otherToken,
      secrets,
    )}`;
    const callback = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(signedState)
      }`,
      { headers: { cookie: otherCookie } },
    );
    assertEquals(callback.status, 302);
    assertEquals(
      callback.headers.get("location"),
      "/account/security?linked=&error=oauth_unauthenticated",
    );
    assertEquals(
      state.accounts.some((row) => row.providerId === "github"),
      false,
    );
  } finally {
    restore();
  }
});

test("unlink succeeds when another sign-in method remains; 409 when it is last", async () => {
  const { app, db, state, secrets } = await buildApp();
  const lastUser = crypto.randomUUID();
  seedMockUser(state, {
    id: lastUser,
    email: "only-oauth@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: "user",
  });
  state.accounts.push({
    userId: lastUser,
    password: null,
    providerId: "github",
    providerUserId: "1",
  });
  const { token: lastToken } = await createSession(db, lastUser, {});
  const lastCookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    lastToken,
    secrets,
  )}`;
  const last = await app.request(`${ORIGIN}${AUTH}/oauth/github`, {
    method: "DELETE",
    headers: { cookie: lastCookie, "content-type": "application/json" },
    body: "{}",
  });
  assertEquals(last.status, 409);

  const dualUser = crypto.randomUUID();
  seedMockCredentialUser(state, {
    id: dualUser,
    email: "dual@example.com",
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  state.accounts.push({
    userId: dualUser,
    password: null,
    providerId: "github",
    providerUserId: "2",
  });
  const { token } = await createSession(db, dualUser, {});
  const cookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;
  const unlinked = await app.request(`${ORIGIN}${AUTH}/oauth/github`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assertEquals(unlinked.status, 200);
});

test("unlink succeeds when the remaining sign-in method is a passkey", async () => {
  const { app, db, state, secrets } = await buildApp();
  const userId = crypto.randomUUID();
  seedMockUser(state, {
    id: userId,
    email: "oauth-plus-passkey@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: "user",
  });
  state.accounts.push({
    userId,
    password: null,
    providerId: "github",
    providerUserId: "3",
  });
  state.passkeys.push({
    id: crypto.randomUUID(),
    userId,
    name: "Laptop",
    createdAt: new Date().toISOString(),
    credentialId: "passkey-oauth-unlink",
    publicKey: "pk",
    counter: 0,
    deviceType: "singleDevice",
    isBackedUp: false,
    aaguid: null,
    transports: null,
  });
  const { token } = await createSession(db, userId, {});
  const cookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;
  const unlinked = await app.request(`${ORIGIN}${AUTH}/oauth/github`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assertEquals(unlinked.status, 200);
});

test("callback missing secretsConfig redirects not_configured, never JSON", async () => {
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const state = createEmptyMockAuthState();
  const db = createMockAuthDb(state);
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("platformEnv", GITHUB_ENV);
    c.set("authRateLimiter", limiter);
    return next();
  });
  const client = new Hono<AppEnv>();
  registerAuthRoutes(client, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
    baseUrl: ORIGIN,
  });
  app.route(CLIENT_API_PREFIX, client);

  const res = await app.request(
    `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=x`,
  );
  assertRedirectNotJson(res, "/sign-in?error=not_configured");
  const body = await res.text();
  assertEquals(body.includes('"error"'), false);
});

test("callback missing database redirects database_unavailable, never JSON", async () => {
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("secretsConfig", config);
    c.set("platformEnv", GITHUB_ENV);
    c.set("authRateLimiter", limiter);
    return next();
  });
  const client = new Hono<AppEnv>();
  registerAuthRoutes(client, {
    secrets,
    runtime: "deno",
    signupEnvOverride: undefined,
    baseUrl: ORIGIN,
  });
  app.route(CLIENT_API_PREFIX, client);

  const oauthState = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/",
  });
  const res = await app.request(
    `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
      encodeURIComponent(oauthState)
    }`,
  );
  assertRedirectNotJson(res, "/sign-in?error=database_unavailable");
  const body = await res.text();
  assertEquals(body.includes('"error"'), false);
});

test("callback missing session secrets redirects not_configured", async () => {
  const { app, state, config } = await buildApp({ withSecrets: false });
  const userId = crypto.randomUUID();
  seedMockUser(state, {
    id: userId,
    email: "octocat@example.com",
    isDisabled: false,
    isEmailVerified: true,
    is2FaEnabled: false,
    role: "user",
  });
  state.accounts.push({
    userId,
    password: null,
    providerId: "github",
    providerUserId: "99",
  });
  const oauthState = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/",
  });
  const restore = stubGithubIdentityFetch();
  try {
    const res = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(oauthState)
      }`,
    );
    assertRedirectNotJson(res, "/sign-in?error=not_configured");
  } finally {
    restore();
  }
});

test("callback missing two-factor challenge secrets redirects not_configured", async () => {
  const { app, state, config } = await buildApp({
    withTwoFactorChallengeSecrets: false,
  });
  const userId = crypto.randomUUID();
  seedMockUser(state, {
    id: userId,
    email: "octocat@example.com",
    isDisabled: false,
    isEmailVerified: true,
    is2FaEnabled: true,
    role: "user",
  });
  state.accounts.push({
    userId,
    password: null,
    providerId: "github",
    providerUserId: "99",
  });
  const oauthState = await signOAuthState(config, {
    provider: "github",
    nonce: "n",
    redirectTo: "/",
  });
  const restore = stubGithubIdentityFetch();
  try {
    const res = await app.request(
      `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
        encodeURIComponent(oauthState)
      }`,
    );
    assertRedirectNotJson(res, "/sign-in?error=not_configured");
  } finally {
    restore();
  }
});
