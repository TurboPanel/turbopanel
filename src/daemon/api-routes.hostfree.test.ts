import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import { parseTestSecretsConfig } from "../test-fixtures/secrets.ts";
import { DAEMON_API_PREFIX } from "../surfaces.ts";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import { registerDaemonApiRoutes } from "./api-routes.ts";
import { createFailClosedRateLimiter } from "./rate-limit/contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function daemonApp(
  options: Parameters<typeof registerDaemonApiRoutes>[1] = {},
  db?: Db,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (db) {
    app.use("*", (c, next) => {
      c.set("db", db);
      return next();
    });
  }
  registerDaemonApiRoutes(app, options);
  return app;
}

test("daemon docs and JWKS stay host-free", async () => {
  const bare = daemonApp();
  const missingJwks = await bare.request(`${DAEMON_API_PREFIX}/jwks.json`);
  assertEquals(missingJwks.status, 503);

  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring });
  const jwks = await app.request(`${DAEMON_API_PREFIX}/jwks.json`);
  assertEquals(jwks.status, 200);
  const document = await jwks.json() as { keys: Array<{ kty: string }> };
  if (!Array.isArray(document.keys)) throw new TypeError("expected JWKS keys");
  assertEquals(document.keys.length > 0, true);

  const spec = await app.request(`${DAEMON_API_PREFIX}/openapi.json`);
  assertEquals(spec.status, 200);
  const reference = await app.request(`${DAEMON_API_PREFIX}/reference`);
  assertEquals(reference.status, 200);
  assertEquals((await reference.text()).includes("html"), true);
});

test("readiness, enroll, and session fail closed without a database", async () => {
  const app = daemonApp();
  assertEquals((await app.request(`${DAEMON_API_PREFIX}/readiness`)).status, 503);
  assertEquals(
    (await app.request(`${DAEMON_API_PREFIX}/enroll`, { method: "POST" })).status,
    503,
  );
  assertEquals(
    (await app.request(`${DAEMON_API_PREFIX}/auth/session`, { method: "POST" }))
      .status,
    503,
  );
});

test("anonymous challenge is unavailable without a signing store", async () => {
  const app = daemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(response.status, 503);
});

test("anonymous challenge is rate-limited before the store is consulted", async () => {
  const app = daemonApp({ restLimiter: createFailClosedRateLimiter() });
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(response.status, 429);
});

test("anonymous challenge issues a token from the stateless store", async () => {
  const challengeSigningSecrets = await deriveSecretsConfig(
    parseTestSecretsConfig(),
    "daemon-challenge-signing",
  );
  const app = daemonApp({ challengeSigningSecrets });
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { challengeId?: unknown };
  if (typeof body.challengeId !== "string") {
    throw new TypeError("expected challengeId");
  }
});

test("auth challenge with only serverId does not query the database", async () => {
  const app = daemonApp();
  const response = await app.request(`${DAEMON_API_PREFIX}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId: "00000000-0000-4000-8000-000000000001" }),
  });
  assertEquals(response.status, 400);
});

test("JWT-protected lease rejects a missing bearer and accepts a signed token", async () => {
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring });
  const unauthorized = await app.request(`${DAEMON_API_PREFIX}/commands/lease`, {
    method: "POST",
  });
  assertEquals(unauthorized.status, 401);

  const issued = await issueDaemonJwt(
    { sub: "00000000-0000-4000-8000-0000000000aa", kid: "key-1" },
    keyring,
  );
  const leased = await app.request(`${DAEMON_API_PREFIX}/commands/lease`, {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  assertEquals(leased.status, 200);
  const body = await leased.json() as { commands?: unknown };
  assertEquals(body.commands, []);
});

test("enroll and session field parsers stay host-free with a stub db", async () => {
  const db = {} as Db;
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig());
  const app = daemonApp({ secrets: keyring }, db);

  const missingLicense = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(missingLicense.status, 401);

  const missingFields = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      licenseId: "lic-1",
      licenseToken: "tok-1",
    }),
  });
  assertEquals(missingFields.status, 400);

  const invalidMachineKey = await app.request(`${DAEMON_API_PREFIX}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      licenseId: "lic-1",
      licenseToken: "tok-1",
      hostname: "host-1",
      challengeId: "chal-1",
      signature: "sig-1",
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
      machineKey: "not-a-machine-key",
    }),
  });
  assertEquals(invalidMachineKey.status, 400);

  const missingSession = await app.request(`${DAEMON_API_PREFIX}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(missingSession.status, 400);

  const invalidSessionKey = await app.request(
    `${DAEMON_API_PREFIX}/auth/session`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverId: "00000000-0000-4000-8000-0000000000aa",
        keyId: "key-1",
        challengeId: "chal-1",
        signature: "sig-1",
        hostname: "host-1",
        machineKey: "not-a-machine-key",
      }),
    },
  );
  assertEquals(invalidSessionKey.status, 400);
});
