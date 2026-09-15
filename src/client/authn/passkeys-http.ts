import { getCookie } from "hono/cookie";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDb } from "../../db.ts";
import { readBoundedBodyText } from "../../lib/http/bounded-body.ts";
import { resolvePublicBaseUrl } from "../../lib/resolve-public-base-url.ts";
import { AUTH_RATE_LIMIT_IDENTITY_MAX_CHARS } from "./auth-rate-limit.ts";
import {
  AUTH_PASSKEY_LOGIN_OPTIONS_MAX_BODY_BYTES,
  AUTH_PASSKEY_LOGIN_VERIFY_MAX_BODY_BYTES,
  AUTH_PASSKEY_REGISTER_MAX_BODY_BYTES,
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
import {
  buildPasskeyLoginOptions,
  buildPasskeyRegistrationOptions,
  deletePasskey,
  InvalidPasskeyCeremonyError,
  listPasskeys,
  PasskeyExistsError,
  signWebauthnChallenge,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
  type PasskeyCredentialAssertion,
  type PasskeyCredentialAttestation,
} from "./passkeys.ts";
import { assertRecentAuthOr403 } from "./reauth.ts";
import {
  createSession,
  getSession,
  type SessionData,
} from "./session-store.ts";

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

function mapPasskeyMutationError(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof PasskeyExistsError) {
    return c.json({ ok: false, error: "passkey_exists" }, 409);
  }
  if (err instanceof InvalidPasskeyCeremonyError) {
    return c.json({ ok: false, error: "Invalid credential" }, 400);
  }
  return null;
}

type RegisterVerifyBody = {
  challenge: string;
  name: string;
  credential: PasskeyCredentialAttestation;
};

function parseRegisterVerifyBody(
  body: Record<string, unknown>,
): AuthBodyValidation<RegisterVerifyBody> {
  if (typeof body.challenge !== "string" || body.challenge.length === 0) {
    return { ok: false, error: "Invalid request" };
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    return { ok: false, error: "Invalid request" };
  }
  if (body.name.length > 255) {
    return { ok: false, error: "Invalid request" };
  }
  if (
    body.credential === null || typeof body.credential !== "object" ||
    Array.isArray(body.credential)
  ) {
    return { ok: false, error: "Invalid request" };
  }
  return {
    ok: true,
    value: {
      challenge: body.challenge,
      name: body.name,
      credential: body.credential as PasskeyCredentialAttestation,
    },
  };
}

type LoginVerifyBody = {
  challenge: string;
  credential: PasskeyCredentialAssertion;
};

function parseLoginVerifyBody(body: unknown): AuthBodyValidation<LoginVerifyBody> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request" };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.challenge !== "string" || record.challenge.length === 0) {
    return { ok: false, error: "Invalid request" };
  }
  if (
    record.credential === null || typeof record.credential !== "object" ||
    Array.isArray(record.credential)
  ) {
    return { ok: false, error: "Invalid request" };
  }
  return {
    ok: true,
    value: {
      challenge: record.challenge,
      credential: record.credential as PasskeyCredentialAssertion,
    },
  };
}

function parseEmptyObject(body: unknown): AuthBodyValidation<Record<string, never>> {
  if (body === null || body === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request" };
  }
  return { ok: true, value: {} };
}

async function resolveWebauthnOrigin(
  c: Context<AppEnv>,
  opts: AuthRouteOpts,
): Promise<{ rpId: string; origin: string }> {
  const publicBase = await resolvePublicBaseUrl(c, { baseUrl: opts.baseUrl });
  const publicUrl = new URL(publicBase);
  return { rpId: publicUrl.hostname, origin: publicUrl.origin };
}

export function registerPasskeyRoutes(
  auth: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  auth.post("/passkeys/register/options", async (c) => {
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
      AUTH_PASSKEY_REGISTER_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const reauth = await assertRecentAuthOr403(c, sessionData, bodyRead.body);
    if (reauth) return reauth;

    const secrets = opts.webauthnChallengeSecrets;
    if (!secrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    const { rpId } = await resolveWebauthnOrigin(c, opts);
    const signed = await signWebauthnChallenge(secrets, {
      userId: sessionData.userId,
    });
    const built = await buildPasskeyRegistrationOptions(db, {
      userId: sessionData.userId,
      email: sessionData.email,
      rpId,
      challenge: signed.challenge,
    });
    return c.json({ challenge: signed.envelope, options: built.options }, 200);
  });

  auth.post("/passkeys/register/verify", async (c) => {
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
      AUTH_PASSKEY_REGISTER_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const parsed = parseRegisterVerifyBody(bodyRead.body);
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }

    const secrets = opts.webauthnChallengeSecrets;
    if (!secrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    const { rpId, origin } = await resolveWebauthnOrigin(c, opts);
    try {
      const registered = await verifyPasskeyRegistration(db, {
        userId: sessionData.userId,
        challengeEnvelope: parsed.value.challenge,
        name: parsed.value.name,
        credential: parsed.value.credential,
        webauthnChallengeSecrets: secrets,
        expectedRpId: rpId,
        expectedOrigin: origin,
      });
      return c.json({ ok: true, id: registered.id }, 200);
    } catch (err) {
      const mapped = mapPasskeyMutationError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  auth.get("/passkeys", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    const sessionData = await readActiveSession(c, opts);
    if (!sessionData) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    const listed = await listPasskeys(db, sessionData.userId);
    return c.json(listed, 200);
  });

  auth.delete("/passkeys/:id", async (c) => {
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
      AUTH_PASSKEY_REGISTER_MAX_BODY_BYTES,
    );
    if (!bodyRead.ok) return bodyRead.response;
    const reauth = await assertRecentAuthOr403(c, sessionData, bodyRead.body);
    if (reauth) return reauth;

    const passkeyId = c.req.param("id");
    const deleted = await deletePasskey(db, sessionData.userId, passkeyId);
    if (!deleted) {
      return c.json({ ok: false, error: "Not found" }, 404);
    }
    return c.json({ ok: true }, 200);
  });

  auth.post("/passkeys/login/options", async (c) => {
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: "passkey-login",
      maxBytes: AUTH_PASSKEY_LOGIN_OPTIONS_MAX_BODY_BYTES,
      parse: parseEmptyObject,
      identity: () => "passkey-login",
    });
    if (!gated.ok) return gated.response;

    const secrets = opts.webauthnChallengeSecrets;
    if (!secrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    const { rpId } = await resolveWebauthnOrigin(c, opts);
    const built = await buildPasskeyLoginOptions(secrets, { rpId });
    return c.json(built, 200);
  });

  auth.post("/passkeys/login/verify", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: "passkey-login",
      maxBytes: AUTH_PASSKEY_LOGIN_VERIFY_MAX_BODY_BYTES,
      parse: parseLoginVerifyBody,
      identity: (value) =>
        value.challenge.slice(0, AUTH_RATE_LIMIT_IDENTITY_MAX_CHARS),
    });
    if (!gated.ok) return gated.response;

    const challengeSecrets = opts.webauthnChallengeSecrets;
    const sessionSecrets = opts.secrets;
    if (!challengeSecrets || !sessionSecrets) {
      return c.json({ ok: false, error: "Not configured" }, 503);
    }

    const { rpId, origin } = await resolveWebauthnOrigin(c, opts);
    const result = await verifyPasskeyLogin(db, {
      challengeEnvelope: gated.value.challenge,
      credential: gated.value.credential,
      webauthnChallengeSecrets: challengeSecrets,
      expectedRpId: rpId,
      expectedOrigin: origin,
    });
    if (result.status !== "ok") {
      return c.json({ ok: false, error: "Invalid credential" }, 400);
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
