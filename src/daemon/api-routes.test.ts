import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import { createLicense } from "../client/authn/license.ts";
import { getDatabaseUrl } from "../db-url.ts";
import { createDenoDb } from "../db.ts";
import { license, organization, server, serverkey } from "../lib/db/schema.ts";
import { registerDaemonApiRoutes } from "./api-routes.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  buildAuthPayload,
  buildCanonicalPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
} from "./authn/server-key.ts";

const dbUrl = getDatabaseUrl();
const encoder = new TextEncoder();

type KeyMaterial = {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
};

type RotationFixture = {
  db: ReturnType<typeof createDenoDb>;
  app: Hono<AppEnv>;
  serverId: string;
  keyId: string;
  currentKey: KeyMaterial;
};

type EnrollFixture = {
  db: ReturnType<typeof createDenoDb>;
  app: Hono<AppEnv>;
  organizationId: string;
  licenseId: string;
  licenseToken: string;
  serverId: string;
  keyId: string;
  key: KeyMaterial;
  machineId: string;
  hostname: string;
};

async function createTestSecrets() {
  return await deriveSecretsConfig({
    versioned: [{ version: 1, value: "daemon_api_routes_test_secret_value" }],
  }, "daemon-jwt-signing");
}

async function generateKeyMaterial(): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const fingerprint = await computePublicKeyFingerprint(publicJwk);
  return {
    privateKey: pair.privateKey,
    publicJwk,
    fingerprint,
  };
}

function decodeJwtPayload(token: string): {
  sub: string;
  sid: string;
  kid: string;
  iat: number;
  exp: number;
  aud: string;
  typ: string;
} {
  const [, encodedPayload] = token.split(".");
  const padded = encodedPayload + "=".repeat((4 - (encodedPayload.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(base64)) as {
    sub: string;
    sid: string;
    kid: string;
    iat: number;
    exp: number;
    aud: string;
    typ: string;
  };
}

async function signPayload(
  privateKey: CryptoKey,
  payload: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    encoder.encode(payload),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function createTestApp(db: ReturnType<typeof createDenoDb>): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  const secrets = await createTestSecrets();
  registerDaemonApiRoutes(app, { secrets });
  return app;
}

async function issueRotationChallenge(
  app: Hono<AppEnv>,
  serverId: string,
  keyId: string,
  daemonToken: string,
): Promise<{ challengeId: string; nonce: string }> {
  const response = await app.request("/api/daemon/v1/server-key/challenge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${daemonToken}`,
    },
    body: JSON.stringify({ serverId, keyId }),
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { challengeId: string; nonce: string };
  return body;
}

async function issueDaemonToken(serverId: string, keyId: string): Promise<string> {
  const secrets = await createTestSecrets();
  const issued = await issueDaemonJwt(
    { sub: serverId, sid: crypto.randomUUID(), kid: keyId },
    secrets,
  );
  return issued.token;
}

async function issueAuthChallenge(
  app: Hono<AppEnv>,
  serverId: string,
  keyId: string,
): Promise<{ challengeId: string; nonce: string }> {
  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, keyId }),
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { challengeId: string; nonce: string };
  return body;
}

async function withRotationFixture(
  fn: (fixture: RotationFixture) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping daemon API route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const app = await createTestApp(db);
  const currentKey = await generateKeyMaterial();
  const now = new Date().toISOString();

  const [serverRow] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      metadata: {},
      options: {},
    })
    .returning({ id: server.id });
  const serverId = serverRow!.id;

  const [keyRow] = await db
    .insert(serverkey)
    .values({
      createdAt: now,
      updatedAt: now,
      serverId,
      algorithm: "Ed25519",
      publicKey: currentKey.publicJwk,
      fingerprint: currentKey.fingerprint,
    })
    .returning({ id: serverkey.id });
  const keyId = keyRow!.id;

  try {
    await fn({ db, app, serverId, keyId, currentKey });
  } finally {
    await db.delete(server).where(eq(server.id, serverId));
  }
}

async function withEnrollFixture(
  fn: (fixture: EnrollFixture) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping daemon API route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const app = await createTestApp(db);
  const machineId = `machine-${crypto.randomUUID()}`;
  const hostname = `host-${crypto.randomUUID()}`;
  const [orgRow] = await db
    .insert(organization)
    .values({ displayName: "Daemon API Routes Test Org" })
    .returning({ id: organization.id });
  const organizationId = orgRow!.id;
  const { licenseId, licenseToken } = await createLicense(db, {
    organizationId,
    displayName: "Daemon API Routes Test License",
  });

  const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(challengeResponse.status, 200);
  const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };

  const key = await generateKeyMaterial();
  const payload = buildEnrollmentPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId,
    machineId,
    hostname,
    publicKeyFingerprint: key.fingerprint,
  });
  const signature = await signPayload(key.privateKey, payload);

  const enrollResponse = await app.request("/api/daemon/v1/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licenseId,
      licenseToken,
      machineId,
      hostname,
      publicJwk: key.publicJwk,
      challengeId: challenge.challengeId,
      signature,
    }),
  });
  assertEquals(enrollResponse.status, 200);
  const enrollBody = await enrollResponse.json() as { serverId: string; keyId: string };

  try {
    await fn({
      db,
      app,
      organizationId,
      licenseId,
      licenseToken,
      serverId: enrollBody.serverId,
      keyId: enrollBody.keyId,
      key,
      machineId,
      hostname,
    });
  } finally {
    await db.delete(server).where(eq(server.id, enrollBody.serverId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

Deno.test("POST /server-key/rotate rejects mismatched newFingerprint claim", async () => {
  await withRotationFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const nextKey = await generateKeyMaterial();
    const { challengeId } = await issueRotationChallenge(
      app,
      serverId,
      keyId,
      daemonToken,
    );

    const response = await app.request("/api/daemon/v1/server-key/rotate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId,
        newPublicJwk: nextKey.publicJwk,
        newFingerprint: "claimed-fingerprint-does-not-match",
        signature: "invalid-signature",
      }),
    });

    assertEquals(response.status, 400);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Fingerprint mismatch");
  });
});

Deno.test("POST /server-key/rotate rejects duplicate computed fingerprint", async () => {
  await withRotationFixture(async ({ app, serverId, keyId, currentKey }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const { challengeId, nonce } = await issueRotationChallenge(
      app,
      serverId,
      keyId,
      daemonToken,
    );
    const payload = buildCanonicalPayload({
      challengeId,
      nonce,
      serverId,
      fingerprint: currentKey.fingerprint,
    });
    const signature = await signPayload(currentKey.privateKey, payload);

    const response = await app.request("/api/daemon/v1/server-key/rotate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId,
        newPublicJwk: currentKey.publicJwk,
        signature,
      }),
    });

    assertEquals(response.status, 409);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Fingerprint already exists");
  });
});

Deno.test("POST /enroll rejects invalid license", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineId, hostname }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const key = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken: "invalid-token",
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /enroll rejects request without licenseToken", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineId, hostname }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const key = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(response.status, 401);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Invalid license");
  });
});

Deno.test("POST /enroll rejects invalid signature", async () => {
  await withEnrollFixture(async ({ app, licenseId, licenseToken, machineId, hostname }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const key = await generateKeyMaterial();

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken,
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature: "invalid-signature",
      }),
    });
    assertEquals(response.status, 403);
  });
});

Deno.test("POST /enroll stores public key only after proof-of-possession", async () => {
  await withEnrollFixture(async ({ db, keyId, key }) => {
    const rows = await db
      .select({
        id: serverkey.id,
        fingerprint: serverkey.fingerprint,
      })
      .from(serverkey)
      .where(eq(serverkey.id, keyId));
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.fingerprint, key.fingerprint);
  });
});

Deno.test("POST /auth/challenge rejects unknown keyId", async () => {
  await withEnrollFixture(async ({ app, serverId }) => {
    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId: crypto.randomUUID() }),
    });
    assertEquals(response.status, 404);
  });
});

Deno.test("POST /auth/session rejects expired or used challenge", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, key, machineId, hostname }) => {
    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId,
      hostname,
    });
    const signature = await signPayload(key.privateKey, payload);

    const first = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(first.status, 200);

    const second = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(second.status, 400);
  });
});

Deno.test("POST /auth/session rejects invalid signature", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, machineId, hostname }) => {
    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature: "invalid-signature",
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(response.status, 403);
  });
});

Deno.test("POST /auth/session returns a 15-minute JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, key, machineId, hostname }) => {
    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId,
      hostname,
    });
    const signature = await signPayload(key.privateKey, payload);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { token: string };
    assertExists(body.token);
    const jwtPayload = decodeJwtPayload(body.token);
    assertEquals(jwtPayload.exp - jwtPayload.iat, 900);
  });
});

Deno.test("Protected route rejects missing JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /heartbeat returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "daemon-host" }),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /heartbeat returns 200 with valid JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      },
      body: JSON.stringify({ hostname: "daemon-host" }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { ok: boolean };
    assertEquals(body, { ok: true });
  });
});

Deno.test("POST /heartbeat returns 401 with expired JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secrets = await createTestSecrets();
    const issued = await issueDaemonJwt(
      { sub: serverId, sid: crypto.randomUUID(), kid: keyId },
      secrets,
      Date.now() - (16 * 60 * 1000),
    );
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
      },
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /commands/lease returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /commands/lease returns 200 with valid JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
      },
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { commands: unknown[] };
    assertEquals(body, { commands: [] });
  });
});

Deno.test("Enrolled daemon can auto-refresh JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, key, machineId, hostname }) => {
    const secrets = await createTestSecrets();
    const nearExpiryIssued = await issueDaemonJwt(
      { sub: serverId, sid: crypto.randomUUID(), kid: keyId },
      secrets,
      Date.now() - ((15 * 60 * 1000) - 30_000),
    );
    const nearExpiryPayload = decodeJwtPayload(nearExpiryIssued.token);
    const nowBeforeRefresh = Math.floor(Date.now() / 1000);
    const nearExpiryRemaining = nearExpiryPayload.exp - nowBeforeRefresh;
    assert(
      nearExpiryRemaining <= 60,
      `expected near-expiry token to have <= 60s left, got ${nearExpiryRemaining}s`,
    );

    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId,
      hostname,
    });
    const signature = await signPayload(key.privateKey, payload);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { token: string };
    const refreshedPayload = decodeJwtPayload(body.token);
    const nowAfterRefresh = Math.floor(Date.now() / 1000);
    const refreshedRemaining = refreshedPayload.exp - nowAfterRefresh;
    assert(
      refreshedRemaining > 14 * 60,
      `expected refreshed token to have > 14 minutes left, got ${refreshedRemaining}s`,
    );
    assert(
      refreshedPayload.exp > nearExpiryPayload.exp + (10 * 60),
      "expected refresh token to meaningfully extend expiry over near-expiry token",
    );
    assert(
      refreshedPayload.iat >= nearExpiryPayload.iat,
      "expected refreshed token to be newly issued",
    );
  });
});

Deno.test("POST /server-key/challenge rejects missing JWT", async () => {
  await withRotationFixture(async ({ app, serverId, keyId }) => {
    const response = await app.request("/api/daemon/v1/server-key/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId }),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /server-key/challenge accepts valid JWT", async () => {
  await withRotationFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/server-key/challenge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      },
      body: JSON.stringify({ serverId, keyId }),
    });
    assertEquals(response.status, 200);
  });
});

Deno.test("POST /server-key/rotate rejects missing JWT", async () => {
  await withRotationFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/server-key/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /server-key/rotate accepts valid JWT", async () => {
  await withRotationFixture(async ({ app, serverId, keyId, currentKey }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const nextKey = await generateKeyMaterial();
    const { challengeId, nonce } = await issueRotationChallenge(
      app,
      serverId,
      keyId,
      daemonToken,
    );
    const payload = buildCanonicalPayload({
      challengeId,
      nonce,
      serverId,
      fingerprint: nextKey.fingerprint,
    });
    const signature = await signPayload(currentKey.privateKey, payload);

    const response = await app.request("/api/daemon/v1/server-key/rotate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId,
        newPublicJwk: nextKey.publicJwk,
        signature,
      }),
    });
    assertEquals(response.status, 200);
  });
});

Deno.test("Protected route rejects invalid JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-valid-jwt",
      },
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("Protected route rejects expired JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secrets = await createTestSecrets();
    const issued = await issueDaemonJwt(
      { sub: serverId, sid: crypto.randomUUID(), kid: keyId },
      secrets,
      Date.now() - (16 * 60 * 1000),
    );
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
      },
    });
    assertEquals(response.status, 401);
  });
});
