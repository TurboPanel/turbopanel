/**
 * Public GitHub / Google OAuth start + callback (redirect-only) and session
 * unlink. Cookie issuance copies the otp-http sequence; 2FA users get a
 * `tp2fa` challenge redirect. Provider tokens are never persisted.
 */

import { and, eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../../app/app.ts";
import { type Db, getDb } from "../../../db/connection.ts";
import { account, passkey, user } from "../../../db/schema.ts";
import { readBoundedBodyText } from "../../../lib/http/bounded-body.ts";
import { resolvePublicBaseUrl } from "../../../features/install/resolve-public-base-url.ts";
import {
  resolveAuthProviderSettings,
} from "../../../features/settings/auth-provider-settings.ts";
import { CLIENT_API_PREFIX } from "../../../app/surfaces.ts";
import { AUTH_OAUTH_UNLINK_MAX_BODY_BYTES } from "../auth-body-limits.ts";
import {
  buildSignedCookie,
  resolveRequestTls,
  resolveSessionCookieName,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from "../crypto.ts";
import {
  type AuthRouteOpts,
  buildSessionResponse,
  enforceAuthRateLimit,
  resolveClientIp,
} from "../http.ts";
import {
  createOrganizationForUserInTx,
  resolveEffectiveSignupEnabled,
  resolveSignupEnvOverrideFromContext,
} from "../install-state.ts";
import {
  assertRecentAuthOr403,
  isSessionRecentlyAuthenticated,
} from "../reauth.ts";
import {
  createSession,
  deleteOtherSessionsForUser,
  getSession,
  type SessionData,
} from "../session-store.ts";
import { issueTwoFactorChallenge } from "../two-factor.ts";
import {
  isSafeRedirectPath,
  mintPkceVerifier,
  OAUTH_STATE_TTL_MS,
  pkceChallenge,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state.ts";
import {
  isOAuthProviderId,
  type OAuthIdentity,
  OAuthProviderError,
  type OAuthProviderId,
  type ResolvedOAuthProvider,
  resolveOAuthProvider,
} from "./providers.ts";
import type { OAuthStateClaims } from "./oauth-state.ts";
import { isPostgresUniqueViolation } from "../../../db/unique-violation.ts";

const DEFAULT_REDIRECT_TO = "/";

/**
 * Holds the PKCE verifier on the browser that started the flow (see
 * `oauth-state.ts`). `__Host-` on HTTPS so a sibling subdomain cannot plant it.
 */
const OAUTH_FLOW_COOKIE_NAME = "turbopanel.oauth_flow";
const OAUTH_FLOW_COOKIE_NAME_HTTPS = "__Host-turbopanel.oauth_flow";

export function oauthFlowCookieName(isHttps: boolean): string {
  return isHttps ? OAUTH_FLOW_COOKIE_NAME_HTTPS : OAUTH_FLOW_COOKIE_NAME;
}

function requestTls(c: Context<AppEnv>, runtime: "deno" | "workers") {
  return resolveRequestTls({
    requestUrl: c.req.url,
    runtime,
    forwardedProto: c.req.header("x-forwarded-proto"),
  });
}

function buildCookieHeader(
  cookieValue: string,
  maxAge: number,
  cookieName: string,
  isHttps: boolean,
): string {
  let header =
    `${cookieName}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  if (isHttps) {
    header += "; Secure";
  }
  return header;
}

async function readActiveSession(
  c: Context<AppEnv>,
  opts: AuthRouteOpts,
): Promise<SessionData | null> {
  const db = getDb(c);
  const cookieName = resolveSessionCookieName({
    requestUrl: c.req.url,
    runtime: opts.runtime,
    forwardedProto: c.req.header("x-forwarded-proto"),
  });
  const cookieValue = getCookie(c, cookieName) ?? null;

  if (!cookieValue) return null;
  const secrets = opts.secrets;
  if (!secrets) return null;

  const result = await verifySignedCookie(cookieValue, secrets);
  if (!result) return null;

  return getSession(db, result.token);
}

async function readOptionalJsonObject(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const read = await readBoundedBodyText(c, maxBytes);
  if (!read.ok) return { ok: false, response: read.response };
  if (!read.text.trim()) {
    return { ok: true, body: {} };
  }
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      return { ok: true, body: {} };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: c.json({ ok: false, error: "Invalid request" }, 400),
    };
  }
}

function signInErrorRedirect(c: Context<AppEnv>, code: string): Response {
  return c.redirect(`/sign-in?error=${encodeURIComponent(code)}`);
}

function oauthErrorRedirect(
  c: Context<AppEnv>,
  code: string,
  linkUserId?: string,
): Response {
  if (linkUserId) {
    return c.redirect(
      `/account/security?linked=&error=${encodeURIComponent(code)}`,
    );
  }
  return signInErrorRedirect(c, code);
}

function resolveRedirectTo(raw: string | undefined): string {
  if (raw === undefined || raw === "") return DEFAULT_REDIRECT_TO;
  return isSafeRedirectPath(raw) ? raw : DEFAULT_REDIRECT_TO;
}

function callbackRedirectUri(
  baseUrl: string,
  provider: OAuthProviderId,
): string {
  return `${baseUrl}${CLIENT_API_PREFIX}/auth/oauth/${provider}/callback`;
}

async function issueSessionCookieRedirect(
  c: Context<AppEnv>,
  opts: AuthRouteOpts,
  db: Db,
  userId: string,
  redirectTo: string,
): Promise<Response> {
  const secrets = opts.secrets;
  if (!secrets) {
    return signInErrorRedirect(c, "not_configured");
  }

  const { token } = await createSession(db, userId, {
    ipAddress: resolveClientIp(c, opts.runtime) ?? undefined,
    userAgent: c.req.header("User-Agent") ?? undefined,
  });
  const cookieValue = await buildSignedCookie(token, secrets);
  const tls = requestTls(c, opts.runtime);
  const setCookieHeader = buildCookieHeader(
    cookieValue,
    SESSION_EXPIRES_IN_MS / 1000,
    tls.cookieName,
    tls.isHttps,
  );
  const sessionData = await getSession(db, token);
  if (!sessionData) {
    throw new Error("Session creation failed");
  }
  await buildSessionResponse(db, opts.runtime, sessionData);

  c.header("Set-Cookie", setCookieHeader, { append: true });
  return c.redirect(redirectTo);
}

type AccountProviderRow = {
  userId: string;
  providerId: string;
  providerUserId: string;
};

async function listUserAccounts(
  db: Db,
  userId: string,
): Promise<AccountProviderRow[]> {
  const rows = await db
    .select({
      userId: account.userId,
      providerId: account.providerId,
      providerUserId: account.providerUserId,
    })
    .from(account)
    .where(eq(account.userId, userId));
  return rows.filter((row) => row.userId === userId);
}

async function hasRemainingSignInMethod(
  db: Db,
  userId: string,
  exceptProvider: OAuthProviderId,
): Promise<boolean> {
  const [accounts, passkeyRows] = await Promise.all([
    listUserAccounts(db, userId),
    db
      .select({ userId: passkey.userId })
      .from(passkey)
      .where(eq(passkey.userId, userId)),
  ]);
  if (accounts.some((row) => row.providerId !== exceptProvider)) {
    return true;
  }
  return passkeyRows.some((row) => row.userId === userId);
}

async function linkProviderAccount(
  db: Db,
  userId: string,
  provider: OAuthProviderId,
  identity: OAuthIdentity,
): Promise<"ok" | "conflict"> {
  const existing = await listUserAccounts(db, userId);
  const sameProvider = existing.find((row) => row.providerId === provider);
  if (sameProvider) {
    if (sameProvider.providerUserId === identity.providerUserId) return "ok";
    return "conflict";
  }

  const matched = await loadMatchedUser(
    db,
    provider,
    identity.providerUserId,
  );
  if (matched.kind === "user") {
    if (matched.userId === userId) return "ok";
    return "conflict";
  }
  try {
    await db.insert(account).values({
      userId,
      providerId: provider,
      providerUserId: identity.providerUserId,
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    return "ok";
  } catch (err) {
    if (isPostgresUniqueViolation(err)) return "conflict";
    throw err;
  }
}

export async function signUpFromIdentity(
  db: Db,
  provider: OAuthProviderId,
  identity: OAuthIdentity,
): Promise<"conflict" | { userId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const email = identity.email.trim().toLowerCase();
      const name = identity.name?.trim() || null;
      const inserted = await tx
        .insert(user)
        .values({
          email,
          ...(name ? { name } : {}),
          isEmailVerified: identity.emailVerified,
          role: "user",
        })
        .returning({ id: user.id });
      const userId = inserted[0]?.id;
      if (!userId) {
        throw new Error("OAuth user creation failed");
      }
      await tx.insert(account).values({
        userId,
        providerId: provider,
        providerUserId: identity.providerUserId,
        accessToken: null,
        refreshToken: null,
        idToken: null,
      });
      await createOrganizationForUserInTx(tx, userId);
      return { userId };
    });
  } catch (err) {
    if (isPostgresUniqueViolation(err)) return "conflict";
    throw err;
  }
}

async function loadMatchedUser(
  db: Db,
  provider: OAuthProviderId,
  providerUserId: string,
): Promise<
  | { kind: "none" }
  | {
    kind: "user";
    userId: string;
    isDisabled: boolean;
    is2FaEnabled: boolean;
  }
> {
  const accounts = await db
    .select({
      userId: account.userId,
      providerId: account.providerId,
      providerUserId: account.providerUserId,
    })
    .from(account)
    .where(
      and(
        eq(account.providerId, provider),
        eq(account.providerUserId, providerUserId),
      ),
    );
  const acct = accounts.find((row) =>
    row.providerId === provider && row.providerUserId === providerUserId
  );
  if (!acct) return { kind: "none" };

  const users = await db
    .select({
      id: user.id,
      isDisabled: user.isDisabled,
      is2FaEnabled: user.is2FaEnabled,
    })
    .from(user)
    .where(eq(user.id, acct.userId));
  const row = users.find((entry) => entry.id === acct.userId);
  if (!row) return { kind: "none" };
  return {
    kind: "user",
    userId: acct.userId,
    isDisabled: row.isDisabled,
    is2FaEnabled: row.is2FaEnabled,
  };
}

type MatchedUser = Extract<
  Awaited<ReturnType<typeof loadMatchedUser>>,
  { kind: "user" }
>;

async function exchangeOAuthIdentity(
  c: Context<AppEnv>,
  provider: ResolvedOAuthProvider,
  code: string,
  codeVerifier: string,
): Promise<OAuthIdentity | Response> {
  try {
    const { accessToken } = await provider.exchangeCode(code, codeVerifier);
    return await provider.fetchIdentity(accessToken);
  } catch (err) {
    if (err instanceof OAuthProviderError) {
      return signInErrorRedirect(c, "oauth_exchange_failed");
    }
    throw err;
  }
}

async function handleOAuthAccountLink(
  c: Context<AppEnv>,
  opts: AuthRouteOpts,
  db: Db,
  linkUserId: string,
  providerParam: OAuthProviderId,
  identity: OAuthIdentity,
): Promise<Response> {
  const sessionData = await readActiveSession(c, opts);
  if (sessionData?.userId !== linkUserId) {
    return oauthErrorRedirect(c, "oauth_unauthenticated", linkUserId);
  }
  const linked = await linkProviderAccount(
    db,
    linkUserId,
    providerParam,
    identity,
  );
  if (linked === "conflict") {
    return c.redirect("/account/security?linked=&error=account_conflict");
  }
  // A new way into the account: every other outstanding session goes, so a
  // session compromised beforehand cannot outlive the change.
  await deleteOtherSessionsForUser(db, linkUserId, sessionData.sessionId);
  return c.redirect(
    `/account/security?linked=${encodeURIComponent(providerParam)}`,
  );
}

async function completeExistingUserSignIn(
  c: Context<AppEnv>,
  opts: AuthRouteOpts,
  db: Db,
  matched: MatchedUser,
  redirectTo: string,
): Promise<Response> {
  if (matched.isDisabled) {
    return signInErrorRedirect(c, "account_disabled");
  }
  if (matched.is2FaEnabled) {
    if (!opts.twoFactorChallengeSecrets) {
      return signInErrorRedirect(c, "not_configured");
    }
    const challenge = await issueTwoFactorChallenge(
      db,
      opts.twoFactorChallengeSecrets,
      matched.userId,
    );
    return c.redirect(
      `/sign-in?challenge=${encodeURIComponent(challenge)}`,
    );
  }
  return await issueSessionCookieRedirect(
    c,
    opts,
    db,
    matched.userId,
    redirectTo,
  );
}

async function completeOAuthSignup(
  c: Context<AppEnv>,
  opts: AuthRouteOpts,
  db: Db,
  providerParam: OAuthProviderId,
  identity: OAuthIdentity,
  claims: OAuthStateClaims,
): Promise<Response> {
  const signupEnabled = await resolveEffectiveSignupEnabled(
    db,
    opts.runtime,
    resolveSignupEnvOverrideFromContext(
      c.get("platformEnv"),
      opts.signupEnvOverride,
    ),
  );
  if (!signupEnabled) {
    return signInErrorRedirect(c, "oauth_signup_disabled");
  }
  // A new account takes the provider's email as its own. Only a provider-
  // verified address may do that (GitHub already returns only a verified
  // primary; Google reports `email_verified`).
  if (!identity.emailVerified) {
    return signInErrorRedirect(c, "oauth_email_unverified");
  }

  const created = await signUpFromIdentity(db, providerParam, identity);
  if (created === "conflict") {
    return signInErrorRedirect(c, "account_conflict");
  }
  return await issueSessionCookieRedirect(
    c,
    opts,
    db,
    created.userId,
    claims.redirectTo,
  );
}

export function registerOAuthRoutes(
  auth: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  auth.get("/oauth/:provider/start", async (c) => {
    const limited = await enforceAuthRateLimit(
      c,
      "oauth-start",
      null,
      opts.runtime,
    );
    if (limited) return limited;

    const providerParam = c.req.param("provider");
    if (!isOAuthProviderId(providerParam)) {
      return c.json({ ok: false, error: "Not found" }, 404);
    }

    const db = getDb(c);
    const platformEnv = c.get("platformEnv") ?? {};
    const resolved = await resolveAuthProviderSettings(
      db,
      platformEnv,
      c.get("dataEncryptionSecrets"),
    );
    const credentials = providerParam === "github"
      ? resolved.github
      : resolved.google;
    if (!credentials) {
      return c.json({ ok: false, error: "Not found" }, 404);
    }

    const secretsConfig = c.get("secretsConfig");
    if (!secretsConfig) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    let linkUserId: string | undefined;
    if (c.req.query("link") === "1") {
      const sessionData = await readActiveSession(c, opts);
      if (!sessionData) {
        return signInErrorRedirect(c, "oauth_unauthenticated");
      }
      // Linking a provider adds a permanent way into the account, the same
      // as registering a passkey or enrolling 2FA — and those require a
      // step-up. This redirect is a browser GET with no body to resubmit a
      // password in, so the session half of the step-up is what applies:
      // a session older than the window must sign in again first, which
      // stops a hijacked long-lived session from planting a sign-in method.
      if (!isSessionRecentlyAuthenticated(sessionData)) {
        return c.redirect(
          "/account/security?linked=&error=oauth_reauth_required",
        );
      }
      linkUserId = sessionData.userId;
    }

    const redirectTo = resolveRedirectTo(c.req.query("redirectTo"));
    const codeVerifier = mintPkceVerifier();
    const codeChallenge = await pkceChallenge(codeVerifier);
    const state = await signOAuthState(secretsConfig, {
      provider: providerParam,
      nonce: codeChallenge,
      redirectTo,
      ...(linkUserId ? { linkUserId } : {}),
    });
    const tls = requestTls(c, opts.runtime);
    c.header(
      "Set-Cookie",
      buildCookieHeader(
        codeVerifier,
        OAUTH_STATE_TTL_MS / 1000,
        oauthFlowCookieName(tls.isHttps),
        tls.isHttps,
      ),
      { append: true },
    );

    const baseUrl = await resolvePublicBaseUrl(c, { baseUrl: opts.baseUrl });
    const provider = resolveOAuthProvider(providerParam, {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri: callbackRedirectUri(baseUrl, providerParam),
    });
    return c.redirect(provider.buildAuthorizeUrl(state, codeChallenge));
  });

  auth.get("/oauth/:provider/callback", async (c) => {
    const limited = await enforceAuthRateLimit(
      c,
      "oauth-callback",
      null,
      opts.runtime,
    );
    if (limited) return limited;

    // Single use: whatever happens next, the starting browser's verifier goes.
    const tls = requestTls(c, opts.runtime);
    const flowCookieName = oauthFlowCookieName(tls.isHttps);
    const codeVerifier = getCookie(c, flowCookieName) ?? "";
    c.header(
      "Set-Cookie",
      buildCookieHeader("", 0, flowCookieName, tls.isHttps),
      { append: true },
    );

    const providerParam = c.req.param("provider");
    if (!isOAuthProviderId(providerParam)) {
      return signInErrorRedirect(c, "oauth_state_invalid");
    }

    const secretsConfig = c.get("secretsConfig");
    if (!secretsConfig) {
      return signInErrorRedirect(c, "not_configured");
    }

    const stateParam = c.req.query("state") ?? "";
    const claims = await verifyOAuthState(secretsConfig, stateParam);
    if (claims?.provider !== providerParam) {
      return signInErrorRedirect(c, "oauth_state_invalid");
    }
    // Bound to the browser that started the flow: its cookie's verifier must
    // hash to the challenge signed into the state (login-CSRF defence).
    if (
      codeVerifier.length === 0 ||
      await pkceChallenge(codeVerifier) !== claims.nonce
    ) {
      return signInErrorRedirect(c, "oauth_state_invalid");
    }

    const code = c.req.query("code") ?? "";
    if (code.length === 0) {
      return signInErrorRedirect(c, "oauth_exchange_failed");
    }

    const db = getDb(c);
    if (db === undefined) {
      return oauthErrorRedirect(c, "database_unavailable", claims.linkUserId);
    }

    const platformEnv = c.get("platformEnv") ?? {};
    const resolved = await resolveAuthProviderSettings(
      db,
      platformEnv,
      c.get("dataEncryptionSecrets"),
    );
    const credentials = providerParam === "github"
      ? resolved.github
      : resolved.google;
    if (!credentials) {
      return signInErrorRedirect(c, "oauth_exchange_failed");
    }

    const baseUrl = await resolvePublicBaseUrl(c, { baseUrl: opts.baseUrl });
    const provider = resolveOAuthProvider(providerParam, {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri: callbackRedirectUri(baseUrl, providerParam),
    });

    const identityResult = await exchangeOAuthIdentity(
      c,
      provider,
      code,
      codeVerifier,
    );
    if (identityResult instanceof Response) return identityResult;
    const identity = identityResult;

    if (claims.linkUserId) {
      return await handleOAuthAccountLink(
        c,
        opts,
        db,
        claims.linkUserId,
        providerParam,
        identity,
      );
    }

    const matched = await loadMatchedUser(
      db,
      providerParam,
      identity.providerUserId,
    );
    if (matched.kind === "user") {
      return await completeExistingUserSignIn(
        c,
        opts,
        db,
        matched,
        claims.redirectTo,
      );
    }

    return await completeOAuthSignup(
      c,
      opts,
      db,
      providerParam,
      identity,
      claims,
    );
  });

  auth.delete("/oauth/:provider", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const providerParam = c.req.param("provider");
    if (!isOAuthProviderId(providerParam)) {
      return c.json({ ok: false, error: "Not found" }, 404);
    }

    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }

    const bodyRead = await readOptionalJsonObject(
      c,
      AUTH_OAUTH_UNLINK_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const reauth = await assertRecentAuthOr403(c, sessionData, bodyRead.body);
    if (reauth) return reauth;

    const canUnlink = await hasRemainingSignInMethod(
      db,
      sessionData.userId,
      providerParam,
    );
    if (!canUnlink) {
      return c.json({ ok: false, error: "last_sign_in_method" }, 409);
    }

    const deleted = await db
      .delete(account)
      .where(
        and(
          eq(account.userId, sessionData.userId),
          eq(account.providerId, providerParam),
        ),
      )
      .returning({ id: account.id });
    if (deleted.length === 0) {
      return c.json({ ok: false, error: "Not found" }, 404);
    }
    // A sign-in method changed: every other session goes with it.
    await deleteOtherSessionsForUser(
      db,
      sessionData.userId,
      sessionData.sessionId,
    );
    return c.json({ ok: true }, 200);
  });
}
