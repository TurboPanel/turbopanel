import { assertEquals } from "@std/assert";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../../app/app.ts";
import { getDatabaseUrl } from "../../../db/url.ts";
import { createDenoDb, endDbConnection } from "../../../db/connection.ts";
import { account, passkey, user } from "../../../db/schema.ts";
import { CLIENT_API_PREFIX } from "../../../app/surfaces.ts";
import { parseTestSecretsConfig } from "../../../test-fixtures/secrets.ts";
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from "../auth-rate-limit.ts";
import { buildSignedCookie, HTTPS_SESSION_COOKIE_NAME } from "../crypto.ts";
import { registerAuthRoutes } from "../http.ts";
import { hashPassword } from "../../../lib/secrets/password.ts";
import { deriveSecretsConfig } from "../../../lib/secrets/secrets.ts";
import { createSession } from "../session-store.ts";
import { oauthFlowCookieName, signUpFromIdentity } from "./oauth-http.ts";
import {
  pkceChallenge,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state.ts";
import { encodeBase64Url } from "@std/encoding/base64url";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The cookie `/start` leaves on the browser that began a flow. A test that
 * signs its own state must sign {@link FLOW_NONCE} (the verifier's S256
 * challenge) and present this cookie on the callback, as a real browser does.
 */
const FLOW_VERIFIER = "test-only-pkce-verifier-0123456789-abcdefghijklmn";
const FLOW_NONCE = await pkceChallenge(FLOW_VERIFIER);
const FLOW_COOKIE = `${oauthFlowCookieName(true)}=${FLOW_VERIFIER}`;

/** The flow cookie a real `GET /start` response set. */
function flowCookieFrom(start: Response): string {
  const line = start.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${oauthFlowCookieName(true)}=`));
  if (!line) throw new TypeError("/start set no OAuth flow cookie");
  return line.split(";")[0]!;
}

/**
 * Callback request init carrying the flow cookie — the fixed test one, or the
 * one `start` set when the state came from a real `/start` — plus any other
 * cookies (e.g. the session).
 */
function withFlowCookie(otherCookies?: string, start?: Response): RequestInit {
  const flow = start ? flowCookieFrom(start) : FLOW_COOKIE;
  return {
    headers: { cookie: otherCookies ? `${otherCookies}; ${flow}` : flow },
  };
}

const AUTH = `${CLIENT_API_PREFIX}/auth`;
const ORIGIN = "https://panel.example.com";
const GITHUB_ENV = {
  TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID: "gh-client",
  TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET: "gh-secret",
};

const dbUrl = getDatabaseUrl();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubGithubFetch(identity: { id: number; email: string }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return Promise.resolve(jsonResponse({ access_token: "gho_test" }));
    }
    if (url.endsWith("/user") && !url.includes("emails")) {
      return Promise.resolve(jsonResponse({
        id: identity.id,
        login: "octocat",
        name: "Octo",
      }));
    }
    if (url.includes("/user/emails")) {
      return Promise.resolve(jsonResponse([
        { email: identity.email, primary: true, verified: true },
      ]));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("Postgres OAuth signup, login, link, unlink, and unique conflict", async () => {
  if (!dbUrl) {
    console.warn("Skipping OAuth DB test: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
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
    secrets,
    runtime: "deno",
    signupEnvOverride: "1",
    baseUrl: ORIGIN,
  });
  app.route(CLIENT_API_PREFIX, client);

  const suffix = crypto.randomUUID();
  const signupEmail = `oauth-signup-${suffix}@example.com`;
  const existingEmail = `oauth-existing-${suffix}@example.com`;
  const githubId = Math.floor(Math.random() * 1_000_000_000);
  const createdIds: string[] = [];

  try {
    const restoreSignup = stubGithubFetch({
      id: githubId,
      email: signupEmail,
    });
    try {
      const state = await signOAuthState(config, {
        provider: "github",
        nonce: FLOW_NONCE,
        redirectTo: "/welcome",
      });
      const res = await app.request(
        `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
          encodeURIComponent(state)
        }`,
      withFlowCookie(),
    );
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/welcome");
      assertEquals(
        (res.headers.get("set-cookie") ?? "").includes(
          HTTPS_SESSION_COOKIE_NAME,
        ),
        true,
      );
    } finally {
      restoreSignup();
    }

    const [created] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, signupEmail))
      .limit(1);
    const signupUserId = created?.id;
    if (signupUserId) createdIds.push(signupUserId);

    const [signupAccount] = await db
      .select({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
        providerId: account.providerId,
      })
      .from(account)
      .where(eq(account.userId, signupUserId!))
      .limit(1);
    assertEquals(signupAccount?.providerId, "github");
    assertEquals(signupAccount?.accessToken, null);
    assertEquals(signupAccount?.refreshToken, null);
    assertEquals(signupAccount?.idToken, null);

    const { token: signupToken } = await createSession(db, signupUserId!, {});
    const signupCookie =
      `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
        signupToken,
        secrets,
      )}`;
    const lastMethod = await app.request(`${ORIGIN}${AUTH}/oauth/github`, {
      method: "DELETE",
      headers: { cookie: signupCookie, "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(lastMethod.status, 409);

    await db.insert(passkey).values({
      userId: signupUserId!,
      publicKey: "oauth-test-public-key",
      credentialId: `oauth-passkey-${suffix}`,
      deviceType: "singleDevice",
      isBackedUp: false,
    });
    const passkeyUnlink = await app.request(`${ORIGIN}${AUTH}/oauth/github`, {
      method: "DELETE",
      headers: { cookie: signupCookie, "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(passkeyUnlink.status, 200);

    const [existing] = await db
      .insert(user)
      .values({
        email: existingEmail,
        isEmailVerified: true,
        role: "user",
      })
      .returning({ id: user.id });
    const existingId = existing!.id;
    createdIds.push(existingId);
    await db.insert(account).values({
      userId: existingId,
      providerId: "github",
      providerUserId: String(githubId + 1),
    });

    const restoreLogin = stubGithubFetch({
      id: githubId + 1,
      email: existingEmail,
    });
    try {
      const state = await signOAuthState(config, {
        provider: "github",
        nonce: FLOW_NONCE,
        redirectTo: "/",
      });
      const res = await app.request(
        `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
          encodeURIComponent(state)
        }`,
      withFlowCookie(),
    );
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/");
    } finally {
      restoreLogin();
    }

    await db.insert(account).values({
      userId: existingId,
      providerId: "credential",
      providerUserId: existingId,
      password: await hashPassword("Sup3r-secret!"),
    });

    const { token } = await createSession(db, existingId, {});
    const cookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      token,
      secrets,
    )}`;

    const unlinkOk = await app.request(`${ORIGIN}${AUTH}/oauth/github`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ password: "Sup3r-secret!" }),
    });
    assertEquals(unlinkOk.status, 200);

    const restoreLink = stubGithubFetch({
      id: githubId + 1,
      email: existingEmail,
    });
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
        withFlowCookie(cookie, start),
      );
      assertEquals(linked.status, 302);
      assertEquals(
        linked.headers.get("location"),
        "/account/security?linked=github",
      );

      const secondLinkState = await signOAuthState(config, {
        provider: "github",
        nonce: FLOW_NONCE,
        redirectTo: "/",
        linkUserId: existingId,
      });
      restoreLink();
      const restoreSecondLink = stubGithubFetch({
        id: githubId + 2,
        email: existingEmail,
      });
      try {
        const secondLink = await app.request(
          `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
            encodeURIComponent(secondLinkState)
          }`,
          withFlowCookie(cookie),
        );
        assertEquals(secondLink.status, 302);
        assertEquals(
          secondLink.headers.get("location"),
          "/account/security?linked=&error=account_conflict",
        );
      } finally {
        restoreSecondLink();
      }

      const restoreConflict = stubGithubFetch({
        id: githubId + 1,
        email: existingEmail,
      });
      try {
        const conflictState = await signOAuthState(config, {
          provider: "github",
          nonce: FLOW_NONCE,
          redirectTo: "/",
          linkUserId: signupUserId,
        });
        const conflict = await app.request(
          `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
            encodeURIComponent(conflictState)
          }`,
          withFlowCookie(signupCookie),
        );
        assertEquals(conflict.status, 302);
        assertEquals(
          conflict.headers.get("location"),
          "/account/security?linked=&error=account_conflict",
        );
      } finally {
        restoreConflict();
      }
    } finally {
      restoreLink();
    }
  } finally {
    for (const id of createdIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    await endDbConnection(db);
  }
});

async function hasAccountProviderUserConstraint(
  db: ReturnType<typeof createDenoDb>,
): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 as present from pg_constraint where conname = 'uniq_account_provider_user' limit 1`,
  );
  if (Array.isArray(result)) return result.length > 0;
  const rows = (result as { rows?: unknown[] }).rows;
  return Array.isArray(rows) && rows.length > 0;
}

test("Postgres OAuth signup account-conflict race does not leave a user row", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping OAuth signup race test: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  if (!await hasAccountProviderUserConstraint(db)) {
    console.warn(
      "Skipping OAuth signup race test: uniq_account_provider_user is not present",
    );
    await endDbConnection(db);
    return;
  }

  const suffix = crypto.randomUUID();
  const emailA = `oauth-race-a-${suffix}@example.com`;
  const emailB = `oauth-race-b-${suffix}@example.com`;
  const githubId = String(Math.floor(Math.random() * 1_000_000_000));

  try {
    const [first, second] = await Promise.all([
      signUpFromIdentity(db, "github", {
        providerUserId: githubId,
        email: emailA,
        emailVerified: true,
        name: "Race A",
      }),
      signUpFromIdentity(db, "github", {
        providerUserId: githubId,
        email: emailB,
        emailVerified: true,
        name: "Race B",
      }),
    ]);
    const kinds = [first, second]
      .map((row) => row === "conflict" ? "conflict" : "created")
      .sort((a, b) => a.localeCompare(b));
    assertEquals(kinds, ["conflict", "created"]);

    const leftover = await db
      .select({ email: user.email })
      .from(user)
      .where(inArray(user.email, [emailA, emailB]));
    assertEquals(leftover.length, 1);
  } finally {
    const created = await db
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.email, [emailA, emailB]));
    for (const row of created) {
      await db.delete(user).where(eq(user.id, row.id));
    }
    await endDbConnection(db);
  }
});

// --- Hostile cases (audit A2, A3, A4) — real Postgres and the real routes.

const GOOGLE_ENV = {
  TURBOPANEL_AUTH_PROVIDERS__GOOGLE_CLIENT_ID: "google-client",
  TURBOPANEL_AUTH_PROVIDERS__GOOGLE_CLIENT_SECRET: "google-secret",
};

type ProviderCall = { url: string; body: string };

/**
 * Stub both providers' token + identity endpoints and record every call, so a
 * test can assert what the instance actually sent (e.g. the PKCE verifier).
 */
function stubProviders(identity: {
  githubId?: number;
  googleSub?: string;
  email: string;
  emailVerified?: boolean;
}): { calls: ProviderCall[]; restore: () => void } {
  const calls: ProviderCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("/login/oauth/access_token")) {
      return jsonResponse({ access_token: "gho_test" });
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "ya29_test" });
    }
    if (url.endsWith("api.github.com/user")) {
      return jsonResponse({ id: identity.githubId, login: "octocat" });
    }
    if (url.includes("/user/emails")) {
      return jsonResponse([
        { email: identity.email, primary: true, verified: true },
      ]);
    }
    if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
      return jsonResponse({
        sub: identity.googleSub,
        email: identity.email,
        email_verified: identity.emailVerified ?? true,
        name: "Hostile Test",
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function withOAuthApp(
  label: string,
  platformEnv: Record<string, string>,
  fn: (ctx: {
    app: Hono<AppEnv>;
    db: ReturnType<typeof createDenoDb>;
    config: ReturnType<typeof parseTestSecretsConfig>;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(`Skipping ${label}: TURBOPANEL_DATABASE_URL not set`);
    return;
  }
  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("secretsConfig", config);
    c.set("platformEnv", platformEnv);
    c.set("authRateLimiter", limiter);
    return next();
  });
  const client = new Hono<AppEnv>();
  registerAuthRoutes(client, {
    secrets,
    runtime: "deno",
    signupEnvOverride: "1",
    baseUrl: ORIGIN,
  });
  app.route(CLIENT_API_PREFIX, client);
  try {
    await fn({ app, db, config });
  } finally {
    setSharedAuthRateLimiterForTests(undefined);
    await endDbConnection(db);
  }
}

/** What a browser holds after `GET /start`: the provider URL and any cookies. */
async function startFlow(
  app: Hono<AppEnv>,
  provider: "github" | "google",
  query = "",
): Promise<{ authorize: URL; state: string; cookie: string }> {
  const res = await app.request(
    `${ORIGIN}${AUTH}/oauth/${provider}/start${query}`,
  );
  assertEquals(res.status, 302);
  const authorize = new URL(res.headers.get("location") ?? "");
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]!)
    .join("; ");
  return { authorize, state: authorize.searchParams.get("state") ?? "", cookie };
}

function callbackUrl(provider: "github" | "google", state: string): string {
  return `${ORIGIN}${AUTH}/oauth/${provider}/callback?code=ok&state=${
    encodeURIComponent(state)
  }`;
}

async function deleteUsersByEmail(
  db: ReturnType<typeof createDenoDb>,
  email: string,
): Promise<number> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  for (const row of rows) {
    await db.delete(account).where(eq(account.userId, row.id));
    await db.delete(user).where(eq(user.id, row.id));
  }
  return rows.length;
}

test("A2: /start never signs a redirectTo a browser would send off-site", async () => {
  await withOAuthApp("oauth-a2", GITHUB_ENV, async ({ app, config }) => {
    const hostile = [
      "/\t/evil.com", // browsers strip TAB: "//evil.com"
      "/%09/evil.com", // the same, one encoding deeper
      "/\u000b/evil.com",
      "/\u0000/evil.com",
      "/%5C/evil.com", // "/\\/evil.com" once decoded
    ];
    for (const redirectTo of hostile) {
      const { state } = await startFlow(
        app,
        "github",
        `?redirectTo=${encodeURIComponent(redirectTo)}`,
      );
      const claims = await verifyOAuthState(config, state);
      assertEquals(
        claims?.redirectTo,
        "/",
        `redirectTo ${JSON.stringify(redirectTo)} survived into state`,
      );
    }
    // An ordinary same-origin path still goes through.
    const { state } = await startFlow(app, "github", "?redirectTo=%2Fservers");
    assertEquals((await verifyOAuthState(config, state))?.redirectTo, "/servers");
  });
});

test("A3: a callback without the browser that started the flow signs nobody in", async () => {
  await withOAuthApp("oauth-a3-csrf", GITHUB_ENV, async ({ app, db }) => {
    const email = `oauth-csrf-${crypto.randomUUID()}@example.com`;
    const stub = stubProviders({
      githubId: Math.floor(Math.random() * 1_000_000_000),
      email,
    });
    try {
      // The attacker starts a flow in their own browser and hands the
      // victim a link carrying the attacker's state and code.
      const attacker = await startFlow(app, "github");
      const victim = await app.request(callbackUrl("github", attacker.state));
      assertEquals(victim.status, 302);
      assertEquals(
        victim.headers.get("location"),
        "/sign-in?error=oauth_state_invalid",
      );
      assertEquals(
        (victim.headers.get("set-cookie") ?? "").includes(
          HTTPS_SESSION_COOKIE_NAME,
        ),
        false,
      );
      assertEquals(await deleteUsersByEmail(db, email), 0);
    } finally {
      stub.restore();
      await deleteUsersByEmail(db, email);
    }
  });
});

test("A3: the token exchange proves possession of the PKCE verifier (S256)", async () => {
  await withOAuthApp("oauth-a3-pkce", GITHUB_ENV, async ({ app, db }) => {
    const email = `oauth-pkce-${crypto.randomUUID()}@example.com`;
    const stub = stubProviders({
      githubId: Math.floor(Math.random() * 1_000_000_000),
      email,
    });
    try {
      const flow = await startFlow(app, "github");
      assertEquals(
        flow.authorize.searchParams.get("code_challenge_method"),
        "S256",
      );
      const challenge = flow.authorize.searchParams.get("code_challenge");
      assertEquals(typeof challenge === "string" && challenge.length >= 43, true);

      const res = await app.request(callbackUrl("github", flow.state), {
        headers: { cookie: flow.cookie },
      });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/");

      const tokenCall = stub.calls.find((call) =>
        call.url.includes("/login/oauth/access_token")
      );
      const verifier = new URLSearchParams(tokenCall?.body ?? "").get(
        "code_verifier",
      );
      assertEquals(typeof verifier === "string" && verifier.length >= 43, true);
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier!),
        ),
      );
      assertEquals(encodeBase64Url(digest), challenge);
    } finally {
      stub.restore();
      await deleteUsersByEmail(db, email);
    }
  });
});

test("A4: Google sign-up with an unverified email is refused", async () => {
  await withOAuthApp("oauth-a4", GOOGLE_ENV, async ({ app, db }) => {
    const email = `oauth-unverified-${crypto.randomUUID()}@example.com`;
    const stub = stubProviders({
      googleSub: `google-${crypto.randomUUID()}`,
      email,
      emailVerified: false,
    });
    try {
      const flow = await startFlow(app, "google");
      const res = await app.request(callbackUrl("google", flow.state), {
        headers: { cookie: flow.cookie },
      });
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        "/sign-in?error=oauth_email_unverified",
      );
      assertEquals(await deleteUsersByEmail(db, email), 0);
    } finally {
      stub.restore();
      await deleteUsersByEmail(db, email);
    }
  });
});
