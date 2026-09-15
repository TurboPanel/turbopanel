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
} from "./authn-hostfree-doubles.ts";
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from "./crypto.ts";
import { registerAuthRoutes } from "./http.ts";
import { hashPassword } from "./password.ts";
import { WEBAUTHN_CHALLENGE_PURPOSE } from "./passkeys.ts";
import { deriveSecretsConfig } from "./secrets.ts";
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

const AUTH = `${CLIENT_API_PREFIX}/auth`;
const PASSWORD = "Sup3r-secret!";
const ORIGIN = "https://panel.example.com";
const RP_ID = "panel.example.com";
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

async function generateEs256(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

async function coseFromPublic(publicKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return encodeCbor(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, base64urlDecode(jwk.x!)],
      [-3, base64urlDecode(jwk.y!)],
    ]),
  );
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
  origin = ORIGIN,
): string {
  return base64urlEncode(
    textEncoder.encode(JSON.stringify({ type, challenge, origin })),
  );
}

async function signAssertion(
  privateKey: CryptoKey,
  authData: Uint8Array,
  clientDataJSON: string,
): Promise<string> {
  const clientBytes = base64urlDecode(clientDataJSON);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientBytes as BufferSource),
  );
  const signed = concat(authData, hash);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    signed as BufferSource,
  );
  return base64urlEncode(new Uint8Array(signature));
}

async function buildPasskeyApp() {
  const config = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(config, "session-signing");
  const webauthnChallengeSecrets = await deriveSecretsConfig(
    config,
    WEBAUTHN_CHALLENGE_PURPOSE,
  );
  const state = createEmptyMockAuthState();
  const email = `passkey-${crypto.randomUUID()}@example.com`;
  const userId = crypto.randomUUID();
  seedMockCredentialUser(state, {
    id: userId,
    email,
    password: await hashPassword(PASSWORD),
    isEmailVerified: true,
  });
  const db = createMockAuthDb(state);
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 100, windowMs: 60_000 },
  });
  setSharedAuthRateLimiterForTests(limiter);

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

  const { token } = await createSession(db, userId, {});
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;

  return { app, db, state, userId, cookie };
}

async function registerOptions(
  app: Hono<AppEnv>,
  cookie: string,
): Promise<{ challenge: string; options: { challenge: string } }> {
  const res = await app.request(`${AUTH}/passkeys/register/options`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assertEquals(res.status, 200);
  return await readJsonBody<{
    challenge: string;
    options: { challenge: string };
  }>(res);
}

async function registerCredential(
  pair: CryptoKeyPair,
  optionsChallenge: string,
  counter: number,
): Promise<{
  credentialId: Uint8Array;
  credential: Record<string, unknown>;
}> {
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const coseKey = await coseFromPublic(pair.publicKey);
  const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV | AUTH_DATA_FLAG_BE |
    AUTH_DATA_FLAG_BS | AUTH_DATA_FLAG_AT;
  const authData = await buildAuthData({
    rpId: RP_ID,
    flags,
    counter,
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
  return {
    credentialId,
    credential: {
      id: base64urlEncode(credentialId),
      rawId: base64urlEncode(credentialId),
      type: "public-key",
      response: {
        clientDataJSON: clientData("webauthn.create", optionsChallenge),
        attestationObject: base64urlEncode(attestationObject),
        transports: ["internal"],
      },
    },
  };
}

test("unauthenticated passkey routes return 401", async () => {
  const ctx = await buildPasskeyApp();
  const list = await ctx.app.request(`${AUTH}/passkeys`);
  assertEquals(list.status, 401);
  const options = await ctx.app.request(`${AUTH}/passkeys/register/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assertEquals(options.status, 401);
});

test("register-options → register-verify happy path", async () => {
  const ctx = await buildPasskeyApp();
  const pair = await generateEs256();
  const options = await registerOptions(ctx.app, ctx.cookie);
  const built = await registerCredential(pair, options.options.challenge, 0);
  const verifyRes = await ctx.app.request(`${AUTH}/passkeys/register/verify`, {
    method: "POST",
    headers: { cookie: ctx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: options.challenge,
      name: "Laptop",
      credential: built.credential,
    }),
  });
  assertEquals(verifyRes.status, 200);
  const body = await readJsonBody<{ ok: boolean; id: string }>(verifyRes);
  assertEquals(body.ok, true);

  const listed = await ctx.app.request(`${AUTH}/passkeys`, {
    headers: { cookie: ctx.cookie },
  });
  assertEquals(listed.status, 200);
  const listBody = await readJsonBody<{
    passkeys: Array<{ name: string; deviceType: string; isBackedUp: boolean }>;
  }>(listed);
  assertEquals(listBody.passkeys.length, 1);
  assertEquals(listBody.passkeys[0]?.name, "Laptop");
  assertEquals(listBody.passkeys[0]?.deviceType, "multiDevice");
  assertEquals(listBody.passkeys[0]?.isBackedUp, true);
});

test("duplicate credential returns 409 passkey_exists", async () => {
  const ctx = await buildPasskeyApp();
  const pair = await generateEs256();
  const first = await registerOptions(ctx.app, ctx.cookie);
  const built = await registerCredential(pair, first.options.challenge, 0);
  const firstVerify = await ctx.app.request(
    `${AUTH}/passkeys/register/verify`,
    {
      method: "POST",
      headers: { cookie: ctx.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        challenge: first.challenge,
        name: "One",
        credential: built.credential,
      }),
    },
  );
  assertEquals(firstVerify.status, 200);

  const second = await registerOptions(ctx.app, ctx.cookie);
  const coseKey = await coseFromPublic(pair.publicKey);
  const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV | AUTH_DATA_FLAG_AT;
  const authData = await buildAuthData({
    rpId: RP_ID,
    flags,
    counter: 0,
    credentialId: built.credentialId,
    coseKey,
  });
  const attestationObject = encodeCbor(
    new Map<unknown, unknown>([
      ["fmt", "none"],
      ["authData", authData],
      ["attStmt", new Map()],
    ]),
  );
  const dup = await ctx.app.request(`${AUTH}/passkeys/register/verify`, {
    method: "POST",
    headers: { cookie: ctx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: second.challenge,
      name: "Two",
      credential: {
        id: base64urlEncode(built.credentialId),
        response: {
          clientDataJSON: clientData(
            "webauthn.create",
            second.options.challenge,
          ),
          attestationObject: base64urlEncode(attestationObject),
        },
      },
    }),
  });
  assertEquals(dup.status, 409);
  const body = await readJsonBody<{ error: string }>(dup);
  assertEquals(body.error, "passkey_exists");
});

test("login-options → login-verify issues a session and accepts counter 0→N", async () => {
  const ctx = await buildPasskeyApp();
  const pair = await generateEs256();
  const options = await registerOptions(ctx.app, ctx.cookie);
  const built = await registerCredential(pair, options.options.challenge, 0);
  const verifyRes = await ctx.app.request(`${AUTH}/passkeys/register/verify`, {
    method: "POST",
    headers: { cookie: ctx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: options.challenge,
      name: "Laptop",
      credential: built.credential,
    }),
  });
  assertEquals(verifyRes.status, 200);

  const loginOptionsRes = await ctx.app.request(
    `${AUTH}/passkeys/login/options`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  assertEquals(loginOptionsRes.status, 200);
  const loginOptions = await readJsonBody<{
    challenge: string;
    options: { challenge: string; rpId: string };
  }>(loginOptionsRes);
  assertEquals(loginOptions.options.rpId, RP_ID);

  const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV;
  const authData = await buildAuthData({
    rpId: RP_ID,
    flags,
    counter: 7,
  });
  const clientDataJSON = clientData(
    "webauthn.get",
    loginOptions.options.challenge,
  );
  const signature = await signAssertion(
    pair.privateKey,
    authData,
    clientDataJSON,
  );
  const loginVerify = await ctx.app.request(`${AUTH}/passkeys/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: loginOptions.challenge,
      credential: {
        id: base64urlEncode(built.credentialId),
        rawId: base64urlEncode(built.credentialId),
        response: {
          clientDataJSON,
          authenticatorData: base64urlEncode(authData),
          signature,
          userHandle: base64urlEncode(uuidToBytes(ctx.userId)),
        },
      },
    }),
  });
  assertEquals(loginVerify.status, 200);
  const sessionBody = await readJsonBody<{ ok: boolean; userId: string }>(
    loginVerify,
  );
  assertEquals(sessionBody.ok, true);
  assertEquals(sessionBody.userId, ctx.userId);
  assertEquals(
    loginVerify.headers.get("set-cookie")?.includes("turbopanel"),
    true,
  );
  assertEquals(ctx.state.passkeys[0]?.counter, 7);
});

test("zero-counter login consumes the challenge so the same assertion cannot replay", async () => {
  const ctx = await buildPasskeyApp();
  const pair = await generateEs256();
  const options = await registerOptions(ctx.app, ctx.cookie);
  const built = await registerCredential(pair, options.options.challenge, 0);
  const verifyRes = await ctx.app.request(`${AUTH}/passkeys/register/verify`, {
    method: "POST",
    headers: { cookie: ctx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: options.challenge,
      name: "Laptop",
      credential: built.credential,
    }),
  });
  assertEquals(verifyRes.status, 200);

  const loginOptionsRes = await ctx.app.request(
    `${AUTH}/passkeys/login/options`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  assertEquals(loginOptionsRes.status, 200);
  const loginOptions = await readJsonBody<{
    challenge: string;
    options: { challenge: string; rpId: string };
  }>(loginOptionsRes);

  const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV;
  const authData = await buildAuthData({
    rpId: RP_ID,
    flags,
    counter: 0,
  });
  const clientDataJSON = clientData(
    "webauthn.get",
    loginOptions.options.challenge,
  );
  const signature = await signAssertion(
    pair.privateKey,
    authData,
    clientDataJSON,
  );
  const loginBody = JSON.stringify({
    challenge: loginOptions.challenge,
    credential: {
      id: base64urlEncode(built.credentialId),
      rawId: base64urlEncode(built.credentialId),
      response: {
        clientDataJSON,
        authenticatorData: base64urlEncode(authData),
        signature,
        userHandle: base64urlEncode(uuidToBytes(ctx.userId)),
      },
    },
  });

  const first = await ctx.app.request(`${AUTH}/passkeys/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: loginBody,
  });
  assertEquals(first.status, 200);
  assertEquals(ctx.state.passkeys[0]?.counter, 0);

  const replay = await ctx.app.request(`${AUTH}/passkeys/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: loginBody,
  });
  assertEquals(replay.status, 400);
  const replayBody = await readJsonBody<{ error: string }>(replay);
  assertEquals(replayBody.error, "Invalid credential");
});

test("counter regression is rejected", async () => {
  const ctx = await buildPasskeyApp();
  const pair = await generateEs256();
  const options = await registerOptions(ctx.app, ctx.cookie);
  const built = await registerCredential(pair, options.options.challenge, 9);
  const verifyRes = await ctx.app.request(`${AUTH}/passkeys/register/verify`, {
    method: "POST",
    headers: { cookie: ctx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: options.challenge,
      name: "Laptop",
      credential: built.credential,
    }),
  });
  assertEquals(verifyRes.status, 200);

  const loginOptionsRes = await ctx.app.request(
    `${AUTH}/passkeys/login/options`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const loginOptions = await readJsonBody<{
    challenge: string;
    options: { challenge: string };
  }>(loginOptionsRes);
  const authData = await buildAuthData({
    rpId: RP_ID,
    flags: AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV,
    counter: 4,
  });
  const clientDataJSON = clientData(
    "webauthn.get",
    loginOptions.options.challenge,
  );
  const signature = await signAssertion(
    pair.privateKey,
    authData,
    clientDataJSON,
  );
  const loginVerify = await ctx.app.request(`${AUTH}/passkeys/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: loginOptions.challenge,
      credential: {
        id: base64urlEncode(built.credentialId),
        response: {
          clientDataJSON,
          authenticatorData: base64urlEncode(authData),
          signature,
          userHandle: base64urlEncode(uuidToBytes(ctx.userId)),
        },
      },
    }),
  });
  assertEquals(loginVerify.status, 400);
  const body = await readJsonBody<{ error: string }>(loginVerify);
  assertEquals(body.error, "Invalid credential");
});

test("mismatched origin is rejected", async () => {
  const ctx = await buildPasskeyApp();
  const pair = await generateEs256();
  const options = await registerOptions(ctx.app, ctx.cookie);
  const built = await registerCredential(pair, options.options.challenge, 0);
  await ctx.app.request(`${AUTH}/passkeys/register/verify`, {
    method: "POST",
    headers: { cookie: ctx.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challenge: options.challenge,
      name: "Laptop",
      credential: built.credential,
    }),
  });

  const loginOptionsRes = await ctx.app.request(
    `${AUTH}/passkeys/login/options`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const loginOptions = await readJsonBody<{
    challenge: string;
    options: { challenge: string };
  }>(loginOptionsRes);
  const authData = await buildAuthData({
    rpId: RP_ID,
    flags: AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV,
    counter: 1,
  });
  const clientDataJSON = clientData(
    "webauthn.get",
    loginOptions.options.challenge,
    "https://evil.example",
  );
  const signature = await signAssertion(
    pair.privateKey,
    authData,
    clientDataJSON,
  );
  const loginVerify = await ctx.app.request(`${AUTH}/passkeys/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: loginOptions.challenge,
      credential: {
        id: base64urlEncode(built.credentialId),
        response: {
          clientDataJSON,
          authenticatorData: base64urlEncode(authData),
          signature,
          userHandle: base64urlEncode(uuidToBytes(ctx.userId)),
        },
      },
    }),
  });
  assertEquals(loginVerify.status, 400);
});
