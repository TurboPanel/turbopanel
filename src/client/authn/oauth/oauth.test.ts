import { assertEquals } from "@std/assert";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../../app.ts";
import { getDatabaseUrl } from "../../../db-url.ts";
import { createDenoDb, endDbConnection } from "../../../db.ts";
import { account, passkey, user } from "../../../lib/db/schema.ts";
import { CLIENT_API_PREFIX } from "../../../surfaces.ts";
import { parseTestSecretsConfig } from "../../../test-fixtures/secrets.ts";
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from "../auth-rate-limit.ts";
import { buildSignedCookie, HTTPS_SESSION_COOKIE_NAME } from "../crypto.ts";
import { registerAuthRoutes } from "../http.ts";
import { hashPassword } from "../password.ts";
import { deriveSecretsConfig } from "../secrets.ts";
import { createSession } from "../session-store.ts";
import { signUpFromIdentity } from "./oauth-http.ts";
import { signOAuthState } from "./oauth-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

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
        nonce: "n",
        redirectTo: "/welcome",
      });
      const res = await app.request(
        `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
          encodeURIComponent(state)
        }`,
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
        nonce: "n2",
        redirectTo: "/",
      });
      const res = await app.request(
        `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
          encodeURIComponent(state)
        }`,
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
        { headers: { cookie } },
      );
      assertEquals(linked.status, 302);
      assertEquals(
        linked.headers.get("location"),
        "/account/security?linked=github",
      );

      const secondLinkState = await signOAuthState(config, {
        provider: "github",
        nonce: "n-second",
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
          { headers: { cookie } },
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
          nonce: "n3",
          redirectTo: "/",
          linkUserId: signupUserId,
        });
        const conflict = await app.request(
          `${ORIGIN}${AUTH}/oauth/github/callback?code=ok&state=${
            encodeURIComponent(conflictState)
          }`,
          { headers: { cookie: signupCookie } },
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
