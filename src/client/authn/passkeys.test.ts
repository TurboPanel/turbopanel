import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  getPublicUrls,
  publicUrlEntryToInstallOrigin,
} from "../../features/install/public-urls.ts";
import type { AppEnv } from "../../app/app.ts";
import { getDatabaseUrl } from "../../db/url.ts";
import { createDenoDb, type Db, endDbConnection } from "../../db/connection.ts";
import {
  account,
  passkey,
  session,
  twoFactor,
  user,
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
import { verifyPasskeyLogin, WEBAUTHN_CHALLENGE_PURPOSE } from "./passkeys.ts";
import { deriveSecretsConfig } from "../../lib/secrets/secrets.ts";
import { createSession } from "./session-store.ts";
import {
  AUTH_DATA_FLAG_AT,
  AUTH_DATA_FLAG_BE,
  AUTH_DATA_FLAG_BS,
  AUTH_DATA_FLAG_UP,
  AUTH_DATA_FLAG_UV,
  base64urlDecode,
  base64urlEncode,
  uuidToBytes,
} from "./webauthn.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const dbUrl = getDatabaseUrl();
const ORIGIN = "https://panel.example.com";
const PASSWORD = "Sup3r-secret!";
const textEncoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
}

function encodeCbor(value: unknown): Uint8Array {
  if (typeof value === "number") {
    if (value >= 0) return encodeHead(0, value);
    return encodeHead(1, -1 - value);
  }
  if (value instanceof Uint8Array) {
    return concat(encodeHead(2, value.length), value);
  }
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    return concat(encodeHead(3, bytes.length), bytes);
  }
  if (value instanceof Map) {
    const pairs: Uint8Array[] = [];
    for (const [key, entry] of value.entries()) {
      pairs.push(encodeCbor(key), encodeCbor(entry));
    }
    return concat(encodeHead(5, value.size), ...pairs);
  }
  throw new TypeError("unsupported CBOR value");
}

function encodeUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function encodeUint16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

async function rpIdHash(rpId: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(rpId)),
  );
}

async function resolveTestWebauthnOrigin(
  db: Db,
): Promise<{ origin: string; rpId: string }> {
  const caddyPort = Deno.env.get("CADDY_PORT")?.trim() || "8443";
  const stored = (await getPublicUrls(db))[0];
  const fromStored = stored
    ? publicUrlEntryToInstallOrigin(stored, caddyPort)
    : null;
  const fromEnv = Deno.env.get("TURBOPANEL_PUBLIC_URLS")?.trim();
  const parsed = fromStored ?? (
    fromEnv
      ? publicUrlEntryToInstallOrigin(fromEnv.split(",")[0] ?? "", caddyPort)
      : null
  );
  const origin = parsed ?? ORIGIN;
  return { origin, rpId: new URL(origin).hostname };
}

async function buildAuthData(params: {
  rpId: string;
  flags: number;
  counter: number;
  credentialId?: Uint8Array;
  coseKey?: Uint8Array;
}): Promise<Uint8Array> {
  const hash = await rpIdHash(params.rpId);
  const parts = [
    hash,
    new Uint8Array([params.flags]),
    encodeUint32(params.counter),
  ];
  if (params.credentialId && params.coseKey) {
    parts.push(
      new Uint8Array(16),
      encodeUint16(params.credentialId.length),
      params.credentialId,
      params.coseKey,
    );
  }
  return concat(...parts);
}

function clientData(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): string {
  return base64urlEncode(
    textEncoder.encode(JSON.stringify({ type, challenge, origin })),
  );
}

test("Postgres register passkey then sign in with passkey alone while 2FA is enabled", async () => {
  if (!dbUrl) {
    console.warn("Skipping passkey DB test: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const webauthnChallengeSecrets = await deriveSecretsConfig(
    config,
    WEBAUTHN_CHALLENGE_PURPOSE,
  );
  const email = `passkey-${crypto.randomUUID()}@example.com`;
  const password = PASSWORD;
  const [inserted] = await db
    .insert(user)
    .values({
      email,
      isEmailVerified: true,
      is2FaEnabled: true,
      role: "user",
    })
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
    await db.insert(twoFactor).values({
      userId,
      secret: "unused",
      isVerified: true,
      backupCodes: "[]",
    });

    const { token } = await createSession(db, userId, {});
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      token,
      secrets,
    )}`;

    const app = new Hono<AppEnv>();
    app.use("*", (c, next) => {
      c.set("db", db);
      c.set("authRateLimiter", limiter);
      return next();
    });
    const client = new Hono<AppEnv>();
    registerAuthRoutes(client, {
      secrets,
      webauthnChallengeSecrets,
      runtime: "deno",
      signupEnvOverride: undefined,
      baseUrl: ORIGIN,
    });
    app.route(CLIENT_API_PREFIX, client);
    const auth = `${CLIENT_API_PREFIX}/auth`;
    const { origin, rpId } = await resolveTestWebauthnOrigin(db);

    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const coseKey = encodeCbor(
      new Map<unknown, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64urlDecode(jwk.x!)],
        [-3, base64urlDecode(jwk.y!)],
      ]),
    );
    const credentialId = crypto.getRandomValues(new Uint8Array(16));

    const optionsRes = await app.request(`${auth}/passkeys/register/options`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assertEquals(optionsRes.status, 200);
    const options = await optionsRes.json() as {
      challenge: string;
      options: { challenge: string };
    };

    const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV | AUTH_DATA_FLAG_BE |
      AUTH_DATA_FLAG_BS | AUTH_DATA_FLAG_AT;
    const authData = await buildAuthData({
      rpId,
      flags,
      counter: 0,
      credentialId,
      coseKey,
    });
    const attestationObject = encodeCbor(
      new Map<unknown, unknown>([
        ["fmt", "none"],
        ["authData", authData],
        ["attStmt", new Map()],
      ]),
    );
    const registerRes = await app.request(`${auth}/passkeys/register/verify`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        challenge: options.challenge,
        name: "YubiKey",
        credential: {
          id: base64urlEncode(credentialId),
          rawId: base64urlEncode(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: clientData(
              "webauthn.create",
              options.options.challenge,
              origin,
            ),
            attestationObject: base64urlEncode(attestationObject),
            transports: ["internal"],
          },
        },
      }),
    });
    assertEquals(
      registerRes.status,
      200,
      await registerRes.text(),
    );

    await app.request(`${auth}/sign-out`, {
      method: "POST",
      headers: { cookie },
    });

    const loginOptionsRes = await app.request(
      `${auth}/passkeys/login/options`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assertEquals(loginOptionsRes.status, 200);
    const loginOptions = await loginOptionsRes.json() as {
      challenge: string;
      options: { challenge: string };
    };

    const assertionAuthData = await buildAuthData({
      rpId,
      flags: AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV,
      counter: 3,
    });
    const clientDataJSON = clientData(
      "webauthn.get",
      loginOptions.options.challenge,
      origin,
    );
    const clientBytes = base64urlDecode(clientDataJSON);
    const clientHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", clientBytes as BufferSource),
    );
    const signed = concat(assertionAuthData, clientHash);
    const signature = base64urlEncode(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          signed as BufferSource,
        ),
      ),
    );

    const loginRes = await app.request(`${auth}/passkeys/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challenge: loginOptions.challenge,
        credential: {
          id: base64urlEncode(credentialId),
          response: {
            clientDataJSON,
            authenticatorData: base64urlEncode(assertionAuthData),
            signature,
            userHandle: base64urlEncode(uuidToBytes(userId)),
          },
        },
      }),
    });
    assertEquals(loginRes.status, 200);
    const sessionBody = await loginRes.json() as {
      ok: boolean;
      userId: string;
      is2faEnabled: boolean;
    };
    assertEquals(sessionBody.ok, true);
    assertEquals(sessionBody.userId, userId);
    assertEquals(sessionBody.is2faEnabled, true);
    assertEquals(
      loginRes.headers.get("set-cookie")?.includes("turbopanel"),
      true,
    );
  } finally {
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(passkey).where(eq(passkey.userId, userId));
    await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await db.delete(account).where(eq(account.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await endDbConnection(db);
  }
});

test("Postgres concurrent passkey assertions of the same incrementing login consume once", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping passkey concurrency test: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const webauthnChallengeSecrets = await deriveSecretsConfig(
    config,
    WEBAUTHN_CHALLENGE_PURPOSE,
  );
  const email = `passkey-cas-${crypto.randomUUID()}@example.com`;
  const password = PASSWORD;
  const [inserted] = await db
    .insert(user)
    .values({
      email,
      isEmailVerified: true,
      role: "user",
    })
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

    const { token } = await createSession(db, userId, {});
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      token,
      secrets,
    )}`;

    const app = new Hono<AppEnv>();
    app.use("*", (c, next) => {
      c.set("db", db);
      c.set("authRateLimiter", limiter);
      return next();
    });
    const client = new Hono<AppEnv>();
    registerAuthRoutes(client, {
      secrets,
      webauthnChallengeSecrets,
      runtime: "deno",
      signupEnvOverride: undefined,
      baseUrl: ORIGIN,
    });
    app.route(CLIENT_API_PREFIX, client);
    const auth = `${CLIENT_API_PREFIX}/auth`;
    const { origin, rpId } = await resolveTestWebauthnOrigin(db);

    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const coseKey = encodeCbor(
      new Map<unknown, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64urlDecode(jwk.x!)],
        [-3, base64urlDecode(jwk.y!)],
      ]),
    );
    const credentialId = crypto.getRandomValues(new Uint8Array(16));

    const optionsRes = await app.request(`${auth}/passkeys/register/options`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assertEquals(optionsRes.status, 200);
    const options = await optionsRes.json() as {
      challenge: string;
      options: { challenge: string };
    };

    const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV | AUTH_DATA_FLAG_BE |
      AUTH_DATA_FLAG_BS | AUTH_DATA_FLAG_AT;
    const authData = await buildAuthData({
      rpId,
      flags,
      counter: 0,
      credentialId,
      coseKey,
    });
    const attestationObject = encodeCbor(
      new Map<unknown, unknown>([
        ["fmt", "none"],
        ["authData", authData],
        ["attStmt", new Map()],
      ]),
    );
    const registerRes = await app.request(`${auth}/passkeys/register/verify`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        challenge: options.challenge,
        name: "YubiKey",
        credential: {
          id: base64urlEncode(credentialId),
          rawId: base64urlEncode(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: clientData(
              "webauthn.create",
              options.options.challenge,
              origin,
            ),
            attestationObject: base64urlEncode(attestationObject),
            transports: ["internal"],
          },
        },
      }),
    });
    assertEquals(registerRes.status, 200);

    const loginOptionsRes = await app.request(
      `${auth}/passkeys/login/options`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assertEquals(loginOptionsRes.status, 200);
    const loginOptions = await loginOptionsRes.json() as {
      challenge: string;
      options: { challenge: string };
    };

    const assertionAuthData = await buildAuthData({
      rpId,
      flags: AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV,
      counter: 5,
    });
    const clientDataJSON = clientData(
      "webauthn.get",
      loginOptions.options.challenge,
      origin,
    );
    const clientBytes = base64urlDecode(clientDataJSON);
    const clientHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", clientBytes as BufferSource),
    );
    const signed = concat(assertionAuthData, clientHash);
    const signature = base64urlEncode(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          signed as BufferSource,
        ),
      ),
    );
    const credential = {
      id: base64urlEncode(credentialId),
      response: {
        clientDataJSON,
        authenticatorData: base64urlEncode(assertionAuthData),
        signature,
        userHandle: base64urlEncode(uuidToBytes(userId)),
      },
    };
    const params = {
      challengeEnvelope: loginOptions.challenge,
      credential,
      webauthnChallengeSecrets,
      expectedRpId: rpId,
      expectedOrigin: origin,
    };

    const [first, second] = await Promise.all([
      verifyPasskeyLogin(db, params),
      verifyPasskeyLogin(db, params),
    ]);
    const statuses = [first.status, second.status].sort((a, b) =>
      a.localeCompare(b)
    );
    assertEquals(statuses, ["invalid", "ok"]);
  } finally {
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(passkey).where(eq(passkey.userId, userId));
    await db.delete(account).where(eq(account.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await endDbConnection(db);
  }
});
