import { eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app/app.ts";
import { getDb } from "../../db/connection.ts";
import { user } from "../../db/schema.ts";
import { readBoundedBodyText } from "../../lib/http/bounded-body.ts";
import { AUTH_RATE_LIMIT_IDENTITY_MAX_CHARS } from "./auth-rate-limit.ts";
import {
  AUTH_SIGN_IN_2FA_MAX_BODY_BYTES,
  AUTH_TWO_FACTOR_MAX_BODY_BYTES,
  MAX_AUTH_OTP_CHARS,
} from "./auth-body-limits.ts";
import {
  buildSignedCookie,
  resolveRequestTls,
  resolveSessionCookieName,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from "./crypto.ts";
import {
  type AuthBodyValidation,
  type AuthRouteOpts,
  buildSessionResponse,
  readGatedAuthJsonBody,
  resolveClientIp,
} from "./http.ts";
import { assertRecentAuthOr403 } from "./reauth.ts";
import {
  createSession,
  deleteOtherSessionsForUser,
  getSession,
  type SessionData,
} from "./session-store.ts";
import {
  BACKUP_CODE_LENGTH,
  disableTwoFactor,
  enrollTotp,
  getTwoFactorStatus,
  InvalidTotpError,
  regenerateBackupCodes,
  TwoFactorEnabledError,
  TwoFactorNotEnrolledError,
  verifyTotpEnrollment,
  verifyTwoFactorSignIn,
} from "./two-factor.ts";

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

function mapTwoFactorMutationError(
  c: Context<AppEnv>,
  err: unknown,
): Response | null {
  if (err instanceof TwoFactorEnabledError) {
    return c.json({ ok: false, error: "two_factor_enabled" }, 409);
  }
  if (err instanceof TwoFactorNotEnrolledError) {
    return c.json({ ok: false, error: "Not enrolled" }, 400);
  }
  if (err instanceof InvalidTotpError) {
    return c.json({ ok: false, error: "Invalid code" }, 400);
  }
  return null;
}

function parseTotpCodeBody(
  body: Record<string, unknown>,
): AuthBodyValidation<{ code: string }> {
  if (typeof body.code !== "string" || body.code.length === 0) {
    return { ok: false, error: "Invalid request" };
  }
  if (body.code.length > MAX_AUTH_OTP_CHARS) {
    return { ok: false, error: "Invalid request" };
  }
  return { ok: true, value: { code: body.code } };
}

type SignIn2faBody =
  | { challenge: string; code: string }
  | { challenge: string; backupCode: string };

function parseSignIn2faBody(body: unknown): AuthBodyValidation<SignIn2faBody> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request" };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.challenge !== "string" || record.challenge.length === 0) {
    return { ok: false, error: "Invalid request" };
  }

  const hasCode = typeof record.code === "string" && record.code.length > 0;
  const hasBackup = typeof record.backupCode === "string" &&
    record.backupCode.length > 0;
  if (hasCode === hasBackup) {
    return { ok: false, error: "Invalid request" };
  }

  if (hasCode) {
    const code = record.code as string;
    if (code.length > MAX_AUTH_OTP_CHARS) {
      return { ok: false, error: "Invalid request" };
    }
    return { ok: true, value: { challenge: record.challenge, code } };
  }

  const backupCode = record.backupCode as string;
  if (backupCode.length > BACKUP_CODE_LENGTH + 8) {
    return { ok: false, error: "Invalid request" };
  }
  return { ok: true, value: { challenge: record.challenge, backupCode } };
}

function mapSignIn2faFailure(
  c: Context<AppEnv>,
  result: {
    status: "invalid" | "expired" | "too_many_attempts" | "ok";
    userId?: string;
  },
): Response {
  if (result.status === "too_many_attempts") {
    return c.json({ ok: false, error: "Too many attempts" }, 429);
  }
  // HMAC-invalid / expired challenges carry no trusted userId.
  if (result.status === "expired" || result.userId === undefined) {
    return c.json({ ok: false, error: "Invalid or expired challenge" }, 400);
  }
  return c.json({ ok: false, error: "Invalid code" }, 400);
}

export function registerTwoFactorRoutes(
  auth: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  auth.get("/2fa", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const status = await getTwoFactorStatus(db, sessionData.userId);
    return c.json(status, 200);
  });

  auth.post("/2fa/totp/enroll", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const bodyRead = await readOptionalJsonObject(
      c,
      AUTH_TWO_FACTOR_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const reauth = await assertRecentAuthOr403(c, sessionData, bodyRead.body);
    if (reauth) return reauth;

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    try {
      const enrolled = await enrollTotp(db, {
        userId: sessionData.userId,
        email: sessionData.email,
        dataEncryptionSecrets,
      });
      return c.json(enrolled, 200);
    } catch (err) {
      const mapped = mapTwoFactorMutationError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  auth.post("/2fa/totp/verify", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const bodyRead = await readOptionalJsonObject(
      c,
      AUTH_TWO_FACTOR_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const parsed = parseTotpCodeBody(bodyRead.body);
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }

    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets || !opts.backupCodeVerifierSecrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    try {
      const verified = await verifyTotpEnrollment(db, {
        userId: sessionData.userId,
        code: parsed.value.code,
        dataEncryptionSecrets,
        backupCodeVerifierSecrets: opts.backupCodeVerifierSecrets,
      });
      // 2FA is now on: every other outstanding session predates it and goes.
      await deleteOtherSessionsForUser(
        db,
        sessionData.userId,
        sessionData.sessionId,
      );
      return c.json(verified, 200);
    } catch (err) {
      const mapped = mapTwoFactorMutationError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  auth.post("/2fa/backup-codes/regenerate", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const bodyRead = await readOptionalJsonObject(
      c,
      AUTH_TWO_FACTOR_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const reauth = await assertRecentAuthOr403(c, sessionData, bodyRead.body);
    if (reauth) return reauth;

    if (!opts.backupCodeVerifierSecrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    try {
      const regenerated = await regenerateBackupCodes(db, {
        userId: sessionData.userId,
        backupCodeVerifierSecrets: opts.backupCodeVerifierSecrets,
      });
      // Regenerating backup codes is a "secure my account" action; the same
      // discipline applies.
      await deleteOtherSessionsForUser(
        db,
        sessionData.userId,
        sessionData.sessionId,
      );
      return c.json(regenerated, 200);
    } catch (err) {
      const mapped = mapTwoFactorMutationError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  auth.post("/2fa/disable", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const bodyRead = await readOptionalJsonObject(
      c,
      AUTH_TWO_FACTOR_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const reauth = await assertRecentAuthOr403(c, sessionData, bodyRead.body);
    if (reauth) return reauth;

    await disableTwoFactor(db, sessionData.userId);
    // Turning 2FA off changes how the account signs in — revoke the rest.
    await deleteOtherSessionsForUser(
      db,
      sessionData.userId,
      sessionData.sessionId,
    );
    return c.json({ ok: true }, 200);
  });

  auth.post("/sign-in/2fa", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: "sign-in-2fa",
      maxBytes: AUTH_SIGN_IN_2FA_MAX_BODY_BYTES,
      parse: parseSignIn2faBody,
      identity: (value) =>
        value.challenge.slice(0, AUTH_RATE_LIMIT_IDENTITY_MAX_CHARS),
    });
    if (!gated.ok) return gated.response;

    const challengeSecrets = opts.twoFactorChallengeSecrets;
    const backupSecrets = opts.backupCodeVerifierSecrets;
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    const sessionSecrets = opts.secrets;
    if (
      !challengeSecrets || !backupSecrets || !dataEncryptionSecrets ||
      !sessionSecrets
    ) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    const result = await verifyTwoFactorSignIn(db, {
      challenge: gated.value.challenge,
      ...("code" in gated.value ? { code: gated.value.code } : {}),
      ...("backupCode" in gated.value
        ? { backupCode: gated.value.backupCode }
        : {}),
      twoFactorChallengeSecrets: challengeSecrets,
      dataEncryptionSecrets,
      backupCodeVerifierSecrets: backupSecrets,
    });
    if (result.status !== "ok" || !result.userId) {
      return mapSignIn2faFailure(c, result);
    }

    const userRows = await db
      .select({ isDisabled: user.isDisabled })
      .from(user)
      .where(eq(user.id, result.userId))
      .limit(1);
    if (!userRows[0] || userRows[0].isDisabled) {
      return c.json({ ok: false, error: "Invalid credentials" }, 401);
    }

    const { token } = await createSession(db, result.userId, {
      ipAddress: resolveClientIp(c, opts.runtime) ?? undefined,
      userAgent: c.req.header("User-Agent") ?? undefined,
    });
    const cookieValue = await buildSignedCookie(token, sessionSecrets);
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

    const payload = await buildSessionResponse(db, opts.runtime, sessionData);

    return c.json(payload, 200, { "Set-Cookie": setCookieHeader });
  });
}
